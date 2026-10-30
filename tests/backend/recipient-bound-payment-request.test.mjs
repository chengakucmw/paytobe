import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

import { bindRecipientPaymentRequest } from "../../services/platform-api/src/application/payment-requests/recipient-binding.js";
import { RecipientService, SqliteRecipientRepository } from "../../services/platform-api/src/application/recipients/service.js";
import { createPaymentRequestsRouter } from "../../services/platform-api/src/routes/payment-requests.js";
import { createResponders } from "../../services/platform-api/src/http/responses.js";
import { createTenantScope } from "../../services/platform-api/src/ports/tenant-repository.js";
import { Store } from "../../services/platform-api/src/store.js";

const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const now = "2026-08-01T18:10:00.000Z";

test("canonical create, Wallet read, and event pin the same active Recipient facts", async (t) => {
  const runtime = setup(t);
  seedRecipient(runtime.store, "merchant_a", "recipient_active", "version_active", "active", "active", address);
  const app = testApp(runtime);
  const server = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const createdResponse = await fetch(`${origin}/v1/payment-requests`, {
    method: "POST",
    headers: { authorization: "Bearer connection-token", "content-type": "application/json", "x-idempotency-key": "create-1" },
    body: JSON.stringify({
      recipient_id: "recipient_active",
      recipient_version_id: "version_active",
      payment: { amount: "12.50" },
      expires_at: "2026-08-02T18:10:00.000Z",
      transaction_context_ref: { transaction_id: "context_missing_but_separate" },
      display: { title: "Invoice 42" },
      metadata: { invoice: { reference: "42" } }
    })
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).payment_request;
  assert.equal(created.recipient_id, "recipient_active");
  assert.equal(created.recipient_version_id, "version_active");
  assert.match(created.recipient_facts_hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(created.recipient_snapshot, {
    recipient_id: "recipient_active", recipient_version_id: "version_active", rail: "stellar_xlm",
    network: "stellar_testnet", asset: "XLM", address, memo: null, contract: null, issuer: null
  });
  assert.deepEqual(created.payment, {
    amount: "12.50", rail: "stellar_xlm", network: "stellar_testnet", asset: "XLM", to: address, memo: null, decimals: 7
  });
  assert.equal(created.payee.name, "Recipient recipient_active");
  assert.equal(created.payee.verified, true);
  assert.equal(created.transaction_id, "context_missing_but_separate");

  const walletResponse = await fetch(`${origin}/v1/payment-requests/${created.request_id}?device_id=device_a&token=device-token`);
  assert.equal(walletResponse.status, 200);
  const wallet = (await walletResponse.json()).payment_request;
  assert.equal(wallet.recipient_facts_hash, created.recipient_facts_hash);
  assert.deepEqual(wallet.recipient_snapshot, created.recipient_snapshot);

  const eventsResponse = await fetch(`${origin}/v1/payment-requests/events?since=0&device_id=device_a&token=device-token`);
  assert.equal(eventsResponse.status, 200);
  const event = (await eventsResponse.json()).items.find((item) => item.request_id === created.request_id);
  assert.equal(event.recipient_version_id, created.recipient_version_id);
  assert.equal(event.recipient_facts_hash, created.recipient_facts_hash);
  assert.deepEqual(event.recipient_snapshot, created.recipient_snapshot);
});

test("client recipient overrides fail while server-selected facts remain authoritative", async (t) => {
  const runtime = setup(t);
  seedRecipient(runtime.store, "merchant_a", "recipient_active", "version_active", "active", "active", address);
  const tenant = scope("merchant_a");
  const base = { recipient_id: "recipient_active", payment: { amount: "1" } };

  for (const [label, input, code] of [
    ["payment address", { ...base, payment: { amount: "1", to: "GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H" } }, "recipient_facts_override_forbidden"],
    ["display address", { ...base, display: { address: "conflict" } }, "authoritative_display_forbidden"],
    ["nested metadata recipient", { ...base, metadata: { invoice: { recipient: "conflict" } } }, "authoritative_display_forbidden"]
  ]) {
    const result = await bindRecipientPaymentRequest({ recipientService: runtime.recipientService, scope: tenant, input });
    assert.equal(result.code, code, label);
  }

  const accepted = await bindRecipientPaymentRequest({ recipientService: runtime.recipientService, scope: tenant, input: base });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.value.payment.to, address);
  assert.equal(accepted.value.payment.network, "stellar_testnet");
});

test("draft, cooling, suspended, revoked, cross-tenant, stale, and unsupported versions fail closed", async (t) => {
  const runtime = setup(t);
  seedMerchant(runtime.store, "merchant_b");
  seedRecipient(runtime.store, "merchant_a", "recipient_draft", "version_draft", "draft", "unverified", addressVariant(4));
  seedRecipient(runtime.store, "merchant_a", "recipient_cooling", "version_cooling", "pending_verification", "verified_cooling", addressVariant(1));
  seedRecipient(runtime.store, "merchant_a", "recipient_suspended", "version_suspended", "suspended", "active", addressVariant(2));
  seedRecipient(runtime.store, "merchant_a", "recipient_revoked", "version_revoked", "revoked", "active", addressVariant(3));
  seedRecipient(runtime.store, "merchant_a", "recipient_active", "version_active", "active", "active", address);
  seedRecipient(runtime.store, "merchant_a", "recipient_unsupported", "version_unsupported", "active", "active", "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE", {
    network: "tron", asset: "TRX"
  });
  const input = (recipientId, versionId) => ({ recipient_id: recipientId, recipient_version_id: versionId, payment: { amount: "1" } });

  for (const [recipientId, versionId] of [
    ["recipient_draft", "version_draft"], ["recipient_cooling", "version_cooling"],
    ["recipient_suspended", "version_suspended"], ["recipient_revoked", "version_revoked"]
  ]) {
    assert.equal((await bindRecipientPaymentRequest({ recipientService: runtime.recipientService, scope: scope("merchant_a"), input: input(recipientId, versionId) })).status, 404);
  }
  assert.equal((await bindRecipientPaymentRequest({ recipientService: runtime.recipientService, scope: scope("merchant_b"), input: input("recipient_active", "version_active") })).status, 404);
  assert.equal((await bindRecipientPaymentRequest({ recipientService: runtime.recipientService, scope: scope("merchant_a"), input: input("recipient_active", "version_stale") })).status, 404);
  assert.equal((await bindRecipientPaymentRequest({ recipientService: runtime.recipientService, scope: scope("merchant_a"), input: input("recipient_unsupported", "version_unsupported") })).code, "unsupported_tron");
});

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "Paytobe-recipient-payment-"));
  const store = new Store(path.join(directory, "platform.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  seedMerchant(store, "merchant_a");
  store.registerDevice("device_a", "device-token");
  const connection = store.createConnection("connection_a", "connection-token", {
    agent_identity: {
      merchant_id: "merchant_a", agent_id: "agent_a", client_id: "client_a", credential_id: "credential_a",
      agent_name: "Agent A", runtime: "node", verified: true
    },
    auth_binding: {
      merchant_id: "merchant_a", agent_id: "agent_a", client_id: "client_a", credential_id: "credential_a",
      agent_revocation_version: 0, credential_revocation_version: 0
    },
    scopes: ["payment.requests.create", "payment.requests.read"],
    approved_by_device_id: "device_a",
    expires_at: "2027-01-01T00:00:00.000Z"
  });
  return {
    store,
    connection,
    recipientService: new RecipientService({
      repository: new SqliteRecipientRepository(store.db),
      clock: { nowIso: () => now },
      random: { id: (prefix) => `${prefix}_test` }
    })
  };
}

function testApp(runtime) {
  const observability = {
    recordAuditEvent() {}, incrementCounter() {}, markApiError() {}
  };
  const { sendApiError, sendAuthFailure } = createResponders({ observability });
  const app = express();
  app.use(express.json());
  app.use("/v1/payment-requests", createPaymentRequestsRouter({
    store: runtime.store,
    recipientService: runtime.recipientService,
    observability,
    sendApiError,
    sendAuthFailure,
    authorizeConnection: () => ({ ok: true, connection: runtime.connection }),
    verifyAppQuery: (req) => runtime.store.verifyDeviceToken(req.query.device_id, req.query.token)
      ? { ok: true, device_id: req.query.device_id }
      : { ok: false, status: 401, error: "Invalid app device token" },
    verifyAppBody: () => ({ ok: false, status: 401, error: "not used" }),
    auditActorFromAuth: () => ({ type: "agent", id: "agent_a" }),
    buildTransactionContextProjection: (request) => ({
      ref: { transaction_id: request.transaction_id || null, status: "missing" }, snapshot: null, context: null,
      warnings: [{ code: "context_missing", message: "Context missing", details: {} }]
    }),
    notifyApp() {}, notifyOpenClaw() {}, pushService: null,
    platformCore: {
      clock: { now: () => new Date(now) },
      random: { id: (prefix) => `${prefix}_000001` }
    }
  }));
  return app;
}

function seedMerchant(store, merchantId) {
  store.db.prepare(`INSERT OR IGNORE INTO merchants
    (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
    VALUES (?, ?, 'active', 'verified', 1, ?, ?)`).run(merchantId, merchantId, now, now);
}

function seedRecipient(store, merchantId, recipientId, versionId, recipientStatus, versionStatus, recipientAddress, overrides = {}) {
  const activeVersionId = recipientStatus === "active" ? versionId : null;
  store.db.prepare(`INSERT INTO recipients
    (recipient_id, merchant_id, name, status, active_version_id, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(recipientId, merchantId, `Recipient ${recipientId}`, recipientStatus, activeVersionId, now, now);
  store.db.prepare(`INSERT INTO recipient_versions
    (recipient_version_id, merchant_id, recipient_id, network, asset, address, memo, verification_state,
     effective_at, created_at, cooling_started_at, cooling_until, last_evaluated_at, activated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`)
    .run(versionId, merchantId, recipientId, overrides.network || "stellar_testnet", overrides.asset || "XLM", recipientAddress,
      versionStatus, now, now, now, now, now, versionStatus === "active" ? now : null);
}

function scope(merchantId) {
  return createTenantScope(Object.freeze({ merchant_id: merchantId, actor_id: "agent_a", request_id: `request_${merchantId}` }));
}

function addressVariant(seed) {
  const values = [
    "GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H",
    "GBTCX7GBRJ6K27VFMT26LU5J2CFFTVGWEYOZ5WBQYDJC2RLPTLLDPPLO",
    "GCGB2F7QB6CKDKA5DR6QNYM7I43TJJD5VPPV2NBL5C5GFOZMPJGN5OZB",
    "GCFXMTYTZMXSWYL6D4LEZ2MCTM3N3SLP7ZKGBXKLCYJTCCAD44VUDUXA"
  ];
  return values[seed - 1];
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}
