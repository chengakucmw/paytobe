import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { CONNECTION_BINDING_VERSION, CONNECTION_TOKEN_AUDIENCE } from "../../services/platform-api/src/application/connections/binding.js";
import { createAuth } from "../../services/platform-api/src/http/auth.js";
import { D1Store } from "../../services/platform-api/edge-testnet/src/worker.mjs";
import { opaqueToken } from "../../services/platform-api/src/crypto.js";
import { Store } from "../../services/platform-api/src/store.js";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("SQLite token is hash-only, fully bound, state-rejoined, rotated, and immediately revoked", (t) => {
  const directory = temporaryDirectory(t);
  const store = new Store(path.join(directory, "connection.sqlite"));
  t.after(() => store.close());
  const at = "2026-08-01T17:00:00.000Z";
  seedControlPlane(store, at);
  store.registerDevice("device_a", "device_token_a");
  const firstToken = opaqueToken("conn_tok", 32);
  const created = store.createConnection("connection_a", firstToken, connectionInput());
  assert.equal(created.binding_version, CONNECTION_BINDING_VERSION);
  assert.equal(created.audience, CONNECTION_TOKEN_AUDIENCE);
  assert.equal(created.connection_token, firstToken);
  assert.equal(store.connection("connection_a").connection_token, undefined);
  assert.match(store.connection("connection_a").connection_token_hash, /^sha256:/);
  assert.equal(store.db.prepare("SELECT json FROM connections WHERE k = ?").get("connection_a").json.includes(firstToken), false);

  const { authorizeConnection } = auth(store);
  assert.equal(authorizeConnection(request(firstToken), "payment.requests.create").ok, true);
  for (const [field, bodyField] of [
    ["merchant_id", "merchant_id"], ["agent_id", "agent_id"], ["client_id", "client_id"],
    ["credential_id", "credential_id"], ["approved_by_device_id", "target_app_device_id"], ["connection_id", "connection_id"]
  ]) {
    const denied = authorizeConnection(request(firstToken, { [bodyField]: `${created[field]}_other` }), "payment.requests.create");
    assert.equal(denied.code, "unauthorized_connection", field);
  }
  assert.equal(authorizeConnection(request(firstToken), "payment.requests.create", { audience: "other-service" }).code, "unauthorized_connection");
  assert.equal(authorizeConnection(request("", { connection_token: firstToken }), "payment.requests.create").code, "token_transport_forbidden");
  assert.equal(authorizeConnection(request("", {}, { connection_token: firstToken }), "payment.requests.create").code, "token_transport_forbidden");

  for (const [table, idColumn, id, badStatus] of [
    ["merchants", "merchant_id", "merchant_a", "suspended"],
    ["agents", "agent_id", "agent_a", "suspended"],
    ["agent_credentials", "credential_id", "credential_a", "revoked"]
  ]) {
    store.db.prepare(`UPDATE ${table} SET status = ? WHERE ${idColumn} = ?`).run(badStatus, id);
    assert.equal(authorizeConnection(request(firstToken), "payment.requests.create").code, "unauthorized_connection", table);
    store.db.prepare(`UPDATE ${table} SET status = 'active' WHERE ${idColumn} = ?`).run(id);
  }
  const device = store.state.devices.device_a;
  delete store.state.devices.device_a;
  assert.equal(authorizeConnection(request(firstToken), "payment.requests.create").code, "unauthorized_connection");
  store.state.devices.device_a = device;

  const secondToken = opaqueToken("conn_tok", 32);
  const rotated = store.rotateConnectionToken("connection_a", secondToken);
  assert.equal(rotated.token_generation, 2);
  assert.equal(store.connectionByToken(firstToken), null);
  assert.equal(authorizeConnection(request(firstToken), "payment.requests.create").code, "unauthorized_connection");
  assert.equal(authorizeConnection(request(secondToken), "payment.requests.create").ok, true);

  store.updateConnectionStatus("connection_a", "revoked", { revoked_at: at, revoked_by_device_id: "device_a" });
  assert.equal(store.connection("connection_a").connection_token_hash, "");
  assert.equal(store.connectionByToken(secondToken), null);
  assert.equal(Object.values(store.state.connectionTokens).includes("connection_a"), false);
});

