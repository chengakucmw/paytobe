import assert from "node:assert/strict";
import test from "node:test";
import { createApiClient, OFFICIAL_API_ORIGIN, ReauthenticationRequiredError, SessionExpiredError } from "../public/modules/api-client.js";
import { initialAuthState, reduceAuthState } from "../public/modules/auth-state.js";
import { createStepUpChannel } from "../public/modules/step-up-channel.js";
import { renderPortal, routeFromPath } from "../public/modules/view.js";
import { createPortalServer } from "../server.mjs";

const session = Object.freeze({
  session_id: "session_safe",
  merchant_id: "merchant_safe",
  account_id: "account_safe",
  role: "owner",
  expires_at: "2026-08-02T10:00:00.000Z",
  idle_expires_at: "2026-08-02T09:30:00.000Z"
});

test("unauthenticated and spoofed public routes render no protected workspace", () => {
  const state = reduceAuthState(initialAuthState(), { type: "CHECK_FAILED" });
  for (const pathname of ["/", "/members", "/webhooks", "/overview?role=owner&authenticated=true"]) {
    const html = renderPortal(state, routeFromPath(pathname));
    assert.match(html, /id="sign-in-form"/);
    assert.doesNotMatch(html, /data-authenticated="true"/);
    assert.doesNotMatch(html, /merchant_safe|account_safe|Session context/);
    assert.match(html, /id="registration-form"/);
  }
});

test("only a valid server session transitions to authenticated protected DOM", () => {
  const invalid = reduceAuthState(initialAuthState(), { type: "AUTHENTICATED", session: { merchant_id: "spoofed" } });
  assert.equal(invalid.status, "error");
  assert.doesNotMatch(renderPortal(invalid), /data-authenticated/);

  const authenticated = reduceAuthState(initialAuthState(), { type: "AUTHENTICATED", session, csrfAvailable: true });
  const html = renderPortal(authenticated, "members");
  assert.match(html, /data-authenticated="true"/);
  assert.match(html, /merchant_safe/);
  assert.match(html, /aria-current="page">Members/);
  assert.match(html, /id="start-session-step-up"/);
  assert.match(html, />Required</);
  assert.doesNotMatch(html, /id="complete-session-step-up-form"/);
  assert.doesNotMatch(html, /session_safe|account_safe/);
});

test("step-up email pages never send users back through sign-in", () => {
  const token = `mstep_${"Z".repeat(43)}`;
  const connecting = renderPortal(initialAuthState(), "overview", { status: "step_up_connecting", token });
  assert.match(connecting, /Completing security verification/);
  assert.match(connecting, /will not be signed out/);
  assert.doesNotMatch(connecting, /Return to sign in|id="registration-form"|mstep_/);

  const manual = renderPortal(initialAuthState(), "overview", {
    status: "step_up_manual", token, message: "Use the original tab."
  });
  assert.match(manual, /Finish in your original Portal tab/);
  assert.match(manual, /mstep_/);
  assert.match(manual, /Do not sign in again/i);
  assert.doesNotMatch(manual, /Return to sign in|id="registration-form"/);

  const complete = renderPortal(initialAuthState(), "overview", { status: "step_up_verified" });
  assert.match(complete, /Security verification complete/);
  assert.match(complete, /session stayed signed in/);
  assert.match(complete, />Verified</);
  assert.doesNotMatch(complete, /Return to sign in|id="registration-form"/);
});

test("verified step-up state is explicit and removes unfinished controls", () => {
  let state = reduceAuthState(initialAuthState(), { type: "AUTHENTICATED", session, csrfAvailable: true });
  state = reduceAuthState(state, { type: "STEP_UP_COMPLETED", stepUpAt: "2026-08-03T12:00:00.000Z" });
  const html = renderPortal(state, "overview", null, {
    status: "verified", message: "Security verification complete. Your current session stayed signed in."
  });
  assert.equal(state.session.stepUpAt, "2026-08-03T12:00:00.000Z");
  assert.match(html, />Verified</);
  assert.match(html, /Sensitive actions are unlocked/);
  assert.match(html, /current session stayed signed in/);
  assert.doesNotMatch(html, /id="start-session-step-up"|id="complete-session-step-up-form"/);
});

