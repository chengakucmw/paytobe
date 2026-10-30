import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AGENT_TOKEN_AUDIENCE } from "../../services/platform-api/src/application/agent-auth/service.js";
import { id, opaqueToken, tokenHash } from "../../services/platform-api/src/crypto.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "Paytobe-agent-credential-lifecycle-"));
process.env.VP_NO_AUTO_LISTEN = "1";
process.env.RELAY_STORE_DRIVER = "sqlite";
process.env.RELAY_STORE_PATH = path.join(directory, "platform.sqlite");
process.env.AUDIT_LOG_STDOUT = "false";

const { agentAuthService, agentCredentialService, server, store } = await import("../../services/platform-api/src/server.js");
let origin = "";
const sessions = new Map();
let agent;
const credentials = new Map();

test.before(async () => {
  seedTenant("merchant_lifecycle", "owner_lifecycle", false);
  seedTenant("merchant_other", "owner_other", true);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  agent = (await api("/v1/agents", "merchant_lifecycle", {
    method: "POST",
    payload: {
      name: "Credential Lifecycle Agent", runtime: "node", environment: "testnet",
      allowed_scopes: ["payment.requests.create"]
    }
  })).body.agent;
  agent = (await api(`/v1/agents/${agent.agent_id}`, "merchant_lifecycle", {
    method: "PATCH", payload: { status: "active", version: 1 }
  })).body.agent;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function seedTenant(merchantId, accountId, steppedUp) {
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
  const sessionId = id("msession");
  const sessionToken = opaqueToken("msession", 32);
  const csrfToken = opaqueToken("mcsrf", 32);
  store.db.prepare(`INSERT INTO merchant_sessions
    (session_id, merchant_id, account_id, token_hash, csrf_hash, status, expires_at, idle_expires_at,
     step_up_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`).run(
    sessionId, merchantId, accountId, tokenHash(sessionToken), tokenHash(csrfToken),
    new Date(Date.now() + 3_600_000).toISOString(), new Date(Date.now() + 1_800_000).toISOString(),
    steppedUp ? now : null, now, now
  );
  sessions.set(merchantId, { sessionId, cookie: `vp_merchant_session=${sessionToken}`, csrf: csrfToken });
}

async function api(pathname, merchantId, { method = "GET", payload } = {}) {
  const session = sessions.get(merchantId);
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(payload ? { "content-type": "application/json" } : {}),
      cookie: session.cookie,
      ...(method !== "GET" ? { origin, "x-csrf-token": session.csrf } : {})
    },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  });
  return { status: response.status, body: await response.json() };
}

async function registerCredential(kid, days = 30) {
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const registered = await api(`/v1/agents/${agent.agent_id}/credentials`, "merchant_lifecycle", {
    method: "POST",
    payload: {
      kid,
      alg: "Ed25519",
      public_key: keyPair.publicKey.export({ format: "jwk" }).x,
      not_before: new Date(Date.now() - 1_000).toISOString(),
      expires_at: new Date(Date.now() + days * 86_400_000).toISOString()
    }
  });
  assert.equal(registered.status, 201);
  const value = { keyPair, credential: registered.body.credential, challenge: registered.body.proof_challenge };
  credentials.set(kid, value);
  return value;
}

async function activateCredential(value) {
  const signature = crypto.sign(null, Buffer.from(value.challenge), value.keyPair.privateKey).toString("base64url");
  return api(`/v1/agents/${agent.agent_id}/credentials/${value.credential.credential_id}/activate`, "merchant_lifecycle", {
    method: "POST", payload: { challenge: value.challenge, signature }
  });
}

