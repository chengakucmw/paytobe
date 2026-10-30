import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AGENT_TOKEN_AUDIENCE } from "../../services/platform-api/src/application/agent-auth/service.js";
import { id, opaqueToken, tokenHash } from "../../services/platform-api/src/crypto.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "Paytobe-agent-assertion-"));
process.env.VP_NO_AUTO_LISTEN = "1";
process.env.RELAY_STORE_DRIVER = "sqlite";
process.env.RELAY_STORE_PATH = path.join(directory, "platform.sqlite");
process.env.AUDIT_LOG_STDOUT = "false";

const { agentAuthService, server, store } = await import("../../services/platform-api/src/server.js");
let origin = "";
let session;
let agent;
let credential;
let keyPair;

test.before(async () => {
  session = seedTenant("merchant_assertion", "owner_assertion");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  await provisionIdentity();
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function seedTenant(merchantId, accountId) {
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO merchants
    (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
    VALUES (?, ?, 'active', 'verified', 1, ?, ?)`).run(merchantId, merchantId, now, now);
  store.db.prepare(`INSERT INTO merchant_accounts
    (account_id, email_normalized, status, version, created_at, updated_at)
    VALUES (?, ?, 'active', 1, ?, ?)`).run(accountId, `${accountId}@example.invalid`, now, now);
  store.db.prepare(`INSERT INTO merchant_memberships
    (membership_id, merchant_id, account_id, role, status, version, created_at, updated_at)
    VALUES (?, ?, ?, 'owner', 'active', 1, ?, ?)`).run(id("membership"), merchantId, accountId, now, now);
  const sessionToken = opaqueToken("msession", 32);
  const csrfToken = opaqueToken("mcsrf", 32);
  store.db.prepare(`INSERT INTO merchant_sessions
    (session_id, merchant_id, account_id, token_hash, csrf_hash, status, expires_at, idle_expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`).run(
    id("msession"), merchantId, accountId, tokenHash(sessionToken), tokenHash(csrfToken),
    new Date(Date.now() + 3_600_000).toISOString(), new Date(Date.now() + 1_800_000).toISOString(), now, now
  );
  return { cookie: `vp_merchant_session=${sessionToken}`, csrf: csrfToken };
}

async function api(pathname, { method = "GET", payload, bearer = "" } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(payload ? { "content-type": "application/json" } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie: session.cookie }),
      ...(method !== "GET" && !bearer ? { origin, "x-csrf-token": session.csrf } : {})
    },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function provisionIdentity() {
  const created = await api("/v1/agents", {
    method: "POST",
    payload: {
      name: "Assertion Agent", runtime: "node", environment: "testnet",
      allowed_scopes: ["payment.requests.create", "payment.requests.read"]
    }
  });
  agent = created.body.agent;
  keyPair = crypto.generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ format: "jwk" }).x;
  const registered = await api(`/v1/agents/${agent.agent_id}/credentials`, {
    method: "POST",
    payload: {
      kid: "assertion-key", alg: "Ed25519", public_key: publicKey,
      not_before: new Date(Date.now() - 1_000).toISOString(),
      expires_at: new Date(Date.now() + 86_400_000).toISOString()
    }
  });
  credential = registered.body.credential;
  const signature = crypto.sign(null, Buffer.from(registered.body.proof_challenge), keyPair.privateKey).toString("base64url");
  const activated = await api(`/v1/agents/${agent.agent_id}/credentials/${credential.credential_id}/activate`, {
    method: "POST", payload: { challenge: registered.body.proof_challenge, signature }
  });
  assert.equal(activated.status, 200);
  const activeAgent = await api(`/v1/agents/${agent.agent_id}`, {
    method: "PATCH", payload: { status: "active", version: 1 }
  });
  agent = activeAgent.body.agent;
}

function assertion(overrides = {}, headerOverrides = {}, signingKey = keyPair.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", kid: credential.kid, typ: "JWT", ...headerOverrides };
  const payload = {
    iss: agent.agent_id,
    sub: "checkout-client",
    aud: AGENT_TOKEN_AUDIENCE,
    iat: now,
    exp: now + 300,
    jti: crypto.randomUUID(),
    scope: ["payment.requests.create"],
    ...overrides
  };
  const protectedPart = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${protectedPart}.${payloadPart}`;
  const signature = crypto.sign(null, Buffer.from(signingInput), signingKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

async function exchange(clientAssertion) {
  return api("/v1/agent-auth/token", { method: "POST", payload: { client_assertion: clientAssertion } });
}

test("a valid EdDSA assertion returns a hash-only opaque token bound to verified identity and approved scope", async () => {
  const response = await exchange(assertion());
  assert.equal(response.status, 200);
  assert.equal(response.body.token_type, "Bearer");
  assert.match(response.body.access_token, /^vat_[A-Za-z0-9_-]{43}$/);
  assert.ok(response.body.expires_in > 0 && response.body.expires_in <= 300);
  assert.deepEqual(response.body.scope, ["payment.requests.create"]);
  assert.equal(response.body.auth_context.merchant_id, "merchant_assertion");
  assert.equal(response.body.auth_context.agent_id, agent.agent_id);
  assert.equal(response.body.auth_context.client_id, "checkout-client");
  assert.equal(response.body.auth_context.credential_id, credential.credential_id);
  assert.equal(response.body.auth_context.auth_method, "agent_assertion");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const stored = store.db.prepare("SELECT token_hash, scopes_json FROM agent_access_tokens WHERE token_id = ?")
    .get(store.db.prepare("SELECT token_id FROM agent_access_tokens ORDER BY issued_at DESC LIMIT 1").get().token_id);
  assert.match(stored.token_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(stored.token_hash.includes(response.body.access_token), false);

  const authenticated = agentAuthService.authenticate(response.body.access_token, "request_auth", ["payment.requests.create"]);
  assert.equal(authenticated.ok, true);
  assert.equal(Object.isFrozen(authenticated.auth_context), true);
  assert.equal(authenticated.auth_context.merchant_id, "merchant_assertion");
  assert.equal(agentAuthService.authenticate(response.body.access_token, "request_auth", ["payment.requests.read"]).code, "scope_denied");
});

test("audience, time window, kid, algorithm, signature, self-declared identity, and scope escalation fail generically", async () => {
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    assertion({ aud: "https://attacker.invalid/token" }),
    assertion({ iat: now + 120, exp: now + 240 }),
    assertion({ exp: now + 301 }),
    assertion({}, { kid: "unknown-key" }),
    assertion({}, { alg: "none" }),
    assertion({}, {}, crypto.generateKeyPairSync("ed25519").privateKey),
    assertion({ scope: ["payment.requests.create", "payment.approve"] }),
    assertion({ merchant_id: "merchant_attacker" })
  ];
  for (const value of cases) {
    const response = await exchange(value);
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "unauthenticated");
    assert.equal(response.body.error.message, "Agent assertion or access token is invalid");
  }
});

test("suspended merchant, Agent, or credential state blocks new exchange and existing token validation", async () => {
  const issued = await exchange(assertion());
  assert.equal(issued.status, 200);
  store.db.prepare("UPDATE merchants SET status = 'suspended' WHERE merchant_id = 'merchant_assertion'").run();
  assert.equal((await exchange(assertion())).status, 401);
  assert.equal(agentAuthService.authenticate(issued.body.access_token, "request_suspended").status, 401);
  store.db.prepare("UPDATE merchants SET status = 'active' WHERE merchant_id = 'merchant_assertion'").run();

  store.db.prepare("UPDATE agents SET status = 'suspended', token_revocation_version = token_revocation_version + 1 WHERE agent_id = ?").run(agent.agent_id);
  assert.equal((await exchange(assertion())).status, 401);
  assert.equal(agentAuthService.authenticate(issued.body.access_token, "request_agent_suspended").status, 401);
  store.db.prepare("UPDATE agents SET status = 'active' WHERE agent_id = ?").run(agent.agent_id);

  store.db.prepare("UPDATE agent_credentials SET status = 'revoked', revocation_version = revocation_version + 1 WHERE credential_id = ?")
    .run(credential.credential_id);
  assert.equal((await exchange(assertion())).status, 401);
  assert.equal(agentAuthService.authenticate(issued.body.access_token, "request_credential_revoked").status, 401);
});