test("fresh email sign-in arrives already verified and never asks for a second email", () => {
  const signedInSession = { ...session, step_up_at: "2026-08-03T12:00:00.000Z", step_up_fresh: true };
  const state = reduceAuthState(initialAuthState(), {
    type: "AUTHENTICATED", session: signedInSession, csrfAvailable: true
  });
  const html = renderPortal(state, "overview");
  assert.equal(state.session.stepUpAt, signedInSession.step_up_at);
  assert.equal(state.session.stepUpFresh, true);
  assert.match(html, />Verified</);
  assert.match(html, /Sensitive actions are unlocked/);
  assert.doesNotMatch(html, /Send security email|id="complete-session-step-up-form"/);
});

test("same-origin step-up tabs exchange only an ephemeral challenge and completion result", async () => {
  const hub = new Map();
  class FakeBroadcastChannel {
    constructor(name) {
      this.name = name;
      this.listeners = [];
      if (!hub.has(name)) hub.set(name, new Set());
      hub.get(name).add(this);
    }
    addEventListener(type, listener) {
      if (type === "message") this.listeners.push(listener);
    }
    postMessage(data) {
      for (const peer of hub.get(this.name)) {
        if (peer !== this) queueMicrotask(() => peer.listeners.forEach((listener) => listener({ data })));
      }
    }
    close() {
      hub.get(this.name)?.delete(this);
    }
  }

  let receivedToken = "";
  let completed = false;
  const portal = createStepUpChannel({
    BroadcastChannelImpl: FakeBroadcastChannel,
    onChallenge(token) { receivedToken = token; }
  });
  const emailTab = createStepUpChannel({
    BroadcastChannelImpl: FakeBroadcastChannel,
    onCompleted() { completed = true; }
  });
  const token = `mstep_${"Q".repeat(43)}`;
  assert.equal(emailTab.publishChallenge(token), true);
  await new Promise(queueMicrotask);
  assert.equal(receivedToken, token);
  portal.publishCompleted();
  await new Promise(queueMicrotask);
  assert.equal(completed, true);
  assert.equal(emailTab.publishChallenge("not-a-token"), false);
  portal.close();
  emailTab.close();
});

test("session security verification uses CSRF and exposes no destructive action", async () => {
  const calls = [];
  const responses = [
    jsonResponse(201, { ok: true, session, csrf_token: `mcsrf_${"G".repeat(43)}` }),
    jsonResponse(202, { ok: true, accepted: true }),
    jsonResponse(200, { ok: true, step_up_at: "2026-08-03T11:00:00.000Z" })
  ];
  const client = createApiClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    return responses.shift();
  }});
  await client.signIn({ merchantId: "merchant_safe", sessionGrant: `msgrant_${"H".repeat(43)}` });
  await client.startStepUp();
  await client.completeStepUp(`mstep_${"I".repeat(43)}`);
  assert.deepEqual(calls.slice(1).map((call) => call.url), [
    `${OFFICIAL_API_ORIGIN}/v1/merchant-sessions/current/step-up`,
    `${OFFICIAL_API_ORIGIN}/v1/merchant-sessions/current/step-up`
  ]);
  assert.match(calls[1].options.headers["x-csrf-token"], /^mcsrf_/);
  assert.match(calls[2].options.headers["x-csrf-token"], /^mcsrf_/);
  assert.deepEqual(calls[1].body, {});
  assert.match(calls[2].body.challenge_token, /^mstep_/);
});

test("API client uses server cookies and keeps CSRF proof in ephemeral closure state", async () => {
  const calls = [];
  const client = createApiClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(201, { ok: true, session, csrf_token: `mcsrf_${"A".repeat(43)}` });
  }});
  const result = await client.signIn({ merchantId: "merchant_safe", sessionGrant: `msgrant_${"B".repeat(43)}` });
  assert.equal(result.csrfAvailable, true);
  assert.equal(client.hasCsrfProof(), true);
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[0].url, `${OFFICIAL_API_ORIGIN}/v1/merchant-sessions`);
  assert.equal(Object.hasOwn(calls[0].options.headers, "authorization"), false);
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-csrf-token"), false);

  await client.signOut();
  assert.match(calls[1].options.headers["x-csrf-token"], /^mcsrf_/);
  assert.equal(client.hasCsrfProof(), false);
});

