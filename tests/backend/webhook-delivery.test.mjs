import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteWebhookDeliveryRepository } from "../../services/platform-api/src/adapters/webhook/delivery-repository.js";
import { WebhookDeliveryService, WEBHOOK_RETRY_DELAYS_MS, classifyWebhookDelivery } from "../../services/platform-api/src/application/webhooks/delivery-worker.js";
import { SqliteWebhookEndpointRepository } from "../../services/platform-api/src/application/webhooks/endpoint-service.js";
import { createAes256GcmVault } from "../../services/platform-api/src/crypto.js";
import { createObservability } from "../../services/platform-api/src/observability.js";
import { createTenantScope } from "../../services/platform-api/src/ports/tenant-repository.js";
import { Store } from "../../services/platform-api/src/store.js";
import { edgeWebhookDeliveryDecision } from "../../services/platform-api/edge-testnet/src/worker.mjs";

const start = Date.parse("2026-08-01T18:50:00.000Z");
const secret = `whsec_${"S".repeat(43)}`;

test("retry worker follows immediate/1m/5m/30m/2h/12h, creates unique attempts, and stops within 24h", async (t) => {
  const statuses = [500, 429, new Error("socket reset"), 408, 503, 500];
  const runtime = setup(t, statuses);
  const tenant = scope("merchant_a");
  const [initialId] = runtime.service.enqueue(tenant, "event_a");
  assert.ok(initialId);
  const attempts = [];

  for (let index = 0; index < statuses.length; index++) {
    const before = runtime.clock.now().getTime();
    const result = await runtime.service.runOnce("worker_a");
    attempts.push(result.delivery);
    if (index < statuses.length - 1) {
      assert.equal(result.outcome, "retry");
      const next = runtime.repository.getById("merchant_a", result.next_delivery_id);
      assert.equal(Date.parse(next.scheduled_at) - before, WEBHOOK_RETRY_DELAYS_MS[index + 1]);
      runtime.clock.set(Date.parse(next.scheduled_at));
    } else {
      assert.equal(result.outcome, "failed");
      assert.equal(result.delivery.failure_code, "retry_window_exhausted");
      assert.equal(result.next_delivery_id, null);
    }
  }

  assert.equal(new Set(attempts.map((item) => item.delivery_id)).size, 6);
  assert.deepEqual(attempts.map((item) => item.attempt), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(attempts.map((item) => item.event_id), Array(6).fill("event_a"));
  assert.equal(runtime.transportCalls.every((call) => call.headers["x-velarumpay-event-id"] === "event_a"), true);
  assert.equal(runtime.transportCalls.every((call) => call.headers["x-velarumpay-signature"].startsWith("t=")), true);
  assert.equal(runtime.transportCalls.every((call) => new TextDecoder().decode(call.raw_body) === runtime.rawBody), true);
  assert.equal(runtime.service.list(tenant).items.some((item) => Object.hasOwn(item, "secret_ciphertext")), false);
  assert.equal(runtime.observability.prometheusText().includes(secret), false);
  assert.equal(JSON.stringify(runtime.observability.listAuditEvents({ limit: 200 })).includes(secret), false);
});

test("2xx succeeds, ordinary 4xx terminates, retryable codes align with Edge, and response bodies are never consumed", () => {
  for (const status of [200, 204, 400, 401, 404, 408, 429, 500, 503]) {
    const express = classifyWebhookDelivery({ response_status: status });
    const edge = edgeWebhookDeliveryDecision(status);
    assert.equal(edge.kind, express.kind, String(status));
    assert.equal(edge.failure_code || "", express.failure_code || "", String(status));
  }
  assert.equal(classifyWebhookDelivery({ response_status: 204 }).kind, "delivered");
  assert.equal(classifyWebhookDelivery({ response_status: 400 }).kind, "failed");
  assert.equal(classifyWebhookDelivery({ response_status: 408 }).kind, "retry");
  assert.equal(classifyWebhookDelivery({ response_status: 429 }).kind, "retry");
  assert.equal(classifyWebhookDelivery({ response_status: 500 }).kind, "retry");
  assert.equal(classifyWebhookDelivery({ error: Object.assign(new Error("private"), { code: "webhook_non_public_address" }) }).kind, "failed");
});

test("database lease prevents concurrent claims and authorized replay keeps Event/payload while changing Delivery ID", async (t) => {
  const runtime = setup(t, [204]);
  const tenantA = scope("merchant_a");
  const tenantB = scope("merchant_b");
  const [deliveryId] = runtime.service.enqueue(tenantA, "event_a");
  const at = runtime.clock.nowIso();
  const first = runtime.repository.claimDue("worker_1", at, new Date(Date.parse(at) + 30_000).toISOString());
  const second = runtime.repository.claimDue("worker_2", at, new Date(Date.parse(at) + 30_000).toISOString());
  assert.equal(first.delivery_id, deliveryId);
  assert.equal(second, null);

  runtime.repository.complete(first, { kind: "failed", failure_code: "http_400", response_status: 400 }, at);
  const replay = runtime.service.replay(tenantA, deliveryId);
  assert.equal(replay.ok, true);
  assert.notEqual(replay.delivery.delivery_id, deliveryId);
  assert.equal(replay.delivery.event_id, "event_a");
  assert.equal(replay.delivery.replay_of_delivery_id, deliveryId);
  assert.equal(runtime.service.replay(tenantB, deliveryId).status, 404);
  const originalRaw = runtime.store.db.prepare("SELECT payload_json FROM webhook_events WHERE event_id = 'event_a'").get().payload_json;
  assert.equal(originalRaw, runtime.rawBody);
});

function setup(t, outcomes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-webhook-delivery-"));
  const store = new Store(path.join(directory, "platform.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  new SqliteWebhookEndpointRepository(store.db);
  seedMerchant(store.db, "merchant_a");
  seedMerchant(store.db, "merchant_b");
  const vault = createAes256GcmVault(Buffer.alloc(32, 11).toString("base64url"), "velarumpay.webhook_secret.v1");
  const endpointId = "endpoint_a";
  const secretId = "secret_a";
  const ciphertext = JSON.stringify(vault.encrypt(secret, `merchant_a:${endpointId}:${secretId}`));
  store.db.prepare(`INSERT INTO webhook_endpoints
    (webhook_endpoint_id, merchant_id, url, event_types_json, status, secret_ciphertext, version, created_at, updated_at,
     verification_mode, verified_at, current_secret_id)
    VALUES (?, 'merchant_a', 'https://hooks.merchant.co/callback', '["payment_request.status_updated"]', 'active', ?, 1, ?, ?,
      'merchant_domain', ?, ?)`)
    .run(endpointId, ciphertext, new Date(start).toISOString(), new Date(start).toISOString(), new Date(start).toISOString(), secretId);
  store.db.prepare(`INSERT INTO webhook_endpoint_secrets
    (secret_id, merchant_id, webhook_endpoint_id, ciphertext, status, created_at)
    VALUES (?, 'merchant_a', ?, ?, 'active', ?)`).run(secretId, endpointId, ciphertext, new Date(start).toISOString());
  const rawBody = JSON.stringify({ version: "velarum.webhook_event.v1", event_id: "event_a", merchant_id: "merchant_a",
    type: "payment_request.status_updated", occurred_at: new Date(start).toISOString(), data: { request_id: "request_a", status: "signed" } });
  store.db.prepare(`INSERT INTO webhook_events
    (event_id, merchant_id, type, aggregate_id, payload_json, occurred_at, created_at)
    VALUES ('event_a', 'merchant_a', 'payment_request.status_updated', 'request_a', ?, ?, ?)`)
    .run(rawBody, new Date(start).toISOString(), new Date(start).toISOString());

  const repository = new SqliteWebhookDeliveryRepository(store.db);
  const clock = controlledClock(start);
  const transportCalls = [];
  let outcomeIndex = 0;
  const transport = {
    async deliver(input) {
      transportCalls.push(input);
      const outcome = outcomes[Math.min(outcomeIndex++, outcomes.length - 1)];
      if (outcome instanceof Error) throw outcome;
      return { status: outcome, duration_ms: 7 };
    }
  };
  const observability = createObservability({ logAuditToStdout: false });
  let counter = 0;
  const service = new WebhookDeliveryService({
    repository,
    transport,
    vault,
    clock,
    random: { id: (prefix) => `${prefix}_${String(++counter).padStart(6, "0")}` },
    observability
  });
  return { store, repository, service, clock, observability, transportCalls, rawBody };
}

function seedMerchant(db, merchantId) {
  const at = new Date(start).toISOString();
  db.prepare(`INSERT INTO merchants
    (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
    VALUES (?, ?, 'active', 'verified', 1, ?, ?)`).run(merchantId, merchantId, at, at);
}

function scope(merchantId) {
  return createTenantScope(Object.freeze({ merchant_id: merchantId, actor_id: `owner_${merchantId}`, request_id: `request_${merchantId}` }));
}

function controlledClock(initial) {
  let current = initial;
  return {
    now: () => new Date(current),
    nowIso: () => new Date(current).toISOString(),
    set: (value) => { current = value; },
    advance: (milliseconds) => { current += milliseconds; }
  };
}
