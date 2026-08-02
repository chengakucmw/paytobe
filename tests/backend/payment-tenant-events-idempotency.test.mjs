import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  canonicalPaymentRequestHash,
  decidePaymentStatusTransition,
  PAYMENT_REQUEST_ROUTE,
  StorePaymentTenantRepository
} from "../../services/platform-api/src/application/payment-requests/tenant-state.js";
import { createTenantScope } from "../../services/platform-api/src/ports/tenant-repository.js";
import { Store } from "../../services/platform-api/src/store.js";
import { D1Store, edgePaymentTransition, MemoryStore } from "../../services/platform-api/edge-testnet/src/worker.mjs";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const at = "2026-08-01T18:20:00.000Z";
const future = "2026-08-02T18:20:00.000Z";

test("Express SQLite repository scopes requests, actor idempotency, transaction hashes, and cursors", (t) => {
  const directory = temporaryDirectory(t);
  const store = new Store(path.join(directory, "express.sqlite"));
  t.after(() => store.close());
  const repository = new StorePaymentTenantRepository(store);
  const merchantAAgent1 = scope("merchant_a", "agent_1");
  const merchantAAgent2 = scope("merchant_a", "agent_2");
  const merchantB = scope("merchant_b", "agent_1");

  const canonicalA = { recipient_id: "recipient_a", payment: { amount: "1.25" }, metadata: { invoice: "42" } };
  const sameDifferentOrder = { metadata: { invoice: "42" }, payment: { amount: "1.25" }, recipient_id: "recipient_a" };
  const requestHash = canonicalPaymentRequestHash(canonicalA);
  assert.equal(requestHash, canonicalPaymentRequestHash(sameDifferentOrder));
  assert.notEqual(requestHash, canonicalPaymentRequestHash({ ...canonicalA, payment: { amount: "2.00" } }));

  store.putPaymentRequest(payment("request_a1", "merchant_a", "agent_1", "connection_a1", "shared-key", requestHash));
  store.putPaymentRequest(payment("request_a2", "merchant_a", "agent_2", "connection_a2", "shared-key", requestHash));
  store.putPaymentRequest(payment("request_b", "merchant_b", "agent_1", "connection_b", "shared-key", requestHash));
  store.updatePaymentRequestStatus("request_a1", "signed", { tx_hash: "tx_shared" });

  assert.equal(repository.findIdempotency(merchantAAgent1, PAYMENT_REQUEST_ROUTE, "shared-key").request_id, "request_a1");
  assert.equal(repository.findIdempotency(merchantAAgent2, PAYMENT_REQUEST_ROUTE, "shared-key").request_id, "request_a2");
  assert.equal(repository.findIdempotency(merchantB, PAYMENT_REQUEST_ROUTE, "shared-key").request_id, "request_b");
  assert.equal(repository.get(merchantB, "request_a1"), null);
  assert.equal(repository.findByTransactionHash(merchantB, "tx_shared"), null);
  assert.equal(repository.findByTransactionHash(merchantAAgent1, "tx_shared").request_id, "request_a1");

  const first = repository.eventsForConnection(merchantAAgent1, "connection_a1");
  const replay = repository.eventsForConnection(merchantAAgent1, "connection_a1");
  assert.deepEqual(first.items.map((event) => event.event_id), replay.items.map((event) => event.event_id));
  assert.equal(new Set(first.items.map((event) => event.event_id)).size, first.items.length);
  assert.throws(() => repository.eventsForConnection(merchantB, "connection_b", first.next_cursor), (error) => error.code === "invalid_tenant_cursor");
});

for (const [runtime, factory] of Object.entries({ worker_memory: memoryRuntime, worker_d1: d1Runtime })) {
  test(`${runtime} enforces merchant+actor+route+key hashes and stable tenant events`, async (t) => {
    const { store, connectionA, connectionB } = await factory(t);
    const baseA = edgePayment("request_a", "shared-key", "1.25");
    const createdA = await store.createPaymentScoped(connectionA, baseA, at);
    assert.equal(createdA.outcome, "created");
    assert.equal(createdA.payment.merchant_id, "merchant_a");
    assert.equal(createdA.payment.actor_id, "agent_a");
    assert.equal(createdA.payment.idempotency_route, PAYMENT_REQUEST_ROUTE);

    const duplicate = await store.createPaymentScoped(connectionA, { ...baseA, request_id: "request_a_retry", created_at: "2026-08-01T18:20:01.000Z" }, at);
    assert.equal(duplicate.outcome, "duplicate");
    assert.equal(duplicate.payment.request_id, "request_a");
    assert.equal((await store.createPaymentScoped(connectionA, edgePayment("request_conflict", "shared-key", "2.00"), at)).outcome, "conflict");

    const createdB = await store.createPaymentScoped(connectionB, edgePayment("request_b", "shared-key", "1.25"), at);
    assert.equal(createdB.outcome, "created");
    assert.equal(await store.paymentByIdForTenant(connectionB, "request_a"), null);

    const signed = await store.updatePayment("request_a", "device_a", "signed", {}, "2026-08-01T18:21:00.000Z");
    assert.equal(signed.outcome, "updated");
    const eventsBeforeDuplicate = await store.paymentEventsForTenant(connectionA);
    assert.equal(eventsBeforeDuplicate.items.length, 2);
    const repeated = await store.updatePayment("request_a", "device_a", "signed", {}, "2026-08-01T18:22:00.000Z");
    assert.equal(repeated.outcome, "duplicate");
    const eventsAfterDuplicate = await store.paymentEventsForTenant(connectionA);
    assert.deepEqual(eventsAfterDuplicate.items.map((event) => event.event_id), eventsBeforeDuplicate.items.map((event) => event.event_id));
    assert.equal(new Set(eventsAfterDuplicate.items.map((event) => event.event_id)).size, 2);
    await assert.rejects(async () => store.paymentEventsForTenant(connectionB, eventsAfterDuplicate.next_cursor), (error) => error.code === "invalid_tenant_cursor");

    await store.updatePayment("request_a", "device_a", "broadcasted", { tx_hash: "tx_a" }, "2026-08-01T18:23:00.000Z");
    assert.equal((await store.findPaymentByTransactionHash(connectionA, "tx_a")).request_id, "request_a");
    assert.equal(await store.findPaymentByTransactionHash(connectionB, "tx_a"), null);
  });
}

