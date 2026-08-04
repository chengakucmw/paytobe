import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestWorker } from "../src/worker.mjs";

const adminToken = "admin_test_token_1234567890";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function api(worker, path, { method = "GET", token = "", headers = {}, payload } = {}) {
  return worker.fetch(new Request(`https://connect.test${path}`, {
    method,
    headers: {
      ...(payload ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  })).then(async (response) => ({ status: response.status, body: await response.json() }));
}

async function registerDevice(worker, suffix) {
  const device = { device_id: `android-${suffix}`, token: `awt_${suffix}_12345678901234567890` };
  const response = await api(worker, "/v1/devices/app", { method: "POST", payload: device });
  assert.equal(response.status, 200);
  return device;
}

async function createKey(worker, device) {
  const response = await api(worker, "/v1/connect-invitations", { method: "POST", payload: { ...device, expires_in_seconds: 300 } });
  assert.equal(response.status, 201);
  assert.match(response.body.connect_key, /^velarumpay-connect:ck_[A-Za-z0-9_-]{43}$/);
  return response.body;
}

async function registerAgentClient(worker, suffix, displayName = `Merchant ${suffix} Agent`) {
  const response = await api(worker, "/v1/admin/agent-clients", {
    method: "POST",
    token: adminToken,
    payload: {
      tenant_id: `merchant-${suffix}`,
      tenant_name: `Merchant ${suffix}`,
      agent_name: displayName,
      runtime: "node",
      source_domain: `merchant-${suffix}.example`
    }
  });
  assert.equal(response.status, 201);
  assert.match(response.body.client_token, /^agent_/);
  return response.body;
}

async function approve(worker, device, claimed) {
  const response = await api(worker, `/v1/pairing/sessions/${claimed.pairing_session.pairing_session_id}/approve`, {
    method: "POST",
    payload: { ...device, approved_scopes: claimed.connect_invitation.requested_scopes }
  });
  assert.equal(response.status, 201);
  return response.body;
}

async function exchange(worker, invitationId, claimToken) {
  const response = await api(worker, `/v1/connect-invitations/${invitationId}/exchange`, { method: "POST", token: claimToken, payload: {} });
  assert.equal(response.status, 200);
  return response.body.connection;
}

test("the live smoke exercises AgentFood's standard hosted API instead of dedicated Platform routes", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "live-smoke.mjs"), "utf8");
  assert.doesNotMatch(source, /\/v1\/integrations\/agentfood/);
  assert.match(source, /request\(agentFood, "\/api\/chat"/);
  assert.match(source, /request\(agentFood, "\/api\/connect"/);
});

test("controlled public webhook receivers verify ownership and HMAC without logging secrets or payloads", async (t) => {
  const challenge = "whv_test_receiver_a_ownership";
  const secret = "whsec_test_receiver_a_signing_secret";
  const payload = JSON.stringify({ version: "velarum.webhook_event.v1", type: "payment_request.status_updated", private_note: "never log this" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `t=${timestamp},v1=${crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(payload).digest("hex")}`;
  const logs = [];
  const originalInfo = console.info;
  console.info = (message) => logs.push(String(message));
  t.after(() => { console.info = originalInfo; });
  const worker = createTestWorker({ WEBHOOK_A_OWNERSHIP_CHALLENGE: challenge, WEBHOOK_A_SECRET: secret });

  const ownership = await worker.fetch(new Request("https://connect.test/testing/webhooks/merchant-a?velarumpay_challenge=1"));
  assert.equal(ownership.status, 200);
  assert.deepEqual(await ownership.json(), { challenge });

  const delivered = await worker.fetch(new Request("https://connect.test/testing/webhooks/merchant-a", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-velarumpay-event-id": "event_receiver_a",
      "x-velarumpay-delivery-id": "delivery_receiver_a",
      "x-velarumpay-signature": signature
    },
    body: payload
  }));
  assert.equal(delivered.status, 204);
  assert.equal(logs.length, 1);
  assert.equal(JSON.parse(logs[0]).signature_valid, true);
  assert.equal(logs[0].includes(secret), false);
  assert.equal(logs[0].includes("never log this"), false);

  const rejected = await worker.fetch(new Request("https://connect.test/testing/webhooks/merchant-a", {
    method: "POST",
    headers: { "content-type": "application/json", "x-velarumpay-signature": `t=${timestamp},v1=${"0".repeat(64)}` },
    body: payload
  }));
  assert.equal(rejected.status, 401);
});

test("registered tenants claim opaque Connect Keys without self-declared identity", async () => {
  const worker = createTestWorker({ PLATFORM_ADMIN_TOKEN: adminToken });
  const registered = await registerAgentClient(worker, "one", "Merchant One Agent");
  const device = await registerDevice(worker, "alice");
  const created = await createKey(worker, device);

  const unauthenticated = await api(worker, "/v1/connect-invitations/claim", {
    method: "POST",
    payload: { connect_key: created.connect_key, agent_identity: { agent_name: "Impostor" } }
  });
  assert.equal(unauthenticated.status, 401);

  const claimed = await api(worker, "/v1/connect-invitations/claim", {
    method: "POST",
    token: registered.client_token,
    payload: {
      connect_key: created.connect_key,
      requested_scopes: ["payment.requests.create", "payment.requests.read"]
    }
  });
  assert.equal(claimed.status, 201);
  assert.equal(claimed.body.connect_invitation.agent_identity.agent_name, "Merchant One Agent");
  assert.equal(claimed.body.connect_invitation.agent_identity.verified, true);
  assert.equal(claimed.body.connect_invitation.identity_assurance, "registered");

  const forgedKey = await createKey(worker, device);
  const forged = await api(worker, "/v1/connect-invitations/claim", {
    method: "POST",
    token: registered.client_token,
    payload: { connect_key: forgedKey.connect_key, merchant_id: "other", agent_identity: { agent_name: "Impostor" } }
  });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error.code, "self_declared_identity_forbidden");

  const replay = await api(worker, "/v1/connect-invitations/claim", { method: "POST", token: registered.client_token, payload: { connect_key: created.connect_key } });
  assert.equal(replay.status, 409);
});

