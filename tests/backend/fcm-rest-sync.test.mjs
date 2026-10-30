import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildFcmDataMessage,
  createFcmPushService,
  createPushTokenVault
} from "../../services/platform-api/src/push/fcm.js";
import { loadRuntimeConfig, validateRuntimeConfig } from "../../services/platform-api/src/security.js";
import { Store } from "../../services/platform-api/src/store.js";

const TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");

test("FCM token vault encrypts at rest and binds ciphertext to its device", () => {
  const vault = createPushTokenVault(TOKEN_KEY);
  const plaintext = "fcm-registration-token-with-enough-entropy";
  const encrypted = vault.encrypt(plaintext, "device-a");

  assert.equal(vault.decrypt(encrypted, "device-a"), plaintext);
  assert.equal(JSON.stringify(encrypted).includes(plaintext), false, "plaintext must not appear in persisted ciphertext");
  assert.throws(() => vault.decrypt(encrypted, "device-b"), /authenticate|Unsupported|unable/i);
});

test("FCM data message carries only opaque sync coordinates", () => {
  const payload = buildFcmDataMessage("fcm-registration-token", {
    event_id: "cinv_opaque_456",
    request_id: "prq_opaque_123",
    event_seq: 42,
    amount: "999",
    recipient: "GSECRET",
    memo: "sensitive",
    status: "pending"
  });
  const data = payload.message.data;

  assert.deepEqual(data, {
    type: "Paytobe.sync",
    sync_required: "true",
    event_id: "cinv_opaque_456",
    request_id: "prq_opaque_123",
    event_seq: "42"
  });
  assert.equal(JSON.stringify(data).includes("999"), false);
  assert.equal(JSON.stringify(data).includes("GSECRET"), false);
  assert.equal(payload.message.android.priority, "high");
});

test("production config fails closed unless the complete FCM secret set is present", () => {
  const missing = validateRuntimeConfig(loadRuntimeConfig({
    NODE_ENV: "production",
    RUNTIME_ENV: "production",
    OPENCLAW_DEVICE_SECRET: "strong-openclaw-secret",
    CORS_ALLOWED_ORIGINS: "https://wallet.example.com",
    RELAY_STORE_PATH: "/var/lib/Paytobe/relay.sqlite",
    METRICS_TOKEN: "metrics-secret"
  }));
  assert.equal(missing.ok, false);
  assert(missing.errors.some((error) => error.includes("FCM_ENABLED")));

  const malformedKey = validateRuntimeConfig(loadRuntimeConfig({
    FCM_ENABLED: "true",
    FCM_PROJECT_ID: "Paytobe-prod",
    FCM_SERVICE_ACCOUNT_JSON: "{}",
    FCM_TOKEN_ENCRYPTION_KEY: "too-short"
  }));
  assert.equal(malformedKey.ok, false);
  assert(malformedKey.errors.some((error) => error.includes("exactly 32 bytes")));
});

test("an UNREGISTERED response invalidates only the matching encrypted FCM token", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Paytobe-fcm-invalid-"));
  const store = new Store(path.join(dir, "store.json"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  store.registerDevice("device-fcm", "device-auth-token");
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serviceAccount = {
    client_email: "fcm-test@Paytobe.example",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" })
  };
  const config = loadRuntimeConfig({
    FCM_ENABLED: "true",
    FCM_PROJECT_ID: "Paytobe-test",
    FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount),
    FCM_TOKEN_ENCRYPTION_KEY: TOKEN_KEY
  });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({
      error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] }
    }), { status: 404 });
  };
  const service = createFcmPushService({
    config,
    store,
    observability: { recordAuditEvent() {} },
    fetchImpl
  });
  const registrationToken = "fcm-registration-token-that-is-now-invalid";
  store.setDevicePushToken("device-fcm", {
    token_hash: "sha256:matching",
    token_ciphertext: service.tokenVault.encrypt(registrationToken, "device-fcm")
  });

  service.notifyPaymentRequest("device-fcm", { request_id: "prq_1", event_seq: 9 });
  for (let attempt = 0; attempt < 50 && store.device("device-fcm").push.status === "active"; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(calls.length, 2, "OAuth and FCM endpoints were called once each");
  assert.equal(store.device("device-fcm").push.status, "inactive");
  assert.equal(store.device("device-fcm").push.token_ciphertext, undefined);
});

test("Connect Invitation push uses the same opaque wake-up channel", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Paytobe-fcm-connect-"));
  const store = new Store(path.join(dir, "store.json"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  store.registerDevice("device-connect", "device-auth-token");
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = loadRuntimeConfig({
    FCM_ENABLED: "true",
    FCM_PROJECT_ID: "Paytobe-test",
    FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: "fcm-connect@Paytobe.example",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" })
    }),
    FCM_TOKEN_ENCRYPTION_KEY: TOKEN_KEY
  });
  let delivered = null;
  const service = createFcmPushService({
    config,
    store,
    observability: { recordAuditEvent() {} },
    fetchImpl: async (url, options) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), { status: 200 });
      }
      delivered = JSON.parse(options.body);
      return new Response(JSON.stringify({ name: "messages/connect" }), { status: 200 });
    }
  });
  const token = "fcm-connect-registration-token-with-enough-entropy";
  store.setDevicePushToken("device-connect", {
    token_hash: "sha256:connect",
    token_ciphertext: service.tokenVault.encrypt(token, "device-connect")
  });

  service.notifyConnectInvitation("device-connect", { event_id: "cinv_opaque_456" });
  for (let attempt = 0; attempt < 50 && delivered === null; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(delivered.message.data.event_id, "cinv_opaque_456");
  assert.equal(delivered.message.data.type, "Paytobe.sync");
  assert.equal(Object.hasOwn(delivered.message.data, "agent_name"), false);
  assert.equal(Object.hasOwn(delivered.message.data, "requested_scopes"), false);
});

