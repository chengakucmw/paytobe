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

function scope(merchantId) {
  return createTenantScope(Object.freeze({
    merchant_id: merchantId,
    actor_id: `actor_${merchantId}`,
    request_id: `request_${merchantId}`
  }));
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "Paytobe-tenant-repository-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function sqliteAdapter(t) {
  const store = new Store(path.join(temporaryDirectory(t), "sqlite.sqlite"));
  t.after(() => store.close());
  return { repository: new SqliteTenantRepository(store.db), db: store.db };
}

function d1Adapter(t) {
  const db = new DatabaseSync(path.join(temporaryDirectory(t), "d1.sqlite"));
  db.exec("PRAGMA foreign_keys = ON");
  const migrations = ["0000_multitenant_connect_platform.sql", "0002_merchant_tenant_control_plane.sql"];
  for (const migration of migrations) {
    db.exec(fs.readFileSync(path.join(codeRoot, "services/platform-api/edge-testnet/drizzle", migration), "utf8"));
  }
  t.after(() => db.close());
  return { repository: new D1TenantRepository(new D1Database(db)), db };
}

for (const [name, adapter] of Object.entries({ sqlite: sqliteAdapter, d1: d1Adapter })) {
  test(`${name} tenant repository requires scope in SQL for reads, writes, lists, counts, cursors, and deletes`, async (t) => {
    const { repository } = adapter(t);
    const merchantA = scope("merchant_a");
    const merchantB = scope("merchant_b");

    await repository.create(merchantA, "merchant", merchant("merchant_a", "Merchant A"));
    await repository.create(merchantB, "merchant", merchant("merchant_b", "Merchant B"));
    for (const id of ["agent_a1", "agent_a2", "agent_a3"]) {
      await repository.create(merchantA, "agent", agent(id));
    }
    await repository.create(merchantB, "agent", agent("agent_b1"));
    await repository.create(merchantA, "recipient", recipient("recipient_a"));
    await repository.create(merchantB, "recipient", recipient("recipient_b"));
    await repository.create(merchantA, "webhook", webhook("webhook_a"));
    await repository.create(merchantB, "webhook", webhook("webhook_b"));

    assert.equal((await repository.get(merchantA, "agent", "agent_a1")).agent_id, "agent_a1");
    assert.equal(await repository.get(merchantB, "agent", "agent_a1"), null, "cross-tenant read is indistinguishable from absent");
    assert.equal(await repository.update(merchantB, "agent", "agent_a1", { name: "stolen" }), null);
    assert.equal(await repository.delete(merchantB, "recipient", "recipient_a"), false);
    assert.equal((await repository.get(merchantA, "recipient", "recipient_a")).name, "Recipient");

    const first = await repository.list(merchantA, "agent", { limit: 2 });
    assert.deepEqual(first.items.map((item) => item.agent_id), ["agent_a1", "agent_a2"]);
    assert.equal(first.next_cursor, "agent_a2");
    const second = await repository.list(merchantA, "agent", { limit: 2, cursor: first.next_cursor });
    assert.deepEqual(second.items.map((item) => item.agent_id), ["agent_a3"]);
    assert.equal(await repository.count(merchantA, "agent"), 3);
    assert.equal(await repository.count(merchantB, "agent"), 1);

    await assert.rejects(async () => repository.get(undefined, "agent", "agent_a1"), /TenantScope/);
    await assert.rejects(async () => repository.list(undefined, "agent"), /TenantScope/);
    await assert.rejects(async () => repository.count(undefined, "agent"), /TenantScope/);
    await assert.rejects(async () => repository.delete(undefined, "agent", "agent_a1"), /TenantScope/);
    await assert.rejects(async () => repository.findPaymentRequestByIdempotency(undefined, "key"), /TenantScope/);
    await assert.rejects(
      async () => repository.create(merchantA, "recipient", { ...recipient("recipient_forged"), merchant_id: "merchant_b" }),
      /cannot override/
    );
  });
}

test("tenant async payloads carry an immutable merchant and are rechecked before execution", () => {
  const merchantA = scope("merchant_a");
  const merchantB = scope("merchant_b");
  const job = createTenantJobPayload(merchantA, "webhook.deliver", { event_id: "event_1" });
  assert.ok(Object.isFrozen(job));
  assert.ok(Object.isFrozen(job.payload));
  assert.equal(assertTenantJobPayload(merchantA, job), job);
  assert.throws(() => assertTenantJobPayload(merchantB, job), /does not match/);
});

test("both adapters bind merchant_id in id, update, delete, list, count, cursor, and idempotency SQL", () => {
  for (const file of [
    "services/platform-api/src/adapters/sqlite/tenant-repository.js",
    "services/platform-api/src/adapters/d1/tenant-repository.js"
  ]) {
    const source = fs.readFileSync(path.join(codeRoot, file), "utf8");
    assert.match(source, /WHERE merchant_id = \? AND \$\{spec\.id\} = \?/);
    assert.match(source, /WHERE merchant_id = \? AND \$\{spec\.id\} > \?/);
    assert.match(source, /COUNT\(\*\).*WHERE merchant_id = \?/s);
    assert.match(source, /WHERE merchant_id = \? AND (?:idempotency_key|json_extract)/);
  }
});

function merchant(merchantId, displayName) {
  return {
    merchant_id: merchantId,
    display_name: displayName,
    status: "active",
    verification_state: "verified",
    version: 1,
    created_at: at,
    updated_at: at
  };
}

function agent(agentId) {
  return {
    agent_id: agentId,
    name: "Agent",
    runtime: "node",
    environment: "test",
    allowed_scopes_json: "[]",
    token_revocation_version: 0,
    status: "active",
    version: 1,
    created_at: at,
    updated_at: at
  };
}

function recipient(recipientId) {
  return { recipient_id: recipientId, name: "Recipient", status: "active", version: 1, created_at: at, updated_at: at };
}

function webhook(webhookEndpointId) {
  return {
    webhook_endpoint_id: webhookEndpointId,
    url: "https://example.invalid/webhooks",
    event_types_json: "[]",
    status: "active",
    secret_ciphertext: "ciphertext:test-only",
    version: 1,
    created_at: at,
    updated_at: at
  };
}

class D1Database {
  constructor(db) { this.db = db; }
  prepare(sql) { return new D1Statement(this.db.prepare(sql)); }
}

class D1Statement {
  constructor(statement) {
    this.statement = statement;
    this.values = [];
  }
  bind(...values) {
    this.values = values;
    return this;
  }
  async first() {
    const row = this.statement.get(...this.values);
    return row ? { ...row } : null;
  }
  async all() {
    return { results: this.statement.all(...this.values).map((row) => ({ ...row })) };
  }
  async run() {
    const result = this.statement.run(...this.values);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}
