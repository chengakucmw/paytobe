import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SENSITIVE_MERCHANT_OPERATIONS } from "../../services/platform-api/src/application/merchant-sessions/service.js";
import { createTenantScope } from "../../services/platform-api/src/ports/tenant-repository.js";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-merchant-step-up-"));
process.env.VP_NO_AUTO_LISTEN = "1";
process.env.RELAY_STORE_DRIVER = "sqlite";
process.env.RELAY_STORE_PATH = path.join(directory, "platform.sqlite");
process.env.AUDIT_LOG_STDOUT = "false";

const { merchantEmail, merchantService, merchantSessionService, server, store } = await import("../../services/platform-api/src/server.js");
let origin = "";
let accountId = "";
let merchantId = "";
let cookie = "";
let csrf = "";
let sessionId = "";

test.before(async () => {
  merchantEmail.clear();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function request(pathname, { method = "GET", payload, useSession = false } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(payload ? { "content-type": "application/json" } : {}),
      ...(useSession ? { cookie, "x-csrf-token": csrf, origin } : {})
    },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  });
  return { status: response.status, body: await response.json(), setCookie: response.headers.get("set-cookie") || "" };
}

test("a fresh verified-email sign-in is immediately stepped up without a second email", async () => {
  await request("/v1/merchant-accounts/registrations", { method: "POST", payload: { email: "stepup@example.com" } });
  const verified = await request("/v1/merchant-accounts/email-verifications", {
    method: "POST", payload: { token: merchantEmail.latest("stepup@example.com").token }
  });
  accountId = verified.body.account.account_id;
  const merchant = await request("/v1/merchants", {
    method: "POST", payload: { session_grant: verified.body.session_grant, display_name: "Step-up Test" }
  });
  merchantId = merchant.body.merchant.merchant_id;
  const login = await request("/v1/merchant-sessions", {
    method: "POST", payload: { session_grant: merchant.body.session_grant, merchant_id: merchantId }
  });
  cookie = login.setCookie.split(";")[0];
  csrf = login.body.csrf_token;
  sessionId = login.body.session.session_id;
  assert.match(login.body.session.step_up_at, /^2026-/);
  assert.equal(login.body.session.step_up_fresh, true);
  assert.equal(store.db.prepare("SELECT step_up_at FROM merchant_sessions WHERE session_id = ?").get(sessionId).step_up_at,
    login.body.session.step_up_at);
  assert.equal(merchantEmail.latestStepUp("stepup@example.com"), null);
});

test("CSRF alone only starts a generic challenge and wrong/different-session proof cannot refresh step_up_at", async () => {
  store.db.prepare("UPDATE merchant_sessions SET step_up_at = NULL WHERE session_id = ?").run(sessionId);
  const started = await request("/v1/merchant-sessions/current/step-up", { method: "POST", payload: {}, useSession: true });
  assert.equal(started.status, 202);
  assert.deepEqual(started.body, { ok: true, accepted: true });
  assert.equal(Object.hasOwn(started.body, "challenge_token"), false);
  const delivery = merchantEmail.latestStepUp("stepup@example.com");
  assert.match(delivery.token, /^mstep_[A-Za-z0-9_-]{43}$/);
  const stored = store.db.prepare("SELECT challenge_hash FROM merchant_step_up_challenges WHERE session_id = ? AND status = 'active'").get(sessionId);
  assert.match(stored.challenge_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(stored.challenge_hash.includes(delivery.token), false);
  assert.equal(store.db.prepare("SELECT step_up_at FROM merchant_sessions WHERE session_id = ?").get(sessionId).step_up_at, null);

  const wrong = await request("/v1/merchant-sessions/current/step-up", {
    method: "POST", payload: { challenge_token: "mstep_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, useSession: true
  });
  assert.equal(wrong.status, 401);
  assert.equal(store.db.prepare("SELECT step_up_at FROM merchant_sessions WHERE session_id = ?").get(sessionId).step_up_at, null);
  const other = merchantSessionService.completeStepUp({ session_id: "different_session" }, { challenge_token: delivery.token });
  assert.equal(other.ok, false);
  assert.equal(store.db.prepare("SELECT step_up_at FROM merchant_sessions WHERE session_id = ?").get(sessionId).step_up_at, null);
});

test("a bound challenge succeeds once and a recent proof unlocks a sensitive merchant transition", async () => {
  const token = merchantEmail.latestStepUp("stepup@example.com").token;
  const completed = await request("/v1/merchant-sessions/current/step-up", {
    method: "POST", payload: { challenge_token: token }, useSession: true
  });
  assert.equal(completed.status, 200);
  assert.match(completed.body.step_up_at, /^2026-/);
  const replay = await request("/v1/merchant-sessions/current/step-up", {
    method: "POST", payload: { challenge_token: token }, useSession: true
  });
  assert.equal(replay.status, 401);

  const scope = createTenantScope(Object.freeze({ merchant_id: merchantId, actor_id: accountId, request_id: "stepup" }));
  const activated = merchantService.activateVerified(scope, merchantId, 1);
  assert.equal(activated.ok, true);
  const suspended = await request(`/v1/merchants/${merchantId}`, {
    method: "PATCH", payload: { status: "suspended", version: 2 }, useSession: true
  });
  assert.equal(suspended.status, 200);
  assert.equal(suspended.body.merchant.status, "suspended");
});

test("proof older than ten minutes is rejected and failed challenges never refresh it", async () => {
  const scope = createTenantScope(Object.freeze({ merchant_id: merchantId, actor_id: accountId, request_id: "stepup-old" }));
  const active = merchantService.update(scope, merchantId, { status: "active", version: 3 });
  assert.equal(active.ok, true);
  store.db.prepare("UPDATE merchant_sessions SET step_up_at = ? WHERE session_id = ?")
    .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), sessionId);
  const rejected = await request(`/v1/merchants/${merchantId}`, {
    method: "PATCH", payload: { status: "suspended", version: 4 }, useSession: true
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.error.code, "step_up_required");
  const old = store.db.prepare("SELECT step_up_at FROM merchant_sessions WHERE session_id = ?").get(sessionId).step_up_at;
  assert.equal(Date.now() - Date.parse(old) >= 10 * 60 * 1000, true);
  const current = await request("/v1/merchant-sessions/current", { useSession: true });
  assert.equal(current.status, 200);
  assert.equal(current.body.session.step_up_fresh, false);
});

test("step-up challenges have an independent per-session rate limit", async () => {
  const statuses = [];
  for (let index = 0; index < 5; index += 1) {
    statuses.push((await request("/v1/merchant-sessions/current/step-up", { method: "POST", payload: {}, useSession: true })).status);
  }
  assert.ok(statuses.includes(429));
  assert.equal(statuses.at(-1), 429);
});

test("sensitive operation inventory and current routes use the shared step-up enforcer", () => {
  assert.deepEqual(SENSITIVE_MERCHANT_OPERATIONS, [
    "member.role_promote", "domain.replace", "credential.revoke", "webhook.secret_rotate", "merchant.suspend", "recipient.facts_change"
  ]);
  const merchants = fs.readFileSync(path.join(codeRoot, "services/platform-api/src/routes/merchants.js"), "utf8");
  const memberships = fs.readFileSync(path.join(codeRoot, "services/platform-api/src/routes/merchant-memberships.js"), "utf8");
  assert.match(merchants, /requireMerchantStepUp\(req, "merchant\.suspend"\)/);
  assert.match(memberships, /requireMerchantStepUp\(req, "member\.role_promote"\)/);
});