test("device event stream is isolated, cursor-based, and signals retention reset", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Paytobe-device-events-"));
  const store = new Store(path.join(dir, "store.json"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  store.registerDevice("wallet-a", "token-a");
  store.registerDevice("wallet-b", "token-b");
  store.putPaymentRequest({
    request_id: "prq_wallet_a",
    target_app_device_id: "wallet-a",
    connection_id: "conn-a",
    status: "pending",
    created_at: "2026-07-24T00:00:00.000Z"
  });
  store.putPaymentRequest({
    request_id: "prq_wallet_b",
    target_app_device_id: "wallet-b",
    connection_id: "conn-b",
    status: "pending",
    created_at: "2026-07-24T00:00:00.000Z"
  });

  const firstWindow = store.eventWindow(0);
  const walletA = store.paymentRequestEventsForDevice("wallet-a", 0);
  assert.deepEqual(walletA.map((event) => event.data.request_id), ["prq_wallet_a"]);
  assert.equal(store.paymentRequestEventsForDevice("wallet-b", 0).length, 1);
  assert.equal(store.paymentRequestEventsForDevice("wallet-a", firstWindow.latest_seq).length, 0);
  assert.equal(firstWindow.reset_required, false);

  for (let i = 0; i < 1001; i++) {
    store.event("payment_request.status", `prq_new_${i}`, {
      request_id: `prq_new_${i}`,
      target_app_device_id: "wallet-b",
      status: "pending"
    });
  }
  const expiredCursor = store.eventWindow(1);
  assert.equal(expiredCursor.reset_required, true);
  assert.ok(expiredCursor.oldest_retained_seq > 1);
});

test("HTTP push-token registration and device REST compensation use authenticated, isolated routes", {
  skip: process.env.VP_ALLOW_LISTEN_TESTS !== "1"
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Paytobe-fcm-http-"));
  const relayStore = path.join(dir, "relay-store.json");
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.VP_NO_AUTO_LISTEN = "1";
  process.env.NODE_ENV = "development";
  process.env.RUNTIME_ENV = "development";
  process.env.RELAY_STORE_DRIVER = "json";
  process.env.RELAY_STORE_PATH = relayStore;
  process.env.FCM_ENABLED = "true";
  process.env.FCM_PROJECT_ID = "Paytobe-http-test";
  process.env.FCM_TOKEN_ENCRYPTION_KEY = TOKEN_KEY;
  process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: "fcm-http-test@Paytobe.example",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" })
  });
  const module = await import(`../../services/platform-api/src/server.js?fcm-http=${Date.now()}`);
  const { server, store } = module;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const deviceId = "wallet-http";
  const deviceToken = "wallet-http-auth-token";
  let response = await fetch(`${base}/v1/devices/app`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: deviceId, token: deviceToken })
  });
  assert.equal(response.status, 200);

  const fcmToken = "fcm-http-registration-token-with-enough-entropy";
  response = await fetch(`${base}/v1/devices/app/${deviceId}/push-token`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_id: deviceId,
      token: deviceToken,
      provider: "fcm",
      push_token: fcmToken
    })
  });
  assert.equal(response.status, 200);
  const registration = await response.json();
  assert.equal(registration.device.push.status, "active");
  assert.equal(JSON.stringify(registration).includes(fcmToken), false);
  assert.equal(fs.readFileSync(relayStore, "utf8").includes(fcmToken), false, "FCM token must be encrypted in the durable store");

  store.putPaymentRequest({
    request_id: "prq_http_wallet",
    target_app_device_id: deviceId,
    connection_id: "conn-http",
    status: "pending",
    created_at: "2026-07-24T00:00:00.000Z"
  });
  response = await fetch(`${base}/v1/payment-requests/events?since=0`, {
    headers: {
      "x-app-device-id": deviceId,
      "x-app-device-token": deviceToken
    }
  });
  assert.equal(response.status, 200);
  const events = await response.json();
  assert.equal(events.reset_required, false);
  assert.deepEqual(events.items.map((event) => event.request_id), ["prq_http_wallet"]);
  assert.ok(events.latest_seq >= events.items[0].seq);

  response = await fetch(`${base}/v1/payment-requests/events?since=0`, {
    headers: {
      "x-app-device-id": deviceId,
      "x-app-device-token": "wrong-token"
    }
  });
  assert.equal(response.status, 401);
});
