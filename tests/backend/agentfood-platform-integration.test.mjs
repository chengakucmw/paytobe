import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { loadConfig } from "../../services/agentfood/src/config.mjs";
import { createAgentCredentialSigner, PlatformClient } from "../../services/agentfood/src/platform-client.mjs";
import { createAgentFoodServer } from "../../services/agentfood/src/server.mjs";
import { AgentFoodStore } from "../../services/agentfood/src/store.mjs";

const RECIPIENT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const API_KEY = "agentfood-platform-integration-api-key-0001";
const WEBHOOK_SECRET = "whsec_agentfood_platform_integration_0001";

test("AgentFood D1 migration is additive, rerunnable, and preserves auditable ID mappings", () => {
  const db = new DatabaseSync(":memory:");
  const migrationRoot = path.resolve(import.meta.dirname, "../../services/platform-api/edge-testnet/drizzle");
  for (const name of [
    "0000_multitenant_connect_platform.sql",
    "0001_agentfood_registered_integration.sql",
    "0002_merchant_tenant_control_plane.sql",
    "0003_agentfood_standard_merchant.sql",
    "0003_agentfood_standard_merchant.sql"
  ]) db.exec(fs.readFileSync(path.join(migrationRoot, name), "utf8"));
  assert.equal(db.prepare("SELECT count(*) AS count FROM recipients WHERE merchant_id = 'agentfood'").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM recipient_versions WHERE recipient_id = 'agentfood-reference-recipient'").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM legacy_resource_mappings WHERE source_system = 'agentfood_legacy'").get().count, 5);
  assert.equal(db.prepare("SELECT verification_state FROM merchants WHERE merchant_id = 'agentfood'").get().verification_state, "verified");
  assert.equal(db.prepare("SELECT migration_state FROM legacy_resource_mappings WHERE source_resource_type = 'shared_token_auth'").get().migration_state, "provisioning_required");
  db.close();
});

