import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { opaqueToken, tokenHash } from "../../services/platform-api/src/crypto.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-merchant-session-"));
process.env.VP_NO_AUTO_LISTEN = "1";
process.env.RELAY_STORE_DRIVER = "sqlite";
process.env.RELAY_STORE_PATH = path.join(directory, "platform.sqlite");
process.env.AUDIT_LOG_STDOUT = "false";

const { merchantEmail, server, store } = await import("../../services/platform-api/src/server.js");
let origin = "";
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

async function request(pathname, { method = "GET", payload, cookieHeader = "", csrfToken = "", requestOrigin = "" } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(payload ? { "content-type": "application/json" } : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
      ...(requestOrigin ? { origin: requestOrigin } : {})
    },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  });
  return { status: response.status, body: await response.json(), setCookie: response.headers.get("set-cookie") || "" };
}

function insertGrant() {
  const token = opaqueToken("msgrant", 32);
  const now = new Date();
  store.db.prepare(`INSERT INTO merchant_session_grants
    (grant_id, account_id, grant_hash, status, created_at, expires_at)
    VALUES (?, ?, ?, 'active', ?, ?)`)
    .run(`grant_${Date.now()}_${Math.random()}`, accountId, tokenHash(token), now.toISOString(), new Date(now.getTime() + 300_000).toISOString());
  return token;
}

async function login(grant, extra = {}) {
  const response = await request("/v1/merchant-sessions", {
    method: "POST",
    payload: { session_grant: grant, merchant_id: "merchant_session_test", ...extra }
  });
  const sessionCookie = response.setCookie.split(";")[0];
  return { ...response, cookie: sessionCookie, csrf: response.body.csrf_token };
}

test("verified email proof creates a new secure session with independent CSRF proof", async () => {
  await request("/v1/merchant-accounts/registrations", { method: "POST", payload: { email: "session@example.com" } });
  const verificationToken = merchantEmail.latest("session@example.com").token;
  const verified = await request("/v1/merchant-accounts/email-verifications", { method: "POST", payload: { token: verificationToken } });
  accountId = verified.body.account.account_id;
  store.db.prepare(`INSERT INTO merchants
    (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
    VALUES ('merchant_session_test', 'Session Test', 'active', 'verified', 1, ?, ?)`).run(new Date().toISOString(), new Date().toISOString());
  store.db.prepare(`INSERT INTO merchant_memberships
    (membership_id, merchant_id, account_id, role, status, version, created_at, updated_at)
    VALUES ('membership_session_test', 'merchant_session_test', ?, 'owner', 'active', 1, ?, ?)`)
    .run(accountId, new Date().toISOString(), new Date().toISOString());

  const created = await login(verified.body.session_grant);
  assert.equal(created.status, 201);
  assert.match(created.setCookie, /^vp_merchant_session=msession_/);
  assert.match(created.setCookie, /HttpOnly/i);
  assert.match(created.setCookie, /Secure/i);
  assert.match(created.setCookie, /SameSite=Strict/i);
  assert.match(created.body.csrf_token, /^mcsrf_[A-Za-z0-9_-]{43}$/);
  assert.equal(Object.hasOwn(created.body, "session_token"), false);
  cookie = created.cookie;
  csrf = created.csrf;

  const current = await request("/v1/merchant-sessions/current", { cookieHeader: cookie });
  assert.equal(current.status, 200);
  assert.equal(current.body.auth_context.merchant_id, "merchant_session_test");
  assert.equal(current.body.auth_context.role, "owner");
  const row = store.db.prepare("SELECT token_hash, csrf_hash, expires_at, idle_expires_at FROM merchant_sessions WHERE status = 'active'").get();
  assert.match(row.token_hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(row.csrf_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(row).includes(created.body.csrf_token), false);
  assert.equal(Date.parse(row.expires_at) - Date.now() > 11 * 60 * 60 * 1000, true);
  assert.equal(Date.parse(row.idle_expires_at) - Date.now() <= 31 * 60 * 1000, true);
});

test("login consumes a grant once, ignores fixation input, and rotates the previous session", async () => {
  const grant = insertGrant();
  const desired = "msession_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const rotated = await login(grant, { session_token: desired, session_id: "attacker-fixed" });
  assert.equal(rotated.status, 201);
  assert.equal(rotated.cookie.includes(desired), false);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM merchant_sessions WHERE status = 'active'").get().count, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM merchant_sessions WHERE status = 'revoked'").get().count >= 1, true);
  const replay = await login(grant);
  assert.equal(replay.status, 401);
  cookie = rotated.cookie;
  csrf = rotated.csrf;
});

test("state changes require both a same-origin request and the server-generated CSRF proof", async () => {
  const missing = await request("/v1/merchant-sessions/current", { method: "DELETE", cookieHeader: cookie, requestOrigin: origin });
  assert.equal(missing.status, 403);
  assert.equal(missing.body.error.code, "csrf_failed");

  const crossOrigin = await request("/v1/merchant-sessions/current", {
    method: "DELETE", cookieHeader: cookie, csrfToken: csrf, requestOrigin: "https://evil.example"
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.body.error.code, "origin_forbidden");

  const revoked = await request("/v1/merchant-sessions/current", {
    method: "DELETE", cookieHeader: cookie, csrfToken: csrf, requestOrigin: origin
  });
  assert.equal(revoked.status, 200);
  assert.match(revoked.setCookie, /vp_merchant_session=/);
  const after = await request("/v1/merchant-sessions/current", { cookieHeader: cookie });
  assert.equal(after.status, 401);
});

test("absolute expiry, idle expiry, account suspension, membership removal, and merchant suspension fail closed", async () => {
  async function activeSession() {
    const result = await login(insertGrant());
    assert.equal(result.status, 201);
    return result.cookie;
  }

  let currentCookie = await activeSession();
  store.db.prepare("UPDATE merchant_sessions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE status = 'active'").run();
  assert.equal((await request("/v1/merchant-sessions/current", { cookieHeader: currentCookie })).status, 401);

  currentCookie = await activeSession();
  store.db.prepare("UPDATE merchant_sessions SET idle_expires_at = '2020-01-01T00:00:00.000Z' WHERE status = 'active'").run();
  assert.equal((await request("/v1/merchant-sessions/current", { cookieHeader: currentCookie })).status, 401);

  currentCookie = await activeSession();
  store.db.prepare("UPDATE merchant_accounts SET status = 'suspended' WHERE account_id = ?").run(accountId);
  assert.equal((await request("/v1/merchant-sessions/current", { cookieHeader: currentCookie })).status, 401);
  store.db.prepare("UPDATE merchant_accounts SET status = 'active' WHERE account_id = ?").run(accountId);

  currentCookie = await activeSession();
  store.db.prepare("UPDATE merchant_memberships SET status = 'removed' WHERE membership_id = 'membership_session_test'").run();
  assert.equal((await request("/v1/merchant-sessions/current", { cookieHeader: currentCookie })).status, 401);
  store.db.prepare("UPDATE merchant_memberships SET status = 'active' WHERE membership_id = 'membership_session_test'").run();

  currentCookie = await activeSession();
  store.db.prepare("UPDATE merchants SET status = 'suspended' WHERE merchant_id = 'merchant_session_test'").run();
  assert.equal((await request("/v1/merchant-sessions/current", { cookieHeader: currentCookie })).status, 401);
});
