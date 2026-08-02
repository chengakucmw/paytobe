import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestWorker } from "../src/worker.mjs";

const adminToken = "admin_test_token_1234567890";
const agentFoodToken = "agentfood_test_token_1234567890";
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

test("the legacy AgentFood web integration stays functional and fully metered during observation", async (t) => {
  const origin = "https://agentfood-velarumpay-demo.chengakucmw.chatgpt.site";
  const metrics = [];
  const logs = [];
  const originalWarn = console.warn;
  console.warn = (message) => logs.push(JSON.parse(String(message)));
  t.after(() => { console.warn = originalWarn; });
  const worker = createTestWorker({
    AGENTFOOD_WEB_ORIGIN: origin,
    AGENTFOOD_LEGACY_METRICS: { writeDataPoint: (value) => metrics.push(value) }
  });
  const denied = await api(worker, "/v1/integrations/agentfood/chat", {
    method: "POST", headers: { origin: "https://untrusted.example" }, payload: { message: "probe" }
  });
  assert.equal(denied.status, 403);
  const device = await registerDevice(worker, "agentfood-web");
  const created = await createKey(worker, device);
  const claimed = await api(worker, "/v1/integrations/agentfood/chat", {
    method: "POST", headers: { origin }, payload: { message: created.connect_key }
  });
  assert.equal(claimed.status, 201);
  assert.equal(claimed.body.connect_invitation.identity_assurance, "registered");
  assert.equal(claimed.body.connect_invitation.agent_identity.agent_name, "AgentFood");
  await approve(worker, device, claimed.body);
  const exchanged = await api(worker, "/v1/integrations/agentfood/connect", {
    method: "POST", headers: { origin }, payload: { connect_invitation_id: claimed.body.connect_invitation_id, claim_token: claimed.body.claim_token }
  });
  assert.equal(exchanged.status, 200);
  const ordered = await api(worker, "/v1/integrations/agentfood/chat", {
    method: "POST", headers: { origin }, payload: { message: "vegetarian dinner under 15", connection_token: exchanged.body.connection.connection_token }
  });
  assert.equal(ordered.status, 201);
  assert.equal(ordered.body.payment_request.payment.network, "stellar_testnet");
  const inbox = await api(worker, `/v1/payment-requests?device_id=${encodeURIComponent(device.device_id)}&token=${encodeURIComponent(device.token)}`);
  assert.deepEqual(inbox.body.items.map((item) => item.request_id), [ordered.body.payment_request.request_id]);
  assert.equal(metrics.length, 4);
  assert.equal(logs.length, 4);
  assert.deepEqual(new Set(logs.map((entry) => entry.route)), new Set([
    "/v1/integrations/agentfood/chat",
    "/v1/integrations/agentfood/connect"
  ]));
  assert.ok(logs.some((entry) => entry.classification === "untrusted_origin_dedicated_route" && entry.response_status === 403));
  assert.ok(logs.filter((entry) => entry.classification === "allowed_origin_dedicated_route").length === 3);
  assert.ok(logs.every((entry) => entry.event === "agentfood.legacy_path_attempt" && entry.schema_version === 1));
});

test("the legacy AgentFood shared client token is isolated to a metered compatibility path", async (t) => {
  const metrics = [];
  const logs = [];
  const originalWarn = console.warn;
  console.warn = (message) => logs.push(JSON.parse(String(message)));
  t.after(() => { console.warn = originalWarn; });
  const worker = createTestWorker({
    AGENTFOOD_CLIENT_TOKEN: agentFoodToken,
    AGENTFOOD_LEGACY_METRICS: { writeDataPoint: (value) => metrics.push(value) }
  });
  const device = await registerDevice(worker, "legacy-token");
  const created = await createKey(worker, device);
  const claimed = await api(worker, "/v1/connect-invitations/claim", {
    method: "POST",
    token: agentFoodToken,
    payload: { connect_key: created.connect_key, requested_scopes: ["payment.requests.read"] }
  });
  assert.equal(claimed.status, 201);
  assert.equal(metrics.length, 1);
  assert.equal(logs.length, 1);
  assert.deepEqual({
    event: logs[0].event,
    surface: logs[0].surface,
    classification: logs[0].classification,
    route: logs[0].route
  }, {
    event: "agentfood.legacy_path_attempt",
    surface: "connect_platform_edge_testnet",
    classification: "authenticated_shared_token",
    route: "/v1/connect-invitations/claim"
  });
  assert.doesNotMatch(JSON.stringify(logs[0]), new RegExp(agentFoodToken));
});
