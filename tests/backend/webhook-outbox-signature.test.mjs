import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { D1WebhookOutbox } from "../../services/platform-api/src/adapters/d1/webhook-outbox.js";
import { SqliteWebhookOutbox } from "../../services/platform-api/src/adapters/sqlite/webhook-outbox.js";
import { paymentStatusWebhookEvent } from "../../services/platform-api/src/application/webhooks/outbox.js";
import { signWebhookPayload, verifyWebhookSignature } from "../../services/platform-api/src/crypto.js";
import { createTenantScope } from "../../services/platform-api/src/ports/tenant-repository.js";
import { createWebhookDeliveryAttempt, createWebhookEventEnvelope } from "../../services/platform-api/src/ports/webhook-outbox.js";
import { Store } from "../../services/platform-api/src/store.js";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const at = "2026-08-01T18:40:00.000Z";

test("HMAC-SHA256 fixed vector signs timestamp dot exact raw UTF-8 bytes", () => {
  const secret = "whsec_test_vector_0123456789";
  const timestamp = "1785609600";
  const raw = new TextEncoder().encode('{"event_id":"evt_1","message":"付款 ready"}\n');
  const signature = signWebhookPayload(secret, timestamp, raw);
  assert.equal(signature, "t=1785609600,v1=4fe068a979e305ed689a4e0aba5d8612fb8cdddbd297d28028162252f6fd33a3");
  assert.equal(verifyWebhookSignature(secret, raw, signature), true);

  for (const changed of [
    new TextEncoder().encode('{"message":"付款 ready","event_id":"evt_1"}\n'),
    new TextEncoder().encode('{"event_id":"evt_1","message":"付款 ready"}'),
    new TextEncoder().encode('{"event_id":"evt_1","message":"付款 Ready"}\n'),
    new TextEncoder().encode('{"event_id":"evt_1","message":"付款 ready"}\r\n')
  ]) {
    assert.notEqual(signWebhookPayload(secret, timestamp, changed), signature);
    assert.equal(verifyWebhookSignature(secret, changed, signature), false);
  }
});

for (const [runtime, factory] of Object.entries({ express_sqlite: sqliteRuntime, worker_d1: d1Runtime })) {
  test(`${runtime} commits Payment state and byte-stable Outbox event atomically`, async (t) => {
    const adapter = await factory(t);
    const merchantA = scope("merchant_a");
    const merchantB = scope("merchant_b");
    const request = payment("request_a", "merchant_a");
    const event = paymentStatusWebhookEvent(merchantA, request, "signed", {}, {
      eventId: "event_stable_a",
      occurredAt: at
    });
    const committed = await adapter.outbox.commitPaymentStatus(merchantA, request.request_id, "signed", {}, event);
    assert.equal(committed.payment_request.status, "signed");
    assert.equal(committed.event.event_id, "event_stable_a");
    assert.deepEqual(committed.event.raw_body, event.raw_body);

    const stored = await adapter.outbox.event(merchantA, event.event_id);
    assert.deepEqual(stored.raw_body, event.raw_body);
    assert.equal(await adapter.outbox.event(merchantB, event.event_id), null);
    assert.equal((await adapter.readPayment("merchant_a", "request_a")).status, "signed");

    await assert.rejects(async () => adapter.outbox.commitPaymentStatus(merchantA, request.request_id, "broadcasted", { tx_hash: "tx_should_rollback" }, event));
    const afterFailure = await adapter.readPayment("merchant_a", "request_a");
    assert.equal(afterFailure.status, "signed");
    assert.equal(afterFailure.tx_hash, undefined);
    assert.deepEqual((await adapter.outbox.event(merchantA, event.event_id)).raw_body, event.raw_body);
  });
}

test("event envelope bytes and Event ID stay stable while every Delivery attempt receives a unique ID", () => {
  const first = createWebhookEventEnvelope({
    event_id: "event_immutable",
    merchant_id: "merchant_a",
    type: "payment_request.status_updated",
    occurred_at: at,
    data: { request_id: "request_a", status: "confirmed" }
  });
  const retry = createWebhookEventEnvelope({
    event_id: "event_immutable",
    merchant_id: "merchant_a",
    type: "payment_request.status_updated",
    occurred_at: at,
    data: { request_id: "request_a", status: "confirmed" }
  });
  assert.deepEqual(first.raw_body, retry.raw_body);
  assert.equal(first.envelope.event_id, retry.envelope.event_id);

  let counter = 0;
  const random = { id: (prefix) => `${prefix}_${++counter}` };
  const attempt1 = createWebhookDeliveryAttempt({ random, event_id: "event_immutable", webhook_endpoint_id: "endpoint_a", attempt: 1, created_at: at });
  const attempt2 = createWebhookDeliveryAttempt({ random, event_id: "event_immutable", webhook_endpoint_id: "endpoint_a", attempt: 2, created_at: at });
  assert.notEqual(attempt1.delivery_id, attempt2.delivery_id);
  assert.equal(attempt1.event_id, attempt2.event_id);
});

