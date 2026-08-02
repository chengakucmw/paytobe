import assert from "node:assert/strict";
import test from "node:test";
import { createApiClient, ReauthenticationRequiredError, SessionExpiredError } from "../public/modules/api-client.js";
import { initialAuthState, reduceAuthState } from "../public/modules/auth-state.js";
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
  assert.doesNotMatch(html, /session_safe|account_safe/);
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
  assert.equal(Object.hasOwn(calls[0].options.headers, "authorization"), false);
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-csrf-token"), false);

  await client.signOut();
  assert.match(calls[1].options.headers["x-csrf-token"], /^mcsrf_/);
  assert.equal(client.hasCsrfProof(), false);
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
  assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.match(await response.text(), /id="app"/);
  const post = await fetch(origin, { method: "POST" });
  assert.equal(post.status, 405);
});

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