function assertion(value, jti = crypto.randomUUID()) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: value.credential.kid, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: agent.agent_id, sub: `${value.credential.kid}-client`, aud: AGENT_TOKEN_AUDIENCE,
    iat: now, exp: now + 300, jti, scope: ["payment.requests.create"]
  })).toString("base64url");
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${crypto.sign(null, Buffer.from(signingInput), value.keyPair.privateKey).toString("base64url")}`;
}

async function exchange(value) {
  const response = await fetch(`${origin}/v1/agent-auth/token`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_assertion: assertion(value) })
  });
  return { status: response.status, body: await response.json() };
}

test("rotation permits two usable credentials and bounds the old credential overlap to 24 hours", async () => {
  const first = await registerCredential("rotation-1");
  const firstActivation = await activateCredential(first);
  assert.equal(firstActivation.status, 200);
  first.credential = firstActivation.body.credential;

  const second = await registerCredential("rotation-2");
  const secondActivation = await activateCredential(second);
  assert.equal(secondActivation.status, 200);
  second.credential = secondActivation.body.credential;
  assert.equal(secondActivation.body.rotated_credential.credential_id, first.credential.credential_id);
  assert.equal(secondActivation.body.rotated_credential.status, "expiring");
  assert.ok(Date.parse(secondActivation.body.rotated_credential.expires_at) <= Date.now() + 24 * 60 * 60 * 1000 + 1_000);
  first.credential = secondActivation.body.rotated_credential;

  const third = await registerCredential("rotation-3");
  const blocked = await activateCredential(third);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, "credential_active_limit");
});

test("credential revocation requires step-up, is tenant-bound, and invalidates old tokens immediately", async () => {
  const second = credentials.get("rotation-2");
  const issued = await exchange(second);
  assert.equal(issued.status, 200);
  const noStepUp = await api(`/v1/agents/${agent.agent_id}/credentials/${second.credential.credential_id}`, "merchant_lifecycle", {
    method: "DELETE", payload: { version: second.credential.version }
  });
  assert.equal(noStepUp.status, 403);
  assert.equal(noStepUp.body.error.code, "step_up_required");

  store.db.prepare("UPDATE merchant_sessions SET step_up_at = ? WHERE session_id = ?")
    .run(new Date().toISOString(), sessions.get("merchant_lifecycle").sessionId);
  const crossTenant = await api(`/v1/agents/${agent.agent_id}/credentials/${second.credential.credential_id}`, "merchant_other", {
    method: "DELETE", payload: { version: second.credential.version }
  });
  assert.equal(crossTenant.status, 404);
  const revoked = await api(`/v1/agents/${agent.agent_id}/credentials/${second.credential.credential_id}`, "merchant_lifecycle", {
    method: "DELETE", payload: { version: second.credential.version }
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.credential.status, "revoked");
  assert.equal(revoked.body.credential.revocation_version, 1);
  assert.equal(agentAuthService.authenticate(issued.body.access_token, "after_revoke").status, 401);
  assert.equal(store.db.prepare("SELECT status FROM agent_access_tokens WHERE token_hash = ?").get(tokenHash(issued.body.access_token)).status, "revoked");

  const third = credentials.get("rotation-3");
  const activated = await activateCredential(third);
  assert.equal(activated.status, 200, "failed active-limit attempt must not consume proof challenge");
  third.credential = activated.body.credential;
});

test("natural expiry and reminder sweep advance state, revoke cached tokens, and emit sensitivity-minimized events", async () => {
  const third = credentials.get("rotation-3");
  const issued = await exchange(third);
  assert.equal(issued.status, 200);
  store.db.prepare("UPDATE agent_credentials SET expires_at = ? WHERE credential_id = ?")
    .run(new Date(Date.now() - 1_000).toISOString(), third.credential.credential_id);
  const expiredSweep = agentCredentialService.sweep();
  assert.equal(expiredSweep.expired, 1);
  const expired = store.db.prepare("SELECT status, revocation_version, version FROM agent_credentials WHERE credential_id = ?")
    .get(third.credential.credential_id);
  assert.equal(expired.status, "expired");
  assert.equal(expired.revocation_version, 1);
  assert.equal(agentAuthService.authenticate(issued.body.access_token, "after_expiry").status, 401);

  const fourth = await registerCredential("rotation-4", 30);
  const fourthActivation = await activateCredential(fourth);
  assert.equal(fourthActivation.status, 200);
  fourth.credential = fourthActivation.body.credential;
  store.db.prepare("UPDATE agent_credentials SET expires_at = ? WHERE credential_id = ?")
    .run(new Date(Date.now() + 6 * 86_400_000).toISOString(), fourth.credential.credential_id);
  const reminderSweep = agentCredentialService.sweep();
  assert.equal(reminderSweep.expiring, 1);
  assert.equal(reminderSweep.events.length, 1);
  assert.deepEqual(Object.keys(reminderSweep.events[0]).sort(), [
    "agent_id", "credential_id", "event_id", "expires_at", "merchant_id", "occurred_at", "type", "version"
  ]);
  const serializedEvent = JSON.stringify(reminderSweep.events[0]);
  assert.equal(serializedEvent.includes(fourth.credential.public_key), false);
  assert.equal(serializedEvent.includes("token"), false);
  assert.equal(store.db.prepare("SELECT status FROM agent_credentials WHERE credential_id = ?").get(fourth.credential.credential_id).status, "expiring");

  const cannotExtend = await api(`/v1/agents/${agent.agent_id}/credentials/${third.credential.credential_id}`, "merchant_lifecycle", {
    method: "PATCH", payload: { expires_at: new Date(Date.now() + 86_400_000).toISOString(), version: expired.version }
  });
  assert.equal(cannotExtend.status, 404);
});

test("durable lifecycle audit contains decisions and identifiers but no key, Challenge, signature, or Token material", () => {
  const audit = store.db.prepare(`SELECT action, details_json FROM audit_events
    WHERE merchant_id = 'merchant_lifecycle' AND resource_type = 'agent_credential' ORDER BY occurred_at`).all();
  for (const action of [
    "agent_credential.registered", "agent_credential.activated", "agent_credential.rotation_overlap_started",
    "agent_credential.revoked", "agent_credential.expired", "agent_credential.expiring"
  ]) assert.ok(audit.some((event) => event.action === action), action);
  const serialized = JSON.stringify(audit);
  for (const value of credentials.values()) {
    assert.equal(serialized.includes(value.credential.public_key), false);
    assert.equal(serialized.includes(value.challenge), false);
  }
  assert.equal(/PRIVATE KEY|proof_digest|token_hash|signature/i.test(serialized), false);
});
