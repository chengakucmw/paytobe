import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { AGENT_TOKEN_AUDIENCE, SqliteAgentAuthRepository } from "../../services/platform-api/src/application/agent-auth/service.js";
import { D1AgentAuthRepository } from "../../services/platform-api/src/adapters/d1/agent-auth-repository.js";
import { id, opaqueToken, tokenHash } from "../../services/platform-api/src/crypto.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-agent-replay-"));
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
  session = seedTenant();
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

function seedTenant() {
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO merchants
    (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
    VALUES ('merchant_replay', 'Replay Merchant', 'active', 'verified', 1, ?, ?)`).run(now, now);
  store.db.prepare(`INSERT INTO merchant_accounts
    (account_id, email_normalized, status, version, created_at, updated_at)
    VALUES ('owner_replay', 'owner-replay@example.invalid', 'active', 1, ?, ?)`).run(now, now);
  store.db.prepare(`INSERT INTO merchant_memberships
    (membership_id, merchant_id, account_id, role, status, version, created_at, updated_at)
    VALUES (?, 'merchant_replay', 'owner_replay', 'owner', 'active', 1, ?, ?)`).run(id("membership"), now, now);
  const sessionToken = opaqueToken("msession", 32);
  const csrfToken = opaqueToken("mcsrf", 32);
  store.db.prepare(`INSERT INTO merchant_sessions
    (session_id, merchant_id, account_id, token_hash, csrf_hash, status, expires_at, idle_expires_at, created_at, updated_at)
    VALUES (?, 'merchant_replay', 'owner_replay', ?, ?, 'active', ?, ?, ?, ?)`).run(
    id("msession"), tokenHash(sessionToken), tokenHash(csrfToken), new Date(Date.now() + 3_600_000).toISOString(),
    new Date(Date.now() + 1_800_000).toISOString(), now, now
  );
  return { cookie: `vp_merchant_session=${sessionToken}`, csrf: csrfToken };
}

async function api(pathname, { method = "GET", payload } = {}) {
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

async function provisionIdentity() {
  agent = (await api("/v1/agents", {
    method: "POST", payload: {
      name: "Replay Agent", runtime: "node", environment: "testnet",
      allowed_scopes: ["payment.requests.create"]
    }
  })).body.agent;
  keyPair = crypto.generateKeyPairSync("ed25519");
  const registered = await api(`/v1/agents/${agent.agent_id}/credentials`, {
    method: "POST", payload: {
      kid: "replay-key", alg: "Ed25519", public_key: keyPair.publicKey.export({ format: "jwk" }).x,
      not_before: new Date(Date.now() - 1_000).toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString()
    }
  });
  credential = registered.body.credential;
  const proof = crypto.sign(null, Buffer.from(registered.body.proof_challenge), keyPair.privateKey).toString("base64url");
  assert.equal((await api(`/v1/agents/${agent.agent_id}/credentials/${credential.credential_id}/activate`, {
    method: "POST", payload: { challenge: registered.body.proof_challenge, signature: proof }
  })).status, 200);
  agent = (await api(`/v1/agents/${agent.agent_id}`, { method: "PATCH", payload: { status: "active", version: 1 } })).body.agent;
}

function signedAssertion(jti = crypto.randomUUID()) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: credential.kid, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: agent.agent_id, sub: "replay-client", aud: AGENT_TOKEN_AUDIENCE,
    iat: now, exp: now + 300, jti, scope: ["payment.requests.create"]
  })).toString("base64url");
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${crypto.sign(null, Buffer.from(signingInput), keyPair.privateKey).toString("base64url")}`;
}

async function exchange(value) {
  const response = await fetch(`${origin}/v1/agent-auth/token`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_assertion: value })
  });
  return { status: response.status, body: await response.json() };
}

