import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { SqliteWebhookOutbox } from "../../services/platform-api/src/adapters/sqlite/webhook-outbox.js";
import { createResponders } from "../../services/platform-api/src/http/responses.js";
import { createPaymentRequestsRouter } from "../../services/platform-api/src/routes/payment-requests.js";
import { Store } from "../../services/platform-api/src/store.js";

test("formal Payment Request confirms on-chain and emits durable Webhook events for every status", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "Paytobe-payment-lifecycle-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new Store(path.join(directory, "relay.sqlite"));
  t.after(() => store.close());
  const at = "2026-08-04T11:00:00.000Z";
  store.db.prepare(`INSERT INTO merchants
    (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
    VALUES ('merchant_a', 'Merchant A', 'active', 'verified', 1, ?, ?)`).run(at, at);
  store.putPaymentRequest({
    request_id: "request_a",
    merchant_id: "merchant_a",
    actor_id: "agent_a",
    connection_id: "connection_a",
    target_app_device_id: "device_a",
    transaction_id: "transaction_a",
    status: "pending",
    recipient_id: "recipient_a",
    recipient_version_id: "recipient_version_a",
    recipient_facts_hash: `sha256:${"a".repeat(64)}`,
    payment: {
      amount: "0.01",
      asset: "XLM",
      network: "stellar_testnet",
      rail: "stellar_xlm",
      horizon_url: "https://horizon-testnet.stellar.org"
    },
    payee: { address: "GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H" },
    risk: { ok: true, level: "safe", review_status: "pending", signing_allowed: true, warnings: [], errors: [] },
    warnings: [],
    created_at: at,
    updated_at: at,
    expires_at: "2026-08-05T11:00:00.000Z"
  });
  store.putPaymentRequest({
    ...store.paymentRequest("request_a"),
    request_id: "request_b",
    transaction_id: "transaction_b",
    status: "broadcasted",
    tx_hash: "tx_testnet_b",
    history: [{ status: "broadcasted", at }]
  });
  store.putPaymentRequest({
    ...store.paymentRequest("request_a"),
    request_id: "request_c",
    transaction_id: "transaction_c",
    status: "failed",
    tx_hash: "tx_testnet_c",
    error: "Missing Stellar Horizon URL for confirmation",
    history: [{ status: "failed", tx_hash: "tx_testnet_c", error: "Missing Stellar Horizon URL for confirmation", at }]
  });

  const audit = [];
  const enqueued = [];
  let schedules = 0;
  let sequence = 0;
  const observability = {
    recordAuditEvent(action, outcome, details) { audit.push({ action, outcome, details }); },
    incrementCounter() {},
    markApiError() {}
  };
  const { sendApiError, sendAuthFailure } = createResponders({ observability });
  const app = express();
  app.use(express.json());
  const paymentRequestsRouter = createPaymentRequestsRouter({
    store,
    observability,
    sendApiError,
    sendAuthFailure,
    verifyAppBody: (req) => req.body.device_id === "device_a"
      ? { ok: true, device_id: "device_a" }
      : { ok: false, status: 401, error: "Invalid app device token" },
    verifyAppQuery: () => ({ ok: false, status: 401, error: "not used" }),
    authorizeConnection: () => ({ ok: false, status: 401, error: "not used" }),
    auditActorFromAuth: () => ({ type: "agent", id: "agent_a" }),
    buildTransactionContextProjection: () => ({ ref: null, snapshot: null, warnings: [] }),
    notifyApp() {},
    notifyOpenClaw() {},
    pushService: null,
    recipientService: null,
    webhookOutbox: new SqliteWebhookOutbox(store.db),
    webhookDeliveryService: {
      enqueue(_scope, eventId) { enqueued.push(eventId); return [`delivery_${eventId}`]; }
    },
    scheduleWebhookDelivery() { schedules += 1; },
    confirmPaymentRequestLater: async (request, txHash, onResult) => {
      assert.ok(["broadcasted", "failed"].includes(request.status));
      assert.equal(txHash, request.tx_hash);
      return onResult("confirmed", { tx_hash: txHash, error: null });
    },
    platformCore: {
      clock: {
        now: () => new Date(at),
        nowIso: () => new Date(Date.parse(at) + sequence * 1000).toISOString()
      },
      random: { id: (prefix) => `${prefix}_${++sequence}` }
    }
  });
  app.use("/v1/payment-requests", paymentRequestsRouter);

  const server = await listen(app);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const signed = await update(base, "signed", null);
  assert.equal(signed.status, 200);
  assert.equal((await signed.json()).payment_request.status, "signed");

  const broadcasted = await update(base, "broadcasted", "tx_testnet_a");
  assert.equal(broadcasted.status, 200);
  assert.equal((await broadcasted.json()).payment_request.status, "broadcasted");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const request = store.paymentRequest("request_a");
  assert.equal(request.status, "confirmed");
  assert.equal(request.tx_hash, "tx_testnet_a");
  assert.deepEqual(request.history.slice(-3).map((item) => item.status), ["signed", "broadcasted", "confirmed"]);

  const events = store.db.prepare("SELECT event_id, type, payload_json FROM webhook_events ORDER BY occurred_at, event_id").all();
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((row) => JSON.parse(row.payload_json).data.status), ["signed", "broadcasted", "confirmed"]);
  assert.ok(events.every((row) => row.type === "payment_request.status_updated"));
  assert.equal(enqueued.length, 3);
  assert.equal(schedules, 3);
  assert.equal(audit.filter((item) => item.action === "payment_request.status_updated").length, 3);
  assert.ok(store.state.events.some((event) => event.type === "payment_request.status" && event.data.status === "confirmed"));

  const reconciled = await paymentRequestsRouter.reconcilePendingConfirmations();
  assert.equal(reconciled.length, 2);
  assert.ok(reconciled.every((result) => result.status === "fulfilled"));
  assert.equal(store.paymentRequest("request_b").status, "confirmed");
  assert.equal(store.paymentRequest("request_b").tx_hash, "tx_testnet_b");
  const recoveredEvent = store.db.prepare(`SELECT payload_json FROM webhook_events
    WHERE aggregate_id = 'request_b' ORDER BY occurred_at DESC LIMIT 1`).get();
  assert.equal(JSON.parse(recoveredEvent.payload_json).data.status, "confirmed");
  assert.equal(store.paymentRequest("request_c").status, "confirmed");
  assert.equal(store.paymentRequest("request_c").error, null);
  assert.equal(enqueued.length, 5);
  assert.equal(schedules, 5);

  function update(origin, status, txHash) {
    return fetch(`${origin}/v1/payment-requests/request_a/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_id: "device_a", status, ...(txHash ? { tx_hash: txHash } : {}) })
    });
  }
});

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}
