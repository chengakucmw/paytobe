import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { D1TenantRepository } from "../../services/platform-api/src/adapters/d1/tenant-repository.js";
import { SqliteTenantRepository } from "../../services/platform-api/src/adapters/sqlite/tenant-repository.js";
import {
  assertTenantJobPayload,
  createTenantJobPayload,
  createTenantScope
} from "../../services/platform-api/src/ports/tenant-repository.js";
import { Store } from "../../services/platform-api/src/store.js";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const at = "2026-08-01T00:00:00.000Z";
const matrixResources = ["user", "agent", "credential", "recipient", "connection", "request", "webhook"];

for (const [runtime, factory] of Object.entries({ express_sqlite: sqliteRuntime, worker_d1: d1Runtime })) {
  test(`${runtime} blocks the complete two-merchant resource matrix`, async (t) => {
    const adapter = await factory(t);
    const merchantA = scope("merchant_a");
    const merchantB = scope("merchant_b");
    await seed(adapter, merchantA, "a");
    await seed(adapter, merchantB, "b");

    for (const resource of matrixResources) {
      const idA = resourceId(resource, "a");
      const idB = resourceId(resource, "b");
      const cross = await safeRead(adapter, merchantB, resource, idA, {
        merchant_id: "merchant_a",
        tenant_id: "merchant_a",
        resource_id: idA
      });
      const absent = await safeRead(adapter, merchantB, resource, `${idA}_absent`);
      assert.deepEqual(cross, absent, `${resource} cross-tenant read has canonical non-enumerating semantics`);
      assert.deepEqual(cross, { status: 404, body: { ok: false, error: { code: "resource_not_found", message: "Resource not found" } } });

      assert.equal(await adapter.update(merchantB, resource, idA, { status: crossStatus(resource) }), null, `${resource} cross update`);
      assert.equal(await adapter.delete(merchantB, resource, idA), false, `${resource} cross delete`);
      assert.equal((await adapter.get(merchantA, resource, idA)).merchant_id, "merchant_a", `${resource} owner row survives`);

      const list = await adapter.list(merchantB, resource, { limit: 1, cursor: "" });
      assert.deepEqual(list.items.map((item) => adapter.id(resource, item)), [idB], `${resource} enumeration`);
      assert.equal(list.next_cursor, "", `${resource} cursor cannot reveal another tenant`);
      assert.equal(await adapter.count(merchantB, resource), 1, `${resource} count is tenant-local`);
    }

    assert.equal(await adapter.findRequestByIdempotency(merchantA, "shared-key"), resourceId("request", "a"));
    assert.equal(await adapter.findRequestByIdempotency(merchantB, "shared-key"), resourceId("request", "b"));
    assert.equal(await adapter.findRequestByIdempotency(scope("merchant_c"), "shared-key"), null);

    await assert.rejects(
      async () => adapter.repository.create(merchantB, "recipient", { ...recipient("forged"), merchant_id: "merchant_a" }),
      /cannot override/
    );
    await assert.rejects(async () => adapter.get(undefined, "agent", resourceId("agent", "a")), /TenantScope/);

    const job = createTenantJobPayload(merchantA, "webhook.deliver", { webhook_endpoint_id: resourceId("webhook", "a") });
    assert.equal(assertTenantJobPayload(merchantA, job), job);
    assert.throws(() => assertTenantJobPayload(merchantB, job), /does not match/);
  });
}

test("the matrix names every release-blocking tenant resource and both runtime adapters", () => {
  assert.deepEqual(matrixResources, ["user", "agent", "credential", "recipient", "connection", "request", "webhook"]);
  const gate = fs.readFileSync(path.join(codeRoot, "scripts/release-gate.mjs"), "utf8");
  assert.match(gate, /cross-tenant security matrix/);
  assert.match(gate, /tests\/security\/cross-tenant-matrix\.test\.mjs/);
});

