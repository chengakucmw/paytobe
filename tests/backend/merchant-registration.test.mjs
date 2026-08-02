import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-merchant-registration-"));
process.env.VP_NO_AUTO_LISTEN = "1";
process.env.RELAY_STORE_DRIVER = "sqlite";
process.env.RELAY_STORE_PATH = path.join(directory, "platform.sqlite");
process.env.AUDIT_LOG_STDOUT = "false";

const { merchantAccountService, merchantEmail, server, store } = await import("../../services/platform-api/src/server.js");
let origin = "";

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

async function post(pathname, payload) {
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() };
}

test("registration normalizes email, returns a generic response, stores only a hash, and creates no session", async () => {
  const response = await post("/v1/merchant-accounts/registrations", { email: "  OWNER@Example.COM  " });
  assert.equal(response.status, 202);
  assert.deepEqual(response.body, {
    ok: true,
    accepted: true,
    message: "If the address can be registered, a verification email will be sent."
  });
  const delivery = merchantEmail.latest("owner@example.com");
  assert.match(delivery.token, /^mverify_[A-Za-z0-9_-]{43}$/);
  const verification = store.db.prepare("SELECT token_hash, status FROM merchant_email_verifications").get();
  assert.match(verification.token_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(verification.token_hash.includes(delivery.token), false);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM merchant_sessions").get().count, 0);
  assert.equal(JSON.stringify(store.info()).includes(delivery.token), false);
});

test("a newer token supersedes the old token and the active token verifies exactly once", async () => {
  const oldToken = merchantEmail.latest("owner@example.com").token;
  const generic = await post("/v1/merchant-accounts/registrations", { email: "owner@example.com" });
  assert.equal(generic.status, 202);
  const newToken = merchantEmail.latest("owner@example.com").token;
  assert.notEqual(newToken, oldToken);

  const superseded = await post("/v1/merchant-accounts/email-verifications", { token: oldToken });
  assert.equal(superseded.status, 400);
  assert.equal(superseded.body.error.code, "invalid_verification_token");

  const verified = await post("/v1/merchant-accounts/email-verifications", { token: newToken });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.account.email_normalized, "owner@example.com");
  assert.equal(verified.body.account.status, "active");

  const replay = await post("/v1/merchant-accounts/email-verifications", { token: newToken });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error.code, "invalid_verification_token");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM merchant_accounts WHERE email_normalized = 'owner@example.com'").get().count, 1);
});

test("existing verified accounts and unknown addresses have the same public registration response", async () => {
  const existing = await post("/v1/merchant-accounts/registrations", { email: "owner@example.com" });
  const unknown = await post("/v1/merchant-accounts/registrations", { email: "new@example.com" });
  assert.equal(existing.status, 202);
  assert.equal(unknown.status, 202);
  assert.deepEqual(existing.body, unknown.body);
});

test("wrong and expired tokens fail with one error and failed verification does not create an account session", async () => {
  const wrong = await post("/v1/merchant-accounts/email-verifications", { token: "mverify_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, "invalid_verification_token");

  const delivery = merchantEmail.latest("new@example.com");
  store.db.prepare("UPDATE merchant_email_verifications SET expires_at = ? WHERE token_hash = ?")
    .run("2020-01-01T00:00:00.000Z", store.db.prepare("SELECT token_hash FROM merchant_email_verifications WHERE status = 'active' ORDER BY created_at DESC LIMIT 1").get().token_hash);
  const expired = await post("/v1/merchant-accounts/email-verifications", { token: delivery.token });
  assert.equal(expired.status, 400);
  assert.equal(expired.body.error.code, "invalid_verification_token");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM merchant_sessions").get().count, 0);
});

test("the application service is exposed only for test inspection and never returns the plaintext token", async () => {
  const result = await merchantAccountService.register({ email: "service@example.com" });
  assert.deepEqual(result, { accepted: true });
  assert.equal(Object.hasOwn(result, "token"), false);
});
