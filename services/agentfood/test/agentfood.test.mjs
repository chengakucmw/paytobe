import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildTestnetArtifacts } from "../src/artifacts.mjs";
import { buildMockOrder } from "../src/catalog.mjs";
import { configHealth, loadConfig, validateConfig } from "../src/config.mjs";
import { signWebhookPayload } from "../../platform-api/src/crypto.js";
import { createAgentCredentialSigner, PlatformClient } from "../src/platform-client.mjs";
import { createAgentFoodServer } from "../src/server.mjs";
import { AgentFoodStore } from "../src/store.mjs";

const RECIPIENT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const API_KEY = "agentfood-api-key-with-at-least-32-characters";
const CONNECTION_TOKEN = "connection-token-with-enough-entropy";
const WEBHOOK_SECRET = "whsec_agentfood_test_secret_00000001";
const KEY_PAIR = crypto.generateKeyPairSync("ed25519");
const PRIVATE_KEY = KEY_PAIR.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

function validConfig(overrides = {}) {
  return loadConfig({
    AGENTFOOD_RUNTIME_ENV: "development",
    AGENTFOOD_API_KEY: API_KEY,
    AGENTFOOD_STORE_PATH: path.join(os.tmpdir(), "agentfood-test-store.json"),
    PLATFORM_API_URL: "http://127.0.0.1:8787",
    AGENTFOOD_AGENT_CREDENTIAL_KID: "agentfood-test-key",
    AGENTFOOD_AGENT_CREDENTIAL_PRIVATE_KEY_PKCS8_B64: PRIVATE_KEY,
    AGENTFOOD_WEBHOOK_SECRET: WEBHOOK_SECRET,
    AGENTFOOD_STELLAR_TESTNET_ENABLED: "true",
    AGENTFOOD_STELLAR_TESTNET_MAX_XLM: "1",
    AGENTFOOD_STELLAR_PAYMENT_AMOUNT_XLM: "0.1",
    AGENTFOOD_STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
    AGENTFOOD_RECIPIENT_ID: "agentfood-recipient",
    AGENTFOOD_RECIPIENT_VERSION_ID: "agentfood-recipient-v1",
    AGENTFOOD_PAYEE_NAME: "AgentFood test recipient",
    ...overrides
  });
}

function sampleOrder(config = validConfig()) {
  return buildMockOrder({
    merchant_id: "green-bowl",
    items: [
      { item_id: "garden-bowl", quantity: 1 },
      { item_id: "citrus-tea", quantity: 2 }
    ]
  }, config.stellar.paymentAmountXlm, new Date("2026-07-24T00:00:00.000Z"));
}

test("production connector fails closed until official testnet controls are configured", () => {
  const result = validateConfig(loadConfig({ AGENTFOOD_RUNTIME_ENV: "production" }));
  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("TESTNET_ENABLED")));
  assert(result.errors.some((error) => error.includes("AGENTFOOD_RECIPIENT_ID")));
  assert(result.errors.some((error) => error.includes("AGENTFOOD_AGENT_CREDENTIAL")));
});

test("production site-only mode starts without pretending payments are ready", () => {
  const config = loadConfig({
    AGENTFOOD_RUNTIME_ENV: "production",
    AGENTFOOD_SITE_ONLY: "true",
    AGENTFOOD_PUBLIC_BASE_URL: "https://agentfood.velarumai.com",
    AGENTFOOD_API_KEY: API_KEY,
    AGENTFOOD_STORE_PATH: "/var/lib/agentfood/agentfood-store.json",
    PLATFORM_API_URL: "https://api.velarumai.com"
  });
  assert.deepEqual(validateConfig(config), { ok: true, errors: [] });
  const health = configHealth(config);
  assert.equal(health.site_ready, true);
  assert.equal(health.payment_ready, false);
  assert.equal(health.site_only, true);
});

test("AgentFood refuses any server-side Stellar signing material", () => {
  const result = validateConfig(validConfig({ STELLAR_SECRET_KEY: "S-should-never-be-here" }));
  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("Private signing material is forbidden")));
});

test("valid testnet config passes while an amount over the cap fails", () => {
  assert.deepEqual(validateConfig(validConfig()), { ok: true, errors: [] });
  const over = validateConfig(validConfig({ AGENTFOOD_STELLAR_PAYMENT_AMOUNT_XLM: "1.0000001" }));
  assert.equal(over.ok, false);
  assert(over.errors.some((error) => error.includes("exceeds")));
});

