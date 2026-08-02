import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { id, normalizeEd25519PublicKey, opaqueToken, tokenHash } from "../../services/platform-api/src/crypto.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-agent-pop-"));
process.env.VP_NO_AUTO_LISTEN = "1";
process.env.RELAY_STORE_DRIVER = "sqlite";
process.env.RELAY_STORE_PATH = path.join(directory, "platform.sqlite");
process.env.AUDIT_LOG_STDOUT = "false";

const { server, store } = await import("../../services/platform-api/src/server.js");
let origin = "";
const sessions = new Map();

test.before(async () => {
  seedTenant("merchant_a", "owner_a");
  seedTenant("merchant_b", "owner_b");
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
  sessions.set(merchantId, { cookie: `vp_merchant_session=${sessionToken}`, csrf: csrfToken });
}

async function request(pathname, merchantId, { method = "GET", payload } = {}) {
  const session = sessions.get(merchantId);
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      cookie: session.cookie,
      ...(payload ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { origin, "x-csrf-token": session.csrf } : {})
    },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  });
  return { status: response.status, body: await response.json() };
}

async function createAgent(merchantId, name) {
  const response = await request("/v1/agents", merchantId, {
    method: "POST",
    payload: { name, runtime: "node", environment: "testnet", allowed_scopes: ["payment.requests.create"] }
  });
  assert.equal(response.status, 201);
  return response.body.agent;
}

function credentialInput(publicKey, kid = "primary-2026") {
  return {
    kid,
    alg: "Ed25519",
    public_key: publicKey,
    not_before: new Date(Date.now() - 1_000).toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString()
  };
}

test("native Ed25519 registration stores a normalized public key and hash-only one-time challenge", async () => {
  const agent = await createAgent("merchant_a", "Signing Agent");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const registered = await request(`/v1/agents/${agent.agent_id}/credentials`, "merchant_a", {
    method: "POST", payload: credentialInput(pem)
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.credential.status, "pending_proof");
  assert.equal(registered.body.credential.alg, "Ed25519");
  assert.equal(registered.body.credential.public_key, normalizeEd25519PublicKey(pem));
  assert.match(registered.body.proof_challenge, /^acpop_[A-Za-z0-9_-]{43}$/);
  const stored = store.db.prepare("SELECT challenge_hash, proof_digest FROM agent_credential_proof_challenges WHERE credential_id = ?")
    .get(registered.body.credential.credential_id);
  assert.match(stored.challenge_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(stored.challenge_hash.includes(registered.body.proof_challenge), false);
  assert.equal(stored.proof_digest, null);
  sessions.set("pop_case", { agent, credential: registered.body.credential, challenge: registered.body.proof_challenge, privateKey });

  const duplicate = await request(`/v1/agents/${agent.agent_id}/credentials`, "merchant_a", {
    method: "POST", payload: credentialInput(pem)
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, "credential_kid_conflict");
});

test("wrong algorithms, malformed keys, private material, and mnemonic-shaped input fail closed without echo", async () => {
  const agent = sessions.get("pop_case").agent;
  const cases = [
    { ...credentialInput("bad", "bad-alg"), alg: "EdDSA" },
    credentialInput("not-a-key", "bad-key"),
    { ...credentialInput("not-a-key", "private-field"), private_key: "highly-sensitive-private-value" },
    credentialInput("-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----", "private-pem"),
    { ...credentialInput("not-a-key", "mnemonic"), mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" }
  ];
  for (const payload of cases) {
    const response = await request(`/v1/agents/${agent.agent_id}/credentials`, "merchant_a", { method: "POST", payload });
    assert.equal(response.status, 400);
    const encoded = JSON.stringify(response.body);
    assert.equal(encoded.includes("highly-sensitive-private-value"), false);
    assert.equal(encoded.includes("abandon abandon"), false);
    assert.equal(encoded.includes("BEGIN PRIVATE KEY"), false);
  }
});

test("proof activates exactly once and is bound to tenant, Agent, credential, and challenge", async () => {
  const { agent, credential, challenge, privateKey } = sessions.get("pop_case");
  const otherAgent = await createAgent("merchant_a", "Other Agent");
  const signature = crypto.sign(null, Buffer.from(challenge), privateKey).toString("base64url");
  const wrongAgent = await request(`/v1/agents/${otherAgent.agent_id}/credentials/${credential.credential_id}/activate`, "merchant_a", {
    method: "POST", payload: { challenge, signature }
  });
  assert.equal(wrongAgent.status, 404);
  const wrongTenant = await request(`/v1/agents/${agent.agent_id}/credentials/${credential.credential_id}/activate`, "merchant_b", {
    method: "POST", payload: { challenge, signature }
  });
  assert.equal(wrongTenant.status, 404);
  const wrongSignature = await request(`/v1/agents/${agent.agent_id}/credentials/${credential.credential_id}/activate`, "merchant_a", {
    method: "POST", payload: { challenge, signature: crypto.randomBytes(64).toString("base64url") }
  });
  assert.equal(wrongSignature.status, 401);

  const activated = await request(`/v1/agents/${agent.agent_id}/credentials/${credential.credential_id}/activate`, "merchant_a", {
    method: "POST", payload: { challenge, signature }
  });
  assert.equal(activated.status, 200);
  assert.equal(activated.body.credential.status, "active");
  assert.equal(activated.body.credential.version, 2);
  const proof = store.db.prepare("SELECT status, proof_digest, challenge_hash FROM agent_credential_proof_challenges WHERE credential_id = ?")
    .get(credential.credential_id);
  assert.equal(proof.status, "consumed");
  assert.match(proof.proof_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(proof).includes(signature), false);

  const replay = await request(`/v1/agents/${agent.agent_id}/credentials/${credential.credential_id}/activate`, "merchant_a", {
    method: "POST", payload: { challenge, signature }
  });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.code, "credential_proof_invalid");
  const listed = await request(`/v1/agents/${agent.agent_id}/credentials`, "merchant_a");
  assert.equal(listed.body.items.length, 1);
  assert.equal(JSON.stringify(listed.body).includes("challenge"), false);
  assert.equal(JSON.stringify(listed.body).includes("proof_digest"), false);
});