test("Express and Edge transition decisions align on rollback, duplicate broadcast, terminal, and expiry", () => {
  const cases = [
    [{ status: "pending", expires_at: future }, "signed", Date.parse(at)],
    [{ status: "pending", expires_at: at }, "signed", Date.parse(future)],
    [{ status: "signed", expires_at: future }, "signed", Date.parse(at)],
    [{ status: "signed", expires_at: future }, "pending", Date.parse(at)],
    [{ status: "broadcasted", expires_at: future }, "broadcasted", Date.parse(at)],
    [{ status: "confirmed", expires_at: future }, "failed", Date.parse(at)]
  ];
  for (const [request, next, clock] of cases) {
    const expressDecision = decidePaymentStatusTransition(request, next, clock);
    const edgeDecision = edgePaymentTransition(request, next, clock);
    assert.equal(edgeDecision.ok, expressDecision.ok, `${request.status}->${next}`);
    assert.equal(Boolean(edgeDecision.duplicate), Boolean(expressDecision.duplicate), `${request.status}->${next}`);
    assert.equal(edgeDecision.code || "", expressDecision.code || "", `${request.status}->${next}`);
  }
});

function payment(requestId, merchantId, actorId, connectionId, key, requestHash) {
  return {
    request_id: requestId,
    merchant_id: merchantId,
    actor_id: actorId,
    connection_id: connectionId,
    target_app_device_id: `device_${merchantId}`,
    idempotency_key: key,
    idempotency_route: PAYMENT_REQUEST_ROUTE,
    idempotency_request_hash: requestHash,
    status: "pending",
    payment: { rail: "stellar_xlm", network: "stellar_testnet", asset: "XLM", amount: "1.25", to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" },
    created_at: at,
    expires_at: future
  };
}

function edgePayment(requestId, key, amount) {
  return {
    protocol: "velarum.payment_request.v1",
    request_id: requestId,
    idempotency_key: key,
    status: "pending",
    created_at: at,
    expires_at: future,
    policy: { requires_user_approval: true },
    payment: { rail: "stellar_xlm", network: "stellar_testnet", stellar_testnet: true, asset: "XLM", amount,
      to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" }
  };
}

function scope(merchantId, actorId) {
  return createTenantScope(Object.freeze({ merchant_id: merchantId, actor_id: actorId, request_id: `audit_${merchantId}_${actorId}` }));
}

async function memoryRuntime() {
  return { store: new MemoryStore(), connectionA: connection("a"), connectionB: connection("b") };
}

async function d1Runtime(t) {
  const directory = temporaryDirectory(t);
  const db = new DatabaseSync(path.join(directory, "worker.sqlite"));
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of ["0000_multitenant_connect_platform.sql", "0002_merchant_tenant_control_plane.sql"]) {
    db.exec(fs.readFileSync(path.join(codeRoot, "services/platform-api/edge-testnet/drizzle", migration), "utf8"));
  }
  t.after(() => db.close());
  for (const suffix of ["a", "b"]) seedD1Connection(db, suffix);
  return { store: new D1Store(new D1Database(db)), connectionA: connection("a"), connectionB: connection("b") };
}

function connection(suffix) {
  return {
    connection_id: `connection_${suffix}`,
    tenant_id: `merchant_${suffix}`,
    merchant_id: `merchant_${suffix}`,
    client_id: `client_${suffix}`,
    agent_id: `agent_${suffix}`,
    target_app_device_id: `device_${suffix}`,
    agent_identity: { agent_id: `agent_${suffix}` }
  };
}

function seedD1Connection(db, suffix) {
  const merchantId = `merchant_${suffix}`;
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
    VALUES (?, ?, ?, ?, ?, ?, '{}', '["payment.requests.create","payment.requests.read"]', 'active', ?, ?, ?, ?, 'explicit_merchant_id', 1)`)
    .run(`connection_${suffix}`, `connection_hash_${suffix}`, `device_${suffix}`, merchantId, `client_${suffix}`, `pair_${suffix}`,
      at, at, "2026-09-01T00:00:00.000Z", merchantId);
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-payment-tenant-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
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
