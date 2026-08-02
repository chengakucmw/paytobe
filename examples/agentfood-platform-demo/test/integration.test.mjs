import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const storeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agentfood-integration-"));
process.env.VP_NO_AUTO_LISTEN = "1";
process.env.RELAY_STORE_DRIVER = "sqlite";
process.env.RELAY_STORE_PATH = path.join(storeDirectory, "relay-store.sqlite");

const { VelarumPayClient } = await import("../../../packages/sdk-js/src/index.js");
const { server: platformServer, store } = await import("../../../services/platform-api/src/server.js");
const keyPair = crypto.generateKeyPairSync("ed25519");
seedStandardAgentFood(store, keyPair.publicKey);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function jsonRequest(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(5_000),
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  return { response, body };
}

test("AgentFood claims a Connect Key and pushes a wallet-bound Payment Request", async (t) => {
  const platformBase = await listen(platformServer);
  process.env.VELARUMPAY_API_URL = platformBase;
  const { createDemoServer } = await import(`../server.mjs?integration=${Date.now()}`);
  const platformClient = new VelarumPayClient({
    baseUrl: platformBase,
    agentAuth: {
      agentId: "agentfood-testnet",
      clientId: "agentfood-reference-demo",
      kid: "agentfood-reference-key",
      scopes: [
        "payment.requests.create",
        "payment.requests.read",
        "transaction_contexts.create",
        "transaction_contexts.read"
      ],
      signer: ({ data }) => crypto.sign(null, Buffer.from(data), keyPair.privateKey).toString("base64url")
    }
  });
  const demoServer = createDemoServer({ platformClient });
  const demoBase = await listen(demoServer);
  t.after(async () => {
    await close(demoServer);
    await close(platformServer);
  });

  const wallet = { device_id: "agentfood_wallet", token: "agentfood-wallet-token" };
  const registered = await jsonRequest(platformBase, "/v1/devices/app", {
    method: "POST",
    body: JSON.stringify(wallet)
  });
  assert.equal(registered.response.status, 200);

  const created = await jsonRequest(platformBase, "/v1/connect-invitations", {
    method: "POST",
    body: JSON.stringify(wallet)
  });
  assert.equal(created.response.status, 201);

  const connectedChat = await jsonRequest(demoBase, "/api/chat", {
    method: "POST",
    body: JSON.stringify({ message: `Use ${created.body.connect_key}` })
  });
  assert.equal(connectedChat.response.status, 201);
  assert.equal(connectedChat.body.type, "connect_invitation_claimed");

  const approved = await jsonRequest(
    platformBase,
    `/v1/pairing/sessions/${connectedChat.body.pairing_session.pairing_session_id}/approve`,
    {
      method: "POST",
      body: JSON.stringify({
        ...wallet,
        approved_scopes: [
          "payment.requests.create",
          "payment.requests.read",
          "transaction_contexts.create",
          "transaction_contexts.read"
        ]
      })
    }
  );
  assert.equal(approved.response.status, 201);

  const connection = await jsonRequest(demoBase, `/api/connect/${connectedChat.body.session_id}`);
  assert.equal(connection.response.status, 200);
  assert.equal(connection.body.connection.connected, true);

  const order = await jsonRequest(demoBase, "/api/chat", {
    method: "POST",
    body: JSON.stringify({
      session_id: connectedChat.body.session_id,
      preferred_merchant_id: "noodle-atelier",
      message: "I want spicy noodles under 18 XLM"
    })
  });
  assert.equal(order.response.status, 201, JSON.stringify(order.body));
  assert.equal(order.body.type, "payment_request_created");
  assert.equal(order.body.order.merchant.id, "noodle-atelier");
  assert.equal(order.body.payment_request.status, "pending");
  assert.equal(order.body.payment_request.recipient_id, "agentfood-reference-recipient");
  assert.equal(Object.hasOwn(order.body.payment_request.metadata, "food_order"), false);
  assert.equal(order.body.transaction_context.metadata.food_order.demo, true);

  const inbox = await jsonRequest(
    platformBase,
    `/v1/payment-requests?device_id=${encodeURIComponent(wallet.device_id)}&token=${encodeURIComponent(wallet.token)}`
  );
  assert.equal(inbox.response.status, 200);
  assert.ok(inbox.body.items.some((item) => item.request_id === order.body.payment_request.request_id));
  assert.equal(inbox.body.items[0].payment.network, "stellar_testnet");
  assert.equal(inbox.body.items[0].policy.requires_user_approval, true);
});

function seedStandardAgentFood(platformStore, publicKey) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const x = publicKey.export({ format: "jwk" }).x;
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
    .run(x, new Date(Date.now() - 1_000).toISOString(), expiresAt, now, now);
  platformStore.db.prepare(`INSERT INTO recipients
    (recipient_id, merchant_id, name, status, active_version_id, version, created_at, updated_at)
    VALUES ('agentfood-reference-recipient', 'agentfood', 'AgentFood Reference Recipient', 'active',
      'agentfood-reference-recipient-v1', 1, ?, ?)`)
    .run(now, now);
  platformStore.db.prepare(`INSERT INTO recipient_versions
    (recipient_version_id, merchant_id, recipient_id, network, asset, address, memo, verification_state,
     effective_at, created_at)
    VALUES ('agentfood-reference-recipient-v1', 'agentfood', 'agentfood-reference-recipient',
      'stellar_testnet', 'XLM', 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', NULL,
      'active', ?, ?)`)
    .run(now, now);
}