test("multiple merchants and devices remain tenant- and device-isolated", async () => {
  const worker = createTestWorker({ PLATFORM_ADMIN_TOKEN: adminToken });
  const merchantOne = await registerAgentClient(worker, "one", "Merchant One Agent");
  const alice = await registerDevice(worker, "alice");
  const bob = await registerDevice(worker, "bob");

  const merchant = await api(worker, "/v1/admin/agent-clients", {
    method: "POST",
    token: adminToken,
    payload: { tenant_id: "market-two", tenant_name: "Market Two", agent_name: "Market Two Agent", runtime: "node", source_domain: "market-two.example" }
  });
  assert.equal(merchant.status, 201);
  assert.match(merchant.body.client_token, /^agent_/);

  const aliceKey = await createKey(worker, alice);
  const bobKey = await createKey(worker, bob);
  const aliceClaim = await api(worker, "/v1/connect-invitations/claim", { method: "POST", token: merchantOne.client_token, payload: { connect_key: aliceKey.connect_key, requested_scopes: ["payment.requests.create", "payment.requests.read"] } });
  const bobClaim = await api(worker, "/v1/connect-invitations/claim", { method: "POST", token: merchant.body.client_token, payload: { connect_key: bobKey.connect_key, requested_scopes: ["payment.requests.create", "payment.requests.read"] } });
  assert.equal(aliceClaim.status, 201);
  assert.equal(bobClaim.status, 201);
  assert.equal(aliceClaim.body.identity.tenant_id, "merchant-one");
  assert.equal(bobClaim.body.identity.tenant_id, "market-two");

  const crossDevice = await api(worker, `/v1/pairing/sessions/${bobClaim.body.pairing_session.pairing_session_id}/approve`, { method: "POST", payload: { ...alice, approved_scopes: bobClaim.body.connect_invitation.requested_scopes } });
  assert.equal(crossDevice.status, 403);

  await approve(worker, alice, aliceClaim.body);
  await approve(worker, bob, bobClaim.body);
  const aliceConnection = await exchange(worker, aliceClaim.body.connect_invitation.connect_invitation_id, aliceClaim.body.claim_token);
  const bobConnection = await exchange(worker, bobClaim.body.connect_invitation.connect_invitation_id, bobClaim.body.claim_token);

  const payment = {
    protocol: "velarum.payment_request.v1",
    request_id: "prq_alice_1",
    idempotency_key: "alice-order-1",
    created_at: new Date().toISOString(),
    status: "pending",
    policy: { requires_user_approval: true },
    payment: { rail: "stellar_xlm", network: "stellar_testnet", stellar_testnet: true, asset: "XLM", amount: "1.25", to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" }
  };
  const createdPayment = await api(worker, "/v1/payment-requests", { method: "POST", token: aliceConnection.connection_token, payload: payment });
  assert.equal(createdPayment.status, 201);

  const aliceInbox = await api(worker, `/v1/payment-requests?device_id=${encodeURIComponent(alice.device_id)}&token=${encodeURIComponent(alice.token)}`);
  const bobInbox = await api(worker, `/v1/payment-requests?device_id=${encodeURIComponent(bob.device_id)}&token=${encodeURIComponent(bob.token)}`);
  assert.deepEqual(aliceInbox.body.items.map((item) => item.request_id), ["prq_alice_1"]);
  assert.deepEqual(bobInbox.body.items, []);

  const wrongTenantToken = await api(worker, "/v1/payment-requests", { method: "POST", token: bobConnection.connection_token, payload: { ...payment, request_id: "prq_bob_1", idempotency_key: "bob-order-1" } });
  assert.equal(wrongTenantToken.status, 201);
  const bobInboxAfter = await api(worker, `/v1/payment-requests?device_id=${encodeURIComponent(bob.device_id)}&token=${encodeURIComponent(bob.token)}`);
  assert.deepEqual(bobInboxAfter.body.items.map((item) => item.request_id), ["prq_bob_1"]);
});

test("testnet platform rejects mainnet and supports wallet revocation", async () => {
  const worker = createTestWorker({ PLATFORM_ADMIN_TOKEN: adminToken });
  const registered = await registerAgentClient(worker, "carol", "Carol Merchant Agent");
  const device = await registerDevice(worker, "carol");
  const created = await createKey(worker, device);
  const claimed = await api(worker, "/v1/connect-invitations/claim", { method: "POST", token: registered.client_token, payload: { connect_key: created.connect_key, requested_scopes: ["payment.requests.create"] } });
  const approved = await approve(worker, device, claimed.body);
  const connection = await exchange(worker, claimed.body.connect_invitation.connect_invitation_id, claimed.body.claim_token);

  const mainnet = await api(worker, "/v1/payment-requests", {
    method: "POST", token: connection.connection_token,
    payload: { protocol: "velarum.payment_request.v1", request_id: "mainnet", idempotency_key: "mainnet", policy: { requires_user_approval: true }, payment: { rail: "stellar_xlm", network: "stellar_public", stellar_testnet: false, amount: "1" } }
  });
  assert.equal(mainnet.status, 400);
  assert.equal(mainnet.body.error.code, "testnet_only");

  const revoked = await api(worker, `/v1/connections/${approved.connection.connection_id}`, { method: "DELETE", payload: device });
  assert.equal(revoked.status, 200);
  const afterRevoke = await api(worker, "/v1/payment-requests", {
    method: "POST", token: connection.connection_token,
    payload: { protocol: "velarum.payment_request.v1", request_id: "revoked", idempotency_key: "revoked", policy: { requires_user_approval: true }, payment: { rail: "stellar_xlm", network: "stellar_testnet", stellar_testnet: true, amount: "1" } }
  });
  assert.equal(afterRevoke.status, 401);
});

test("legacy AgentFood routes and shared-token authentication are removed", async () => {
  const retiredToken = "agentfood_test_token_1234567890";
  const worker = createTestWorker({ AGENTFOOD_CLIENT_TOKEN: retiredToken });
  for (const path of ["/v1/integrations/agentfood/chat", "/v1/integrations/agentfood/connect"]) {
    const response = await api(worker, path, { method: "POST", payload: {} });
    assert.equal(response.status, 404, path);
    assert.equal(response.body.error.code, "not_found", path);
  }

  const device = await registerDevice(worker, "retired-token");
  const created = await createKey(worker, device);
  const claim = await api(worker, "/v1/connect-invitations/claim", {
    method: "POST",
    token: retiredToken,
    payload: { connect_key: created.connect_key, requested_scopes: ["payment.requests.read"] }
  });
  assert.equal(claim.status, 401);
  assert.equal(claim.body.error.code, "agent_client_auth_required");

  const source = fs.readFileSync(path.join(root, "src", "worker.mjs"), "utf8");
  assert.doesNotMatch(source, /AGENTFOOD_CLIENT_TOKEN|AGENTFOOD_WEB_ORIGIN|AGENTFOOD_LEGACY_METRICS/);
  assert.doesNotMatch(source, /\/v1\/integrations\/agentfood/);
});