test("independent AgentFood creates a Recipient-bound testnet request through Platform API", {
  skip: process.env.VP_ALLOW_LISTEN_TESTS !== "1"
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentfood-platform-e2e-"));
  process.env.VP_NO_AUTO_LISTEN = "1";
  process.env.NODE_ENV = "development";
  process.env.RUNTIME_ENV = "development";
  process.env.RELAY_STORE_DRIVER = "sqlite";
  process.env.RELAY_STORE_PATH = path.join(dir, "platform-store.sqlite");
  process.env.FCM_ENABLED = "false";
  process.env.STELLAR_PUBLIC_ENABLED = "false";
  process.env.DAILY_LIMIT_XLM = "1";

  const platformModule = await import(`../../services/platform-api/src/server.js?agentfood-e2e=${Date.now()}`);
  const keyPair = crypto.generateKeyPairSync("ed25519");
  seedStandardAgentFood(platformModule.store, keyPair.publicKey, "stellar_testnet");
  const platformServer = platformModule.server;
  await new Promise((resolve) => platformServer.listen(0, "127.0.0.1", resolve));
  const platformBase = `http://127.0.0.1:${platformServer.address().port}`;

  const wallet = { device_id: "wallet_agentfood_e2e", token: "wallet-agentfood-e2e-token" };
  await expectStatus(platformBase, "/v1/devices/app", 200, {
    method: "POST",
    body: wallet
  });
  const invitation = await expectStatus(platformBase, "/v1/connect-invitations", 201, {
    method: "POST",
    body: wallet
  });
  const privateKey = keyPair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const configEnv = {
    AGENTFOOD_RUNTIME_ENV: "development",
    AGENTFOOD_API_KEY: API_KEY,
    AGENTFOOD_STORE_PATH: path.join(dir, "agentfood-store.json"),
    PLATFORM_API_URL: platformBase,
    AGENTFOOD_AGENT_ID: "agentfood-testnet",
    AGENTFOOD_AGENT_CLIENT_ID: "agentfood-production-service",
    AGENTFOOD_AGENT_CREDENTIAL_KID: "agentfood-reference-key",
    AGENTFOOD_AGENT_CREDENTIAL_PRIVATE_KEY_PKCS8_B64: privateKey,
    AGENTFOOD_WEBHOOK_SECRET: WEBHOOK_SECRET,
    AGENTFOOD_STELLAR_TESTNET_ENABLED: "true",
    AGENTFOOD_STELLAR_TESTNET_MAX_XLM: "1",
    AGENTFOOD_STELLAR_PAYMENT_AMOUNT_XLM: "0.1",
    AGENTFOOD_STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
    AGENTFOOD_RECIPIENT_ID: "agentfood-reference-recipient",
    AGENTFOOD_RECIPIENT_VERSION_ID: "agentfood-reference-recipient-v1",
    AGENTFOOD_PAYEE_NAME: "AgentFood integration recipient"
  };
  const agentFoodConfig = loadConfig(configEnv);
  const agentFoodServer = createAgentFoodServer({
    config: agentFoodConfig,
    store: new AgentFoodStore(agentFoodConfig.storePath),
    platformClient: new PlatformClient(agentFoodConfig.platform, {
      signer: createAgentCredentialSigner(configEnv)
    })
  });
  await new Promise((resolve) => agentFoodServer.listen(0, "127.0.0.1", resolve));
  const agentFoodBase = `http://127.0.0.1:${agentFoodServer.address().port}`;

  t.after(async () => {
    agentFoodServer.closeAllConnections?.();
    platformServer.closeAllConnections?.();
    await Promise.all([
      closeServer(agentFoodServer),
      closeServer(platformServer)
    ]);
    platformModule.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const anonymous = await expectStatus(platformBase, "/v1/connect-invitations/claim", 401, {
    method: "POST",
    body: { connect_key: invitation.connect_key, requested_scopes: ["payment.requests.create"] }
  });
  assert.equal(anonymous.error.code, "unauthenticated");

  let response = await fetch(`${agentFoodBase}/v1/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentfood-api-key": API_KEY },
    body: JSON.stringify({ connect_key: invitation.connect_key })
  });
  assert.equal(response.status, 201);
  const claimed = await response.json();
  assert.equal(claimed.connect_invitation.identity_assurance, "registered");
  assert.equal(claimed.pairing_session.agent_identity.agent_id, "agentfood-testnet");

  await expectStatus(platformBase, `/v1/connect-invitations/${claimed.connect_invitation.connect_invitation_id}/approve`, 201, {
    method: "POST",
    body: wallet
  });
  response = await fetch(`${agentFoodBase}/v1/connect/${claimed.connect_session.session_id}`, {
    headers: { "x-agentfood-api-key": API_KEY }
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).connect_session.connected, true);

  response = await fetch(`${agentFoodBase}/v1/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agentfood-api-key": API_KEY,
      "x-idempotency-key": "agentfood-platform-e2e-order-1"
    },
    body: JSON.stringify({
      connect_session_id: claimed.connect_session.session_id,
      merchant_id: "green-bowl",
      items: [{ item_id: "garden-bowl", quantity: 1 }]
    })
  });
  assert.equal(response.status, 201);
  const orderResult = await response.json();
  assert.equal(orderResult.order.mock_quote.currency, "MOCK_CREDITS");
  assert.equal(orderResult.order.settlement.amount, "0.1");

  response = await fetch(`${agentFoodBase}/v1/orders/${orderResult.order.order_id}/payment-request`, {
    method: "POST",
    headers: { "x-agentfood-api-key": API_KEY }
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.payment_request.payment.network, "stellar_testnet");
  assert.equal(created.payment_request.payment.amount, "0.1");
  assert.equal(created.payment_request.payment.to, RECIPIENT);
  assert.equal(created.payment_request.recipient_id, "agentfood-reference-recipient");
  assert.equal(created.payment_request.recipient_version_id, "agentfood-reference-recipient-v1");
  assert.equal(created.payment_request.risk.signing_allowed, true);
  assert.equal(Object.hasOwn(created.payment_request.metadata, "food_order"), false);
  assert.equal(created.order.platform_transaction_context.status, "awaiting_payment");

  response = await fetch(`${agentFoodBase}/v1/orders/${orderResult.order.order_id}/payment-request`, {
    method: "POST",
    headers: { "x-agentfood-api-key": API_KEY }
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).duplicate, true);
  assert.equal(platformModule.store.db.prepare("SELECT count(*) AS count FROM recipients WHERE merchant_id = 'agentfood'").get().count, 1);
  assert.equal(Object.keys(platformModule.store.state.connections).length, 1);
  assert.equal(Object.keys(platformModule.store.state.paymentRequests).length, 1);

  response = await fetch(`${platformBase}/v1/payment-requests`, {
    headers: {
      "x-app-device-id": wallet.device_id,
      "x-app-device-token": wallet.token
    }
  });
  assert.equal(response.status, 200);
  const inbox = await response.json();
  assert.deepEqual(inbox.items.map((item) => item.request_id), [created.payment_request.request_id]);
  assert.equal(inbox.items[0].risk.signing_allowed, true);
});

function seedStandardAgentFood(platformStore, publicKey, network) {
  const now = new Date().toISOString();
  const publicKeyX = publicKey.export({ format: "jwk" }).x;
  platformStore.db.prepare(`INSERT INTO merchants
    (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
    VALUES ('agentfood', 'AgentFood', 'active', 'verified', 1, ?, ?)`)
    .run(now, now);
  platformStore.db.prepare(`INSERT INTO agents
    (agent_id, merchant_id, name, runtime, environment, allowed_scopes_json, token_revocation_version,
     status, version, created_at, updated_at)
    VALUES ('agentfood-testnet', 'agentfood', 'AgentFood Reference Agent', 'node', 'testnet', ?, 0,
      'active', 1, ?, ?)`)
    .run(JSON.stringify([
      "payment.requests.create", "payment.requests.read",
      "transaction_contexts.create", "transaction_contexts.read"
    ]), now, now);
  platformStore.db.prepare(`INSERT INTO agent_credentials
    (credential_id, merchant_id, agent_id, kid, alg, public_key, status, not_before, expires_at,
     revocation_version, version, created_at, updated_at)
    VALUES ('agentfood-reference-credential', 'agentfood', 'agentfood-testnet', 'agentfood-reference-key',
      'Ed25519', ?, 'active', ?, ?, 0, 1, ?, ?)`)
    .run(publicKeyX, new Date(Date.now() - 1_000).toISOString(), new Date(Date.now() + 86_400_000).toISOString(), now, now);
  platformStore.db.prepare(`INSERT INTO recipients
    (recipient_id, merchant_id, name, status, active_version_id, version, created_at, updated_at)
    VALUES ('agentfood-reference-recipient', 'agentfood', 'AgentFood Integration Recipient', 'active',
      'agentfood-reference-recipient-v1', 1, ?, ?)`)
    .run(now, now);
  platformStore.db.prepare(`INSERT INTO recipient_versions
    (recipient_version_id, merchant_id, recipient_id, network, asset, address, memo, verification_state,
     effective_at, created_at)
    VALUES ('agentfood-reference-recipient-v1', 'agentfood', 'agentfood-reference-recipient', ?, 'XLM', ?, NULL,
      'active', ?, ?)`)
    .run(network, RECIPIENT, now, now);
}

async function expectStatus(base, pathname, expectedStatus, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method: options.method || "GET",
    signal: AbortSignal.timeout(5_000),
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const result = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(result));
  return result;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}