test("the release gate isolates Android signing and Firebase values from every non-Android child", () => {
  const gate = fs.readFileSync(path.join(codeRoot, "scripts/release-gate.mjs"), "utf8");
  assert.match(gate, /const safeInheritedEnvKeys = \[/);
  assert.match(gate, /const androidReleaseEnvKeys = \[/);
  assert.match(gate, /allowAndroidReleaseEnv: true/);
  assert.match(gate, /env: childEnvironment\(step\)/);
  assert.doesNotMatch(gate, /env:\s*\{\s*\.\.\.process\.env/);
});

test("the release gate rebuilds and fully lints the signed Android artifact without cached task results", () => {
  const gate = fs.readFileSync(path.join(codeRoot, "scripts/release-gate.mjs"), "utf8");
  assert.match(gate, /"--rerun-tasks"/);
  assert.match(gate, /"--no-build-cache"/);
  assert.match(gate, /"lintStellarTestnetRelease"/);
  assert.match(gate, /"assembleStellarTestnetRelease"/);
});

async function seed(adapter, tenantScope, suffix) {
  const merchantId = tenantScope.merchant_id;
  await adapter.repository.create(tenantScope, "merchant", merchant(merchantId, `Merchant ${suffix.toUpperCase()}`));
  adapter.insertAccount(`account_${suffix}`);
  await adapter.repository.create(tenantScope, "membership", membership(`membership_${suffix}`, `account_${suffix}`));
  await adapter.repository.create(tenantScope, "agent", agent(resourceId("agent", suffix)));
  await adapter.repository.create(tenantScope, "credential", credential(resourceId("credential", suffix), resourceId("agent", suffix)));
  await adapter.repository.create(tenantScope, "recipient", recipient(resourceId("recipient", suffix)));
  await adapter.repository.create(tenantScope, "webhook", webhook(resourceId("webhook", suffix)));
  adapter.insertLegacyTenantResources(merchantId, suffix);
}

function safeRead(adapter, tenantScope, resource, id, _selfDeclaredClaims = {}) {
  return adapter.get(tenantScope, resource, id).then((value) => value
    ? { status: 200, body: { ok: true, value } }
    : { status: 404, body: { ok: false, error: { code: "resource_not_found", message: "Resource not found" } } });
}

function sqliteRuntime(t) {
  const directory = temporaryDirectory(t);
  const store = new Store(path.join(directory, "express.sqlite"));
  t.after(() => store.close());
  return matrixAdapter("sqlite", store.db, new SqliteTenantRepository(store.db));
}

function d1Runtime(t) {
  const directory = temporaryDirectory(t);
  const db = new DatabaseSync(path.join(directory, "worker-d1.sqlite"));
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of ["0000_multitenant_connect_platform.sql", "0002_merchant_tenant_control_plane.sql"]) {
    db.exec(fs.readFileSync(path.join(codeRoot, "services/platform-api/edge-testnet/drizzle", migration), "utf8"));
  }
  t.after(() => db.close());
  return matrixAdapter("d1", db, new D1TenantRepository(new D1Database(db)));
}

function matrixAdapter(kind, db, repository) {
  const canonical = { user: "membership", agent: "agent", credential: "credential", recipient: "recipient", webhook: "webhook" };
  return {
    repository,
    id(resource, value) {
      if (resource === "connection") return value.connection_id;
      if (resource === "request") return value.request_id;
      const mapped = canonical[resource];
      return value[{ membership: "membership_id", agent: "agent_id", credential: "credential_id", recipient: "recipient_id", webhook: "webhook_endpoint_id" }[mapped]];
    },
    insertAccount(accountId) {
      db.prepare(`INSERT INTO merchant_accounts (account_id, email_normalized, status, version, created_at, updated_at)
        VALUES (?, ?, 'active', 1, ?, ?)`).run(accountId, `${accountId}@example.invalid`, at, at);
    },
    insertLegacyTenantResources(merchantId, suffix) {
      if (kind === "sqlite") {
        insertSqliteJson(db, "connections", resourceId("connection", suffix), merchantId, {
          connection_id: resourceId("connection", suffix), merchant_id: merchantId, status: "active"
        });
        insertSqliteJson(db, "payment_requests", resourceId("request", suffix), merchantId, {
          request_id: resourceId("request", suffix), merchant_id: merchantId, idempotency_key: "shared-key", status: "pending"
        });
        return;
      }
      db.prepare("INSERT INTO tenants (tenant_id, display_name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)")
        .run(merchantId, merchantId, at, at);
      db.prepare(`INSERT INTO agent_clients
        (client_id, tenant_id, display_name, runtime, source_domain, token_hash, status, created_at, updated_at, merchant_id, tenant_attribution, version)
        VALUES (?, ?, ?, 'node', 'example.invalid', ?, 'active', ?, ?, ?, 'explicit_merchant_id', 1)`)
        .run(`client_${suffix}`, merchantId, `Client ${suffix}`, `hash_${suffix}`, at, at, merchantId);
      db.prepare(`INSERT INTO app_devices
        (device_id, token_hash, registered_at, last_seen_at, merchant_id, tenant_attribution, version)
        VALUES (?, ?, ?, ?, ?, 'explicit_merchant_id', 1)`)
        .run(`device_${suffix}`, `device_hash_${suffix}`, at, at, merchantId);
      db.prepare(`INSERT INTO connections
        (connection_id, connection_token_hash, target_app_device_id, tenant_id, client_id, pairing_session_id,
         agent_identity_json, scopes_json, status, created_at, updated_at, expires_at, merchant_id, tenant_attribution, version)
        VALUES (?, ?, ?, ?, ?, ?, '{}', '[]', 'active', ?, ?, ?, ?, 'explicit_merchant_id', 1)`)
        .run(resourceId("connection", suffix), `connection_hash_${suffix}`, `device_${suffix}`, merchantId, `client_${suffix}`, `pair_${suffix}`, at, at, "2026-09-01T00:00:00.000Z", merchantId);
      db.prepare(`INSERT INTO payment_requests
        (request_id, connection_id, tenant_id, client_id, target_app_device_id, idempotency_key, status,
         payload_json, created_at, updated_at, merchant_id, tenant_attribution, version)
        VALUES (?, ?, ?, ?, ?, 'shared-key', 'pending', ?, ?, ?, ?, 'explicit_merchant_id', 1)`)
        .run(resourceId("request", suffix), resourceId("connection", suffix), merchantId, `client_${suffix}`, `device_${suffix}`,
          JSON.stringify({ request_id: resourceId("request", suffix), merchant_id: merchantId, idempotency_key: "shared-key", status: "pending" }), at, at, merchantId);
    },
    async get(scopeValue, resource, id) {
      if (canonical[resource]) return repository.get(scopeValue, canonical[resource], id);
      return legacyGet(kind, db, scopeValue, resource, id);
    },
    async list(scopeValue, resource, options) {
      if (canonical[resource]) return repository.list(scopeValue, canonical[resource], options);
      return legacyList(kind, db, scopeValue, resource, options);
    },
    async count(scopeValue, resource) {
      if (canonical[resource]) return repository.count(scopeValue, canonical[resource]);
      const listed = await legacyList(kind, db, scopeValue, resource, { limit: 100 });
      return listed.items.length;
    },
    async update(scopeValue, resource, id, patch) {
      if (canonical[resource]) return repository.update(scopeValue, canonical[resource], id, patch);
      return legacyMutation(kind, db, "update", scopeValue, resource, id, patch);
    },
    async delete(scopeValue, resource, id) {
      if (canonical[resource]) return repository.delete(scopeValue, canonical[resource], id);
      return legacyMutation(kind, db, "delete", scopeValue, resource, id);
    },
    async findRequestByIdempotency(scopeValue, key) {
      const value = await repository.findPaymentRequestByIdempotency(scopeValue, key);
      return value?.request_id || null;
    }
  };
}

function legacyGet(kind, db, scopeValue, resource, id) {
  assertScope(scopeValue);
  const table = resource === "connection" ? "connections" : "payment_requests";
  if (kind === "sqlite") {
    const row = db.prepare(`SELECT json FROM ${table} WHERE merchant_id = ? AND k = ?`).get(scopeValue.merchant_id, id);
    return row ? JSON.parse(row.json) : null;
  }
  const idColumn = resource === "connection" ? "connection_id" : "request_id";
  const row = db.prepare(`SELECT * FROM ${table} WHERE merchant_id = ? AND ${idColumn} = ?`).get(scopeValue.merchant_id, id);
  return row ? { ...row } : null;
}

function legacyList(kind, db, scopeValue, resource, { limit = 50, cursor = "" } = {}) {
  assertScope(scopeValue);
  const table = resource === "connection" ? "connections" : "payment_requests";
  const idColumn = kind === "sqlite" ? "k" : resource === "connection" ? "connection_id" : "request_id";
  const rows = db.prepare(`SELECT * FROM ${table} WHERE merchant_id = ? AND ${idColumn} > ? ORDER BY ${idColumn} LIMIT ?`)
    .all(scopeValue.merchant_id, cursor, limit + 1);
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => kind === "sqlite" ? JSON.parse(row.json) : { ...row });
  return { items, next_cursor: more ? String(items.at(-1)?.[resource === "connection" ? "connection_id" : "request_id"] || "") : "" };
}

function legacyMutation(kind, db, operation, scopeValue, resource, id, patch = {}) {
  assertScope(scopeValue);
  const table = resource === "connection" ? "connections" : "payment_requests";
  const idColumn = kind === "sqlite" ? "k" : resource === "connection" ? "connection_id" : "request_id";
  if (operation === "delete") {
    const result = db.prepare(`DELETE FROM ${table} WHERE merchant_id = ? AND ${idColumn} = ?`).run(scopeValue.merchant_id, id);
    return Number(result.changes || 0) === 1;
  }
  const result = kind === "sqlite"
    ? db.prepare(`UPDATE ${table} SET json = json_set(json, '$.status', ?) WHERE merchant_id = ? AND k = ?`).run(patch.status, scopeValue.merchant_id, id)
    : db.prepare(`UPDATE ${table} SET status = ? WHERE merchant_id = ? AND ${idColumn} = ?`).run(patch.status, scopeValue.merchant_id, id);
  return Number(result.changes || 0) === 1 ? legacyGet(kind, db, scopeValue, resource, id) : null;
}

function insertSqliteJson(db, table, id, merchantId, value) {
  db.prepare(`INSERT INTO ${table} (k, json, merchant_id, tenant_attribution, version) VALUES (?, ?, ?, 'explicit_merchant_id', 1)`)
    .run(id, JSON.stringify(value), merchantId);
}

function assertScope(value) {
  if (!value || !Object.isFrozen(value) || !value.merchant_id) throw new TypeError("Immutable TenantScope is required");
}

function scope(merchantId) {
  return createTenantScope(Object.freeze({ merchant_id: merchantId, actor_id: `actor_${merchantId}`, request_id: `request_${merchantId}` }));
}

function resourceId(resource, suffix) {
  return `${resource === "user" ? "membership" : resource}_${suffix}`;
}

function crossStatus(resource) {
  return ({ user: "suspended", agent: "suspended", credential: "revoked", recipient: "suspended", connection: "revoked", request: "failed", webhook: "paused" })[resource];
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "Paytobe-cross-tenant-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function merchant(merchantId, displayName) {
  return { merchant_id: merchantId, display_name: displayName, status: "active", verification_state: "verified", version: 1, created_at: at, updated_at: at };
}
function membership(id, accountId) {
  return { membership_id: id, account_id: accountId, role: "owner", status: "active", version: 1, created_at: at, updated_at: at };
}
function agent(id) {
  return { agent_id: id, name: "Agent", runtime: "node", environment: "test", allowed_scopes_json: "[]", token_revocation_version: 0, status: "active", version: 1, created_at: at, updated_at: at };
}
function credential(id, agentId) {
  return { credential_id: id, agent_id: agentId, kid: `kid_${id}`, alg: "Ed25519", public_key: "test-public-key", status: "active", not_before: at, expires_at: "2026-09-01T00:00:00.000Z", revocation_version: 0, version: 1, created_at: at, updated_at: at };
}
function recipient(id) {
  return { recipient_id: id, name: "Recipient", status: "active", version: 1, created_at: at, updated_at: at };
}
function webhook(id) {
  return { webhook_endpoint_id: id, url: "https://example.invalid/webhook", event_types_json: "[]", status: "active", secret_ciphertext: "ciphertext:test-only", version: 1, created_at: at, updated_at: at };
}

class D1Database {
  constructor(db) { this.db = db; }
  prepare(sql) { return new D1Statement(this.db.prepare(sql)); }
}
class D1Statement {
  constructor(statement) { this.statement = statement; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { const row = this.statement.get(...this.values); return row ? { ...row } : null; }
  async all() { return { results: this.statement.all(...this.values).map((row) => ({ ...row })) }; }
  async run() { const result = this.statement.run(...this.values); return { meta: { changes: Number(result.changes || 0) } }; }
}