function sqliteRuntime(t) {
  const directory = temporaryDirectory(t);
  const store = new Store(path.join(directory, "express.sqlite"));
  t.after(() => store.close());
  seedSqliteMerchant(store.db, "merchant_a");
  seedSqliteMerchant(store.db, "merchant_b");
  store.putPaymentRequest(payment("request_a", "merchant_a"));
  return {
    outbox: new SqliteWebhookOutbox(store.db),
    readPayment: async (merchantId, requestId) => {
      const row = store.db.prepare(`SELECT json FROM payment_requests
        WHERE json_extract(json, '$.merchant_id') = ? AND k = ?`).get(merchantId, requestId);
      return row ? JSON.parse(row.json) : null;
    }
  };
}

function d1Runtime(t) {
  const directory = temporaryDirectory(t);
  const db = new DatabaseSync(path.join(directory, "worker.sqlite"));
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of ["0000_multitenant_connect_platform.sql", "0002_merchant_tenant_control_plane.sql"]) {
    db.exec(fs.readFileSync(path.join(codeRoot, "services/platform-api/edge-testnet/drizzle", migration), "utf8"));
  }
  t.after(() => db.close());
  seedD1MerchantAndPayment(db, "merchant_a", "request_a");
  seedD1MerchantAndPayment(db, "merchant_b", "request_b");
  const d1 = new D1Database(db);
  return {
    outbox: new D1WebhookOutbox(d1),
    readPayment: async (merchantId, requestId) => {
      const row = db.prepare("SELECT payload_json FROM payment_requests WHERE merchant_id = ? AND request_id = ?").get(merchantId, requestId);
      return row ? JSON.parse(row.payload_json) : null;
    }
  };
}

function payment(requestId, merchantId) {
  return {
    request_id: requestId,
    merchant_id: merchantId,
    connection_id: `connection_${merchantId}`,
    target_app_device_id: `device_${merchantId}`,
    status: "pending",
    recipient_id: `recipient_${merchantId}`,
    recipient_version_id: `recipient_version_${merchantId}`,
    recipient_facts_hash: `sha256:${"a".repeat(64)}`,
    payment: { amount: "1.25", asset: "XLM", network: "stellar_testnet" },
    created_at: at,
    expires_at: "2026-08-02T18:40:00.000Z"
  };
}

function scope(merchantId) {
  return createTenantScope(Object.freeze({ merchant_id: merchantId, actor_id: `actor_${merchantId}`, request_id: `audit_${merchantId}` }));
}

function seedSqliteMerchant(db, merchantId) {
  db.prepare(`INSERT INTO merchants
    (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
    VALUES (?, ?, 'active', 'verified', 1, ?, ?)`).run(merchantId, merchantId, at, at);
}

function seedD1MerchantAndPayment(db, merchantId, requestId) {
  const suffix = merchantId.at(-1);
  db.prepare(`INSERT INTO merchants
    (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
    VALUES (?, ?, 'active', 'verified', 1, ?, ?)`).run(merchantId, merchantId, at, at);
  db.prepare("INSERT INTO tenants (tenant_id, display_name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)")
    .run(merchantId, merchantId, at, at);
  db.prepare(`INSERT INTO agent_clients
    (client_id, tenant_id, display_name, runtime, source_domain, token_hash, status, created_at, updated_at, merchant_id, tenant_attribution, version)
    VALUES (?, ?, ?, 'node', 'example.invalid', ?, 'active', ?, ?, ?, 'explicit_merchant_id', 1)`)
    .run(`client_${suffix}`, merchantId, `Client ${suffix}`, `hash_${suffix}`, at, at, merchantId);
  db.prepare(`INSERT INTO app_devices
    (device_id, token_hash, registered_at, last_seen_at, merchant_id, tenant_attribution, version)
    VALUES (?, ?, ?, ?, ?, 'explicit_merchant_id', 1)`).run(`device_${suffix}`, `device_hash_${suffix}`, at, at, merchantId);
  db.prepare(`INSERT INTO connections
    (connection_id, connection_token_hash, target_app_device_id, tenant_id, client_id, pairing_session_id,
     agent_identity_json, scopes_json, status, created_at, updated_at, expires_at, merchant_id, tenant_attribution, version)
    VALUES (?, ?, ?, ?, ?, ?, '{}', '[]', 'active', ?, ?, ?, ?, 'explicit_merchant_id', 1)`)
    .run(`connection_${merchantId}`, `connection_hash_${suffix}`, `device_${suffix}`, merchantId, `client_${suffix}`, `pair_${suffix}`,
      at, at, "2026-09-01T00:00:00.000Z", merchantId);
  const value = payment(requestId, merchantId);
  db.prepare(`INSERT INTO payment_requests
    (request_id, connection_id, tenant_id, client_id, target_app_device_id, idempotency_key, status,
     payload_json, created_at, updated_at, merchant_id, tenant_attribution, version)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 'explicit_merchant_id', 1)`)
    .run(requestId, `connection_${merchantId}`, merchantId, `client_${suffix}`, `device_${suffix}`, `key_${suffix}`,
      JSON.stringify(value), at, at, merchantId);
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "Paytobe-webhook-outbox-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

class D1Database {
  constructor(db) { this.db = db; }
  prepare(sql) { return new D1Statement(this.db.prepare(sql)); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
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
  async run() { const result = this.statement.run(...this.values); return { meta: { changes: Number(result.changes || 0) } }; }
}
