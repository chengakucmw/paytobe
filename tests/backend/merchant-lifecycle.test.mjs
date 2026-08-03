import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { merchantCapabilityAllowed } from "../../services/platform-api/src/application/merchants/service.js";
import { createTenantScope } from "../../services/platform-api/src/ports/tenant-repository.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-merchant-lifecycle-"));
process.env.VP_NO_AUTO_LISTEN = "1";
process.env.RELAY_STORE_DRIVER = "sqlite";
process.env.RELAY_STORE_PATH = path.join(directory, "platform.sqlite");
process.env.AUDIT_LOG_STDOUT = "false";

const { merchantEmail, merchantService, server, store } = await import("../../services/platform-api/src/server.js");
let origin = "";
let merchantId = "";
let accountId = "";
let cookie = "";
let csrf = "";

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

async function request(pathname, { method = "GET", payload, cookieHeader = "", csrfToken = "" } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(payload ? { "content-type": "application/json" } : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
      ...(method !== "GET" ? { origin } : {})
    },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  });
  return { status: response.status, body: await response.json(), setCookie: response.headers.get("set-cookie") || "" };
}

async function verifiedGrant() {
  await request("/v1/merchant-accounts/registrations", { method: "POST", payload: { email: "owner@example.com" } });
  const token = merchantEmail.latest("owner@example.com").token;
  const verified = await request("/v1/merchant-accounts/email-verifications", { method: "POST", payload: { token } });
  accountId = verified.body.account.account_id;
  return verified.body.session_grant;
}

function scopeFor(id = merchantId) {
  return createTenantScope(Object.freeze({ merchant_id: id, actor_id: accountId, request_id: "lifecycle_test" }));
}

test("onboarding grant creates a pending merchant and the verified account as the only Owner", async () => {
  const grant = await verifiedGrant();
  const forbiddenOwner = await request("/v1/merchants", {
    method: "POST",
    payload: { session_grant: grant, display_name: "Acme", owner_account_id: "other" }
  });
  assert.equal(forbiddenOwner.status, 400);

  const directActive = await request("/v1/merchants", {
    method: "POST",
    payload: { session_grant: grant, display_name: "Acme", status: "active" }
  });
  assert.equal(directActive.status, 400);

  const created = await request("/v1/merchants", {
    method: "POST",
    payload: { session_grant: grant, display_name: "Acme Test", legal_name: "Acme Test LLC" }
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.merchant.status, "pending_verification");
  assert.equal(created.body.membership.account_id, accountId);
  assert.equal(created.body.membership.role, "owner");
  assert.equal(created.body.membership.status, "active");
  merchantId = created.body.merchant.merchant_id;
  assert.match(merchantId, /^merchant_[0-9a-f]{32}$/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM merchant_memberships WHERE merchant_id = ? AND role = 'owner'").get(merchantId).count, 1);

  const replay = await request("/v1/merchants", { method: "POST", payload: { session_grant: grant, display_name: "Replay" } });
  assert.equal(replay.status, 401);

  const login = await request("/v1/merchant-sessions", {
    method: "POST",
    payload: { session_grant: created.body.session_grant, merchant_id: merchantId }
  });
  assert.equal(login.status, 201);
  assert.equal(login.body.session.step_up_fresh, true);
  assert.equal(merchantEmail.latestStepUp("owner@example.com"), null);
  cookie = login.setCookie.split(";")[0];
  csrf = login.body.csrf_token;
});

test("tenant reads are isolated and ordinary updates cannot bypass verification", async () => {
  const read = await request(`/v1/merchants/${merchantId}`, { cookieHeader: cookie });
  assert.equal(read.status, 200);
  assert.equal(read.body.merchant.merchant_id, merchantId);

  const bypass = await request(`/v1/merchants/${merchantId}`, {
    method: "PATCH", cookieHeader: cookie, csrfToken: csrf, payload: { status: "active", version: 1 }
  });
  assert.equal(bypass.status, 409);
  assert.equal(bypass.body.error.code, "verification_required");

  const updated = await request(`/v1/merchants/${merchantId}`, {
    method: "PATCH", cookieHeader: cookie, csrfToken: csrf, payload: { display_name: "Acme Updated", version: 1 }
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.merchant.version, 2);

  const stale = await request(`/v1/merchants/${merchantId}`, {
    method: "PATCH", cookieHeader: cookie, csrfToken: csrf, payload: { display_name: "Stale", version: 1 }
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "concurrency_conflict");
  assert.equal(merchantService.get(scopeFor("merchant_other"), merchantId), null);
});

test("verified activation, suspension propagation, reactivation, and terminal close obey the state machine", async () => {
  const activated = merchantService.activateVerified(scopeFor(), merchantId, 2);
  assert.equal(activated.ok, true);
  assert.equal(activated.merchant.status, "active");
  assert.equal(merchantCapabilityAllowed(activated.merchant, "agent_token"), true);

  store.db.prepare("UPDATE merchant_sessions SET step_up_at = ? WHERE status = 'active'")
    .run(new Date(Date.now() - 11 * 60 * 1000).toISOString());
  const withoutStepUp = await request(`/v1/merchants/${merchantId}`, {
    method: "PATCH", cookieHeader: cookie, csrfToken: csrf, payload: { status: "suspended", version: 3 }
  });
  assert.equal(withoutStepUp.status, 403);
  assert.equal(withoutStepUp.body.error.code, "step_up_required");

  const suspended = merchantService.update(scopeFor(), merchantId, { status: "suspended", version: 3 }, { allowSensitive: true });
  assert.equal(suspended.ok, true);
  for (const capability of ["agent_token", "connect_claim", "payment_request", "webhook_delivery"]) {
    assert.equal(merchantCapabilityAllowed(suspended.merchant, capability), false, capability);
  }
  assert.equal((await request("/v1/merchant-sessions/current", { cookieHeader: cookie })).status, 401, "suspension invalidates session use immediately");

  const activeAgain = merchantService.update(scopeFor(), merchantId, { status: "active", version: 4 });
  assert.equal(activeAgain.merchant.status, "active");
  const closed = merchantService.update(scopeFor(), merchantId, { status: "closed", version: 5 }, { allowSensitive: true });
  assert.equal(closed.merchant.status, "closed");
  const revive = merchantService.update(scopeFor(), merchantId, { status: "active", version: 6 }, { allowSensitive: true });
  assert.equal(revive.ok, false);
  assert.equal(revive.code, "merchant_closed");
});