test("D1 adapter binds the same dimensions and atomically invalidates rotation and revoke", async (t) => {
  const directory = temporaryDirectory(t);
  const sqlite = new DatabaseSync(path.join(directory, "connection-d1.sqlite"));
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(fs.readFileSync(path.join(codeRoot, "services/platform-api/edge-testnet/drizzle/0000_multitenant_connect_platform.sql"), "utf8"));
  t.after(() => sqlite.close());
  const store = new D1Store(new D1Database(sqlite));
  const at = "2026-08-01T17:00:00.000Z";
  await store.createClient({
    tenant_id: "merchant_d1", tenant_name: "Merchant D1", client_id: "client_d1", display_name: "Agent D1",
    runtime: "worker", source_domain: "agent.example.invalid", token_hash: "agent_token_hash", at
  });
  await store.registerDevice("device_d1", "device_token_hash", at);
  const invitation = await store.createInvitation({
    connect_invitation_id: "invitation_d1", connect_key_hash: "connect_key_hash",
    target_app_device_id: "device_d1", created_at: at, updated_at: at, expires_at: "2026-08-01T18:00:00.000Z"
  });
  const claimed = await store.claimInvitation("connect_key_hash", "claim_hash", {
    tenant_id: "merchant_d1", client_id: "client_d1", display_name: "Agent D1", runtime: "worker", source_domain: "agent.example.invalid"
  }, ["payment.requests.create"], "pair_d1", at);
  const approved = await store.approveInvitation(claimed, ["payment.requests.create"], "connection_d1", at, "2026-09-01T00:00:00.000Z");
  assert.equal(approved.connection.agent_identity.binding_version, CONNECTION_BINDING_VERSION);
  assert.equal(approved.connection.agent_identity.merchant_id, "merchant_d1");
  assert.equal(approved.connection.agent_identity.agent_id, "client_d1");
  assert.equal(approved.connection.agent_identity.client_id, "client_d1");
  assert.equal(approved.connection.agent_identity.credential_id, "registered_client:client_d1");
  assert.equal(approved.connection.agent_identity.approved_by_device_id, "device_d1");
  assert.equal(approved.connection.agent_identity.connection_id, "connection_d1");
  assert.equal(approved.connection.agent_identity.audience, CONNECTION_TOKEN_AUDIENCE);

  const first = await store.exchangeInvitation(approved.invitation, "connection_hash_1", at);
  assert.equal((await store.connectionByTokenHash("connection_hash_1")).connection_id, "connection_d1");
  const second = await store.exchangeInvitation(first.invitation, "connection_hash_2", "2026-08-01T17:01:00.000Z");
  assert.equal(await store.connectionByTokenHash("connection_hash_1"), null);
  assert.equal((await store.connectionByTokenHash("connection_hash_2")).connection_id, "connection_d1");
  await store.updateConnection(second.connection.connection_id, "device_d1", "revoked", "2026-08-01T17:02:00.000Z");
  assert.equal(await store.connectionByTokenHash("connection_hash_2"), null);
});

function seedControlPlane(store, at) {
  store.db.prepare(`INSERT INTO merchants
    (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
    VALUES ('merchant_a', 'Merchant A', 'active', 'verified', 1, ?, ?)`).run(at, at);
  store.db.prepare(`INSERT INTO agents
    (agent_id, merchant_id, name, runtime, environment, allowed_scopes_json, token_revocation_version, status, version, created_at, updated_at)
    VALUES ('agent_a', 'merchant_a', 'Agent A', 'node', 'testnet', '["payment.requests.create"]', 0, 'active', 1, ?, ?)`).run(at, at);
  store.db.prepare(`INSERT INTO agent_credentials
    (credential_id, merchant_id, agent_id, kid, alg, public_key, status, not_before, expires_at, revocation_version, version, created_at, updated_at)
    VALUES ('credential_a', 'merchant_a', 'agent_a', 'kid_a', 'Ed25519', 'test-public-key', 'active', ?, '2027-01-01T00:00:00.000Z', 0, 1, ?, ?)`).run(at, at, at);
}

function connectionInput() {
  return {
    agent_identity: {
      merchant_id: "merchant_a", agent_id: "agent_a", client_id: "client_a", credential_id: "credential_a",
      agent_name: "Agent A", runtime: "node", verified: true
    },
    auth_binding: {
      merchant_id: "merchant_a", agent_id: "agent_a", client_id: "client_a", credential_id: "credential_a",
      agent_revocation_version: 0, credential_revocation_version: 0
    },
    scopes: ["payment.requests.create"],
    approved_by_device_id: "device_a",
    pairing_session_id: "pair_a",
    expires_at: "2026-09-01T00:00:00.000Z"
  };
}

function auth(store) {
  return createAuth({
    store,
    runtimeConfig: {},
    observability: { recordAuditEvent() {} },
    replayGuard: {},
    merchantSessionService: null,
    agentAuthService: null
  });
}

function request(token, body = {}, query = {}) {
  return {
    body,
    query,
    get(name) {
      if (String(name).toLowerCase() === "authorization" && token) return `Bearer ${token}`;
      return "";
    }
  };
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "Paytobe-connection-binding-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

class D1Database {
  constructor(db) { this.db = db; }
  prepare(sql) { return new D1Statement(this.db.prepare(sql)); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const values = [];
      for (const statement of statements) values.push(await statement.run());
      this.db.exec("COMMIT");
      return values;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }
}

class D1Statement {
  constructor(statement) { this.statement = statement; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { const row = this.statement.get(...this.values); return row ? { ...row } : null; }
  async all() { return { results: this.statement.all(...this.values).map((row) => ({ ...row })) }; }
  async run() { const result = this.statement.run(...this.values); return { meta: { changes: Number(result.changes || 0) } }; }
}