test("email verification onboarding uses the canonical API and rotates into a merchant session", async () => {
  const calls = [];
  const responses = [
    jsonResponse(200, { ok: true, account: { account_id: "maccount_1" }, session_grant: `msgrant_${"A".repeat(43)}` }),
    jsonResponse(201, { ok: true, merchant: { merchant_id: "merchant_safe" }, session_grant: `msgrant_${"B".repeat(43)}` }),
    jsonResponse(201, { ok: true, session, csrf_token: `mcsrf_${"C".repeat(43)}` })
  ];
  const client = createApiClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return responses.shift();
  }});
  const verified = await client.verifyEmail(`mverify_${"D".repeat(43)}`);
  const merchant = await client.createMerchant({ sessionGrant: verified.sessionGrant, displayName: "Safe Shop" });
  const signedIn = await client.signIn({ merchantId: merchant.merchant.merchant_id, sessionGrant: merchant.sessionGrant });
  assert.equal(signedIn.csrfAvailable, true);
  assert.deepEqual(calls.map((call) => call.url), [
    `${OFFICIAL_API_ORIGIN}/v1/merchant-accounts/email-verifications`,
    `${OFFICIAL_API_ORIGIN}/v1/merchants`,
    `${OFFICIAL_API_ORIGIN}/v1/merchant-sessions`
  ]);
});

test("returning email links expose eligible merchant choices without persisting the grant", async () => {
  const client = createApiClient({ fetchImpl: async () => jsonResponse(200, {
    ok: true,
    account: { account_id: "maccount_1" },
    merchants: [{ merchant_id: "merchant_safe", display_name: "Safe Shop", role: "owner" }],
    session_grant: `msgrant_${"E".repeat(43)}`
  }) });
  const result = await client.verifyEmail(`mverify_${"F".repeat(43)}`);
  assert.deepEqual(result.merchants, [{ merchant_id: "merchant_safe", display_name: "Safe Shop", role: "owner" }]);
  assert.match(result.sessionGrant, /^msgrant_/);
  assert.equal(Object.hasOwn(globalThis, "sessionGrant"), false);
});

test("missing CSRF and expired sessions fail closed to reauthentication", async () => {
  const missingProof = createApiClient({ fetchImpl: async () => jsonResponse(200, { ok: true }) });
  await assert.rejects(() => missingProof.signOut(), ReauthenticationRequiredError);

  const expired = createApiClient({ fetchImpl: async () => jsonResponse(401, {
    ok: false, error: { code: "merchant_session_unauthenticated", message: "expired" }
  }) });
  await assert.rejects(() => expired.restoreSession(), SessionExpiredError);

  const csrfFailed = createApiClient({ fetchImpl: async () => jsonResponse(403, {
    ok: false, error: { code: "csrf_failed", message: "missing" }
  }) });
  await assert.rejects(() => csrfFailed.restoreSession(), ReauthenticationRequiredError);
});

test("restored read-only sessions render an explicit email reauthentication path", () => {
  const restored = reduceAuthState(initialAuthState(), { type: "AUTHENTICATED", session, csrfAvailable: false });
  const html = renderPortal(restored, "overview");
  assert.match(html, /id="reauthenticate-button"/);
  assert.match(html, /Reauthenticate by email/);
  assert.match(html, /id="start-session-step-up"[^>]*disabled/);
});

test("static server applies a protected shell CSP and does not expose API authority", async (context) => {
  const server = createPortalServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/members?authenticated=true`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /connect-src 'self' https:\/\/api\.velarumai\.com/);
  assert.match(await response.text(), /id="app"/);
  const post = await fetch(origin, { method: "POST" });
  assert.equal(post.status, 405);
});

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