test("mock catalog total is explicitly separate from the fixed test XLM settlement", () => {
  const order = sampleOrder();
  assert.equal(order.mock_quote.total, "14.3");
  assert.equal(order.mock_quote.currency, "MOCK_CREDITS");
  assert.equal(order.settlement.amount, "0.1");
  assert.equal(order.settlement.real_transaction_process, true);
  assert.equal(order.settlement.real_value_transfer, false);
  assert.equal(order.settlement.purchases_food, false);
  assert.equal(order.fulfillment, "none");
});

test("testnet artifacts keep chain facts real and commerce claims visibly mock", () => {
  const config = validConfig();
  const order = sampleOrder(config);
  const artifacts = buildTestnetArtifacts(order, config, new Date("2026-07-24T00:00:00.000Z"));
  assert.equal(artifacts.paymentRequest.payment.amount, "0.1");
  assert.equal(artifacts.paymentRequest.recipient_id, "agentfood-recipient");
  assert.equal(artifacts.paymentRequest.recipient_version_id, "agentfood-recipient-v1");
  assert.equal(Object.hasOwn(artifacts.paymentRequest.payment, "to"), false);
  assert.equal(Object.hasOwn(artifacts.paymentRequest.metadata, "food_order"), false);
  assert.equal(artifacts.context.type, "generic");
  assert.equal(artifacts.context.metadata.food_order.mock, true);
  assert.match(artifacts.paymentRequest.display.summary, /0\.1 test XLM/);
  assert.match(artifacts.paymentRequest.display.summary, /mock only/);
  assert.equal(artifacts.context.metadata.food_order.settlement_summary.total, artifacts.paymentRequest.payment.amount);
});