test("concurrent submission of one signed assertion atomically issues exactly one token and stores only the JTI hash", async () => {
  const compact = signedAssertion("single-use-jti");
  const results = await Promise.all(Array.from({ length: 12 }, () => exchange(compact)));
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  assert.equal(results.filter((result) => result.status === 401).length, 11);
  const jtis = store.db.prepare("SELECT * FROM agent_assertion_jtis WHERE credential_id = ?").all(credential.credential_id);
  assert.equal(jtis.length, 1);
  assert.match(jtis[0].jti_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(jtis[0].jti_hash.includes("single-use-jti"), false);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM agent_access_tokens WHERE credential_id = ?").get(credential.credential_id).count, 1);
});

test("every protected-token check rejects merchant suspension, Agent revocation version, and credential revocation version immediately", async () => {
  const issued = await exchange(signedAssertion("revocation-jti"));
  assert.equal(issued.status, 200);
  assert.equal(agentAuthService.authenticate(issued.body.access_token, "before_revocation").ok, true);
  store.db.prepare("UPDATE merchants SET status = 'suspended' WHERE merchant_id = 'merchant_replay'").run();
  assert.equal(agentAuthService.authenticate(issued.body.access_token, "merchant_suspended").status, 401);
  store.db.prepare("UPDATE merchants SET status = 'active' WHERE merchant_id = 'merchant_replay'").run();
  store.db.prepare("UPDATE agents SET token_revocation_version = token_revocation_version + 1 WHERE agent_id = ?").run(agent.agent_id);
  assert.equal(agentAuthService.authenticate(issued.body.access_token, "agent_revoked").status, 401);

  const second = await exchange(signedAssertion("credential-revocation-jti"));
  assert.equal(second.status, 200);
  store.db.prepare("UPDATE agent_credentials SET revocation_version = revocation_version + 1 WHERE credential_id = ?").run(credential.credential_id);
  assert.equal(agentAuthService.authenticate(second.body.access_token, "credential_revoked").status, 401);
});

test("JTI cleanup removes only expired rows and cannot make a still-valid assertion reusable", () => {
  const repository = new SqliteAgentAuthRepository(store.db);
  const current = store.db.prepare("SELECT * FROM agent_assertion_jtis WHERE credential_id = ? ORDER BY expires_at DESC LIMIT 1")
    .get(credential.credential_id);
  store.db.prepare(`INSERT INTO agent_assertion_jtis (merchant_id, credential_id, jti_hash, expires_at, created_at)
    VALUES ('merchant_replay', ?, 'sha256:expired-test', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`).run(credential.credential_id);
  assert.equal(repository.pruneExpiredJtis(new Date().toISOString()), 1);
  assert.ok(store.db.prepare("SELECT 1 FROM agent_assertion_jtis WHERE jti_hash = ?").get(current.jti_hash));
});

for (const [runtime, build] of Object.entries({ sqlite: sqliteContract, d1: d1Contract })) {
  test(`${runtime} adapter has the same atomic replay and immediate-revocation contract`, async (t) => {
    const { db, repository, close } = build();
    t.after(close);
    const value = contractToken("token_hash_contract");
    const jti = contractJti("jti_hash_contract");
    const issued = await Promise.all(Array.from({ length: 8 }, (_, index) => repository.issueFromAssertion({
      ...value, token_id: `token_${index}`, token_hash: `hash_${index}`
    }, jti)));
    assert.equal(issued.filter(Boolean).length, 1);
    const winner = issued.find(Boolean);
    assert.ok(await repository.activeToken(winner.token_hash, "2026-08-01T00:01:00.000Z"));
    db.prepare("UPDATE agents SET status = 'suspended', token_revocation_version = token_revocation_version + 1 WHERE agent_id = 'agent_contract'").run();
    assert.equal(await repository.activeToken(winner.token_hash, "2026-08-01T00:01:00.000Z"), null);
  });
}

function sqliteContract() {
  const db = new DatabaseSync(":memory:");
  createContractSchema(db);
  const repository = new SqliteAgentAuthRepository(db);
  seedContract(db);
  return { db, repository, close: () => db.close() };
}

function d1Contract() {
  const db = new DatabaseSync(":memory:");
  createContractSchema(db);
  seedContract(db);
  return { db, repository: new D1AgentAuthRepository(new FakeD1(db)), close: () => db.close() };
}

function createContractSchema(db) {
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE merchants (merchant_id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE agents (agent_id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, status TEXT NOT NULL, token_revocation_version INTEGER NOT NULL);
    CREATE TABLE agent_credentials (credential_id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL,
      not_before TEXT NOT NULL, expires_at TEXT NOT NULL, revocation_version INTEGER NOT NULL, UNIQUE (merchant_id, agent_id, credential_id));
    CREATE TABLE agent_assertion_jtis (merchant_id TEXT NOT NULL, credential_id TEXT NOT NULL, jti_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (merchant_id, credential_id, jti_hash));
    CREATE TABLE agent_access_tokens (token_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, merchant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, client_id TEXT NOT NULL, credential_id TEXT NOT NULL, scopes_json TEXT NOT NULL,
      agent_revocation_version INTEGER NOT NULL, credential_revocation_version INTEGER NOT NULL, status TEXT NOT NULL,
      issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);`);
}

function seedContract(db) {
  db.prepare("INSERT INTO merchants VALUES ('merchant_contract', 'active')").run();
  db.prepare("INSERT INTO agents VALUES ('agent_contract', 'merchant_contract', 'active', 0)").run();
  db.prepare("INSERT INTO agent_credentials VALUES ('credential_contract', 'merchant_contract', 'agent_contract', 'active', ?, ?, 0)")
    .run("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z");
}

function contractToken(tokenHashValue) {
  return {
    token_id: "token_contract", token_hash: tokenHashValue, merchant_id: "merchant_contract", agent_id: "agent_contract",
    client_id: "client_contract", credential_id: "credential_contract", scopes: ["payment.requests.create"],
    agent_revocation_version: 0, credential_revocation_version: 0, status: "active",
    issued_at: "2026-08-01T00:00:00.000Z", expires_at: "2026-08-01T00:05:00.000Z"
  };
}

function contractJti(hash) {
  return { merchant_id: "merchant_contract", credential_id: "credential_contract", jti_hash: hash,
    expires_at: "2026-08-01T00:05:00.000Z", created_at: "2026-08-01T00:00:00.000Z" };
}

class FakeD1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new FakeD1Statement(this.db.prepare(sql)); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
class FakeD1Statement {
  constructor(statement) { this.statement = statement; this.values = []; }
  bind(...values) { this.values = values; return this; }
  execute() { const result = this.statement.run(...this.values); return { meta: { changes: Number(result.changes || 0) } }; }
  async first() { const row = this.statement.get(...this.values); return row ? { ...row } : null; }
  async run() { return this.execute(); }
}