test("Platform client uses the SDK signer and a runtime Connection token with stable idempotency", async () => {
  const config = validConfig();
  const order = sampleOrder(config);
  const artifacts = buildTestnetArtifacts(order, config);
  const calls = [];
  const client = new PlatformClient(config.platform, { signer: createAgentCredentialSigner({
    AGENTFOOD_AGENT_CREDENTIAL_PRIVATE_KEY_PKCS8_B64: PRIVATE_KEY
  }), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true, payment_request: { request_id: artifacts.paymentRequest.request_id } }), { status: 201 });
  } });
  await client.createPaymentRequest(artifacts.paymentRequest, CONNECTION_TOKEN);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${CONNECTION_TOKEN}`);
  assert.equal(calls[0].options.headers["x-idempotency-key"], artifacts.paymentRequest.idempotency_key);
  assert.equal(JSON.stringify(calls[0]).includes("private"), false);
});

test("OpenAI Sites reference demo remains Stellar testnet-only", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const localAgent = fs.readFileSync(path.join(root, "examples/agentfood-platform-demo/src/agent.mjs"), "utf8");
  const hostedApi = fs.readFileSync(path.join(root, "examples/agentfood-platform-demo/cloud/real-connect-api.mjs"), "utf8");
  assert.match(localAgent, /agentfood-reference-recipient/);
  assert.match(hostedApi, /agentfood-reference-recipient/);
  assert.doesNotMatch(localAgent, /network:\s*["']stellar_public["']/);
  assert.doesNotMatch(hostedApi, /network:\s*["']stellar_public["']/);
});

test("HTTP flow creates a mock order then a real testnet Payment Request", {
  skip: process.env.VP_ALLOW_LISTEN_TESTS !== "1"
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentfood-http-"));
  const config = validConfig({ AGENTFOOD_STORE_PATH: path.join(dir, "store.json") });
  const store = new AgentFoodStore(config.storePath);
  const platformClient = {
    async claimConnectInvitation() {
      return {
        ok: true,
        claim_token: "claim_tok_test",
        connect_invitation: { connect_invitation_id: "cinv_test", status: "claimed" },
        pairing_session: { pairing_session_id: "pair_test", status: "pending" }
      };
    },
    async getConnectInvitation() {
      return { ok: true, connect_invitation: { connect_invitation_id: "cinv_test", status: "approved" } };
    },
    async exchangeConnectInvitation() {
      return {
        ok: true,
        connect_invitation: { connect_invitation_id: "cinv_test", status: "connected" },
        connection: { connection_id: "conn_test", connection_token: CONNECTION_TOKEN }
      };
    },
    async createTransactionContext(context, token) {
      assert.equal(token, CONNECTION_TOKEN);
      return { ok: true, context: { transaction_id: context.transaction_id, status: context.status } };
    },
    async createPaymentRequest(paymentRequest, token) {
      assert.equal(token, CONNECTION_TOKEN);
      return { ok: true, payment_request: {
        ...paymentRequest,
        request_id: "prq_test",
        payment: { amount: paymentRequest.payment.amount, network: "stellar_testnet", asset: "XLM", to: RECIPIENT },
        risk: { signing_allowed: true }
      } };
    },
    async paymentRequest() {
      throw new Error("not used");
    }
  };
  const server = createAgentFoodServer({ config, store, platformClient });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let response = await fetch(`${base}/v1/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentfood-api-key": API_KEY },
    body: JSON.stringify({ connect_key: `velarumpay-connect:ck_${"A".repeat(43)}` })
  });
  assert.equal(response.status, 201);
  const connected = await response.json();

  response = await fetch(`${base}/v1/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agentfood-api-key": API_KEY,
      "x-idempotency-key": "agentfood-http-test-1"
    },
    body: JSON.stringify({
      connect_session_id: connected.connect_session.session_id,
      merchant_id: "green-bowl",
      items: [{ item_id: "garden-bowl", quantity: 1 }]
    })
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.order.data_mode, "mock_commerce_live_payment");

  response = await fetch(`${base}/v1/orders/${created.order.order_id}/payment-request`, {
    method: "POST",
    headers: { "x-agentfood-api-key": API_KEY }
  });
  assert.equal(response.status, 201);
  const payment = await response.json();
  assert.equal(payment.payment_request.payment.network, "stellar_testnet");
  assert.equal(payment.payment_request.payment.amount, "0.1");
  assert.equal(Object.hasOwn(payment.payment_request.metadata, "food_order"), false);

  response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: `velarumpay-connect:ck_${"C".repeat(43)}` })
  });
  assert.equal(response.status, 201);
  const publicConnect = await response.json();
  assert.equal(publicConnect.type, "connect_started");
  assert.equal(Object.hasOwn(publicConnect.connection, "connection_token"), false);

  response = await fetch(`${base}/api/connect/${publicConnect.session_id}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).connection.connected, true);

  response = await fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: publicConnect.session_id,
      client_request_id: "browserrequest0001",
      merchant_id: "green-bowl",
      items: [{ item_id: "garden-bowl", quantity: 1 }]
    })
  });
  assert.equal(response.status, 201);
  const publicOrder = await response.json();

  response = await fetch(`${base}/api/orders/${publicOrder.order.order_id}/payment-request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: publicConnect.session_id })
  });
  assert.equal(response.status, 201);
  const publicPayment = await response.json();
  assert.equal(publicPayment.payment_request.payment.network, "stellar_testnet");
  assert.equal(publicPayment.payment_request.payment.amount, "0.1");

  const rawEvent = Buffer.from(JSON.stringify({ event_id: "event_agentfood_1", type: "payment_request.status_updated", data: {} }));
  const signature = signWebhookPayload(WEBHOOK_SECRET, String(Math.floor(Date.now() / 1000)), rawEvent);
  response = await fetch(`${base}/v1/webhooks/velarumpay`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-velarumpay-signature": signature },
    body: rawEvent
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).duplicate, false);
});

test("site-only HTTP surface serves the production UI and mock recommendations", {
  skip: process.env.VP_ALLOW_LISTEN_TESTS !== "1"
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentfood-site-"));
  const config = validConfig({
    AGENTFOOD_SITE_ONLY: "true",
    AGENTFOOD_STELLAR_TESTNET_ENABLED: "false",
    AGENTFOOD_AGENT_CREDENTIAL_KID: "",
    AGENTFOOD_AGENT_CREDENTIAL_PRIVATE_KEY_PKCS8_B64: "",
    AGENTFOOD_WEBHOOK_SECRET: "",
    AGENTFOOD_RECIPIENT_ID: "",
    AGENTFOOD_RECIPIENT_VERSION_ID: "",
    AGENTFOOD_STORE_PATH: path.join(dir, "store.json")
  });
  const server = createAgentFoodServer({ config, store: new AgentFoodStore(config.storePath), platformClient: null });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  const home = await response.text();
  assert.match(home, /Real testnet payment flow/);
  assert.match(home, /Open testnet/);
  assert.match(home, /No sign-in required/);
  assert.match(home, /Enter to send/);
  assert.doesNotMatch(home, /<span class="identity-mark" aria-hidden="true">G<\/span>/);

  response = await fetch(`${base}/api/catalog`);
  const catalog = await response.json();
  assert.equal(catalog.payment_ready, false);
  assert.equal(catalog.hosting_mode, "production_site_only");
  assert.equal(catalog.merchants.length, 3);

  response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "spicy vegetarian under 20 credits" })
  });
  const chat = await response.json();
  assert.equal(response.status, 200);
  assert.equal(chat.type, "mock_recommendation");
  assert.equal(chat.order.currency, "MOCK_CREDITS");

  response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: `velarumpay-connect:ck_${"B".repeat(43)}` })
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "wallet_connection_unavailable");
});
