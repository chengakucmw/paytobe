import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hmacHex, openClawCanonicalPayload } from "../../services/platform-api/src/crypto.js";
import {
  MemoryRateLimiter,
  ReplayGuard,
  isOriginAllowed,
  legacyUnsignedDecision,
  loadRuntimeConfig,
  validateRuntimeConfig,
  verifyOpenClawRequest
} from "../../services/platform-api/src/security.js";
import { Store } from "../../services/platform-api/src/store.js";

test("runtime config rejects unsafe production deployment settings", () => {
  const config = loadRuntimeConfig({
    NODE_ENV: "production",
    ALLOW_UNSIGNED_OPENCLAW: "true",
    OPENCLAW_DEVICE_SECRET: "change-me-openclaw-secret",
    RELAY_STORE_PATH: "data/relay-store.sqlite"
  });
  const validation = validateRuntimeConfig(config);

  assert.equal(validation.ok, false);
  assert(validation.errors.some((error) => error.includes("ALLOW_UNSIGNED_OPENCLAW")));
  assert(validation.errors.some((error) => error.includes("development placeholder")));
  assert(validation.errors.some((error) => error.includes("CORS_ALLOWED_ORIGINS")));
  assert(validation.errors.some((error) => error.includes("absolute durable path")));
  // B8: production must require a metrics token so /metrics is not publicly readable.
  assert(validation.errors.some((error) => error.includes("METRICS_TOKEN")));
});

test("CORS origin checks allow explicit and localhost origins only by default", () => {
  const config = loadRuntimeConfig({
    CORS_ALLOWED_ORIGINS: "https://wallet.example.com"
  });

  assert.equal(isOriginAllowed("https://wallet.example.com", config).ok, true);
  assert.equal(isOriginAllowed("http://localhost:5173", config).ok, true);
  assert.equal(isOriginAllowed("https://evil.example", config).ok, false);
  assert.equal(isOriginAllowed("", config).ok, true);
});

test("legacy unsigned OpenClaw mode is localhost-only", () => {
  const config = loadRuntimeConfig({ ALLOW_UNSIGNED_OPENCLAW: "true" });

  assert.equal(legacyUnsignedDecision(mockReq({ ip: "127.0.0.1" }), config).ok, true);
  assert.equal(legacyUnsignedDecision(mockReq({ ip: "::ffff:127.0.0.1" }), config).ok, true);
  assert.equal(legacyUnsignedDecision(mockReq({ ip: "203.0.113.9" }), config).ok, false);
});

test("OpenClaw HMAC verification accepts active and previous secrets", () => {
  const config = loadRuntimeConfig({
    OPENCLAW_DEVICE_SECRET: "active-secret",
    OPENCLAW_DEVICE_SECRET_PREVIOUS: "previous-secret"
  });
  const rawBody = JSON.stringify({ intent_id: "pi_rotation" });
  const now = 1_700_000_000_000;
  const sign = (secret, nonce) => {
    const timestamp = String(now);
    return {
      "x-timestamp": timestamp,
      "x-nonce": nonce,
      "x-signature": `sha256=${hmacHex(secret, openClawCanonicalPayload(timestamp, nonce, rawBody))}`
    };
  };

  assert.equal(verifyOpenClawRequest(mockReq({
    rawBody,
    headers: sign("active-secret", "nonce-active")
  }), config, { now, replayGuard: new ReplayGuard() }).ok, true);
  assert.equal(verifyOpenClawRequest(mockReq({
    rawBody,
    headers: sign("previous-secret", "nonce-previous")
  }), config, { now, replayGuard: new ReplayGuard() }).ok, true);
  assert.equal(verifyOpenClawRequest(mockReq({
    rawBody,
    headers: sign("wrong-secret", "nonce-wrong")
  }), config, { now, replayGuard: new ReplayGuard() }).status, 401);
});

test("OpenClaw signed requests must carry a timestamp and nonce", () => {
  const config = loadRuntimeConfig({ OPENCLAW_DEVICE_SECRET: "active-secret" });
  const rawBody = JSON.stringify({ intent_id: "pi_incomplete" });
  // Old-style signature over the body only, with no freshness headers.
  const result = verifyOpenClawRequest(mockReq({
    rawBody,
    headers: { "x-signature": `sha256=${hmacHex("active-secret", rawBody)}` }
  }), config, { replayGuard: new ReplayGuard() });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.code, "openclaw_signature_incomplete");
});

test("OpenClaw signatures outside the freshness window are rejected", () => {
  const config = loadRuntimeConfig({ OPENCLAW_DEVICE_SECRET: "active-secret" });
  const rawBody = JSON.stringify({ intent_id: "pi_stale" });
  const signedAt = 1_700_000_000_000;
  const timestamp = String(signedAt);
  const nonce = "nonce-stale";
  const headers = {
    "x-timestamp": timestamp,
    "x-nonce": nonce,
    "x-signature": `sha256=${hmacHex("active-secret", openClawCanonicalPayload(timestamp, nonce, rawBody))}`
  };
  const result = verifyOpenClawRequest(mockReq({ rawBody, headers }), config, {
    now: signedAt + 10 * 60_000, // default freshness window is 5 minutes
    replayGuard: new ReplayGuard()
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "openclaw_signature_expired");
});

test("OpenClaw nonce cannot be replayed within the window", () => {
  const config = loadRuntimeConfig({ OPENCLAW_DEVICE_SECRET: "active-secret" });
  const rawBody = JSON.stringify({ intent_id: "pi_replay" });
  const now = 1_700_000_000_000;
  const timestamp = String(now);
  const nonce = "nonce-replay";
  const headers = {
    "x-timestamp": timestamp,
    "x-nonce": nonce,
    "x-signature": `sha256=${hmacHex("active-secret", openClawCanonicalPayload(timestamp, nonce, rawBody))}`
  };
  const guard = new ReplayGuard();

  const first = verifyOpenClawRequest(mockReq({ rawBody, headers }), config, { now, replayGuard: guard });
  assert.equal(first.ok, true);

  const replay = verifyOpenClawRequest(mockReq({ rawBody, headers }), config, { now, replayGuard: guard });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "openclaw_replay_detected");
});

test("MemoryRateLimiter blocks requests over the configured window", () => {
  const limiter = new MemoryRateLimiter({ windowMs: 1000, max: 2 });

  assert.equal(limiter.consume("ip:route", 1000).allowed, true);
  assert.equal(limiter.consume("ip:route", 1100).allowed, true);
  assert.equal(limiter.consume("ip:route", 1200).allowed, false);
  assert.equal(limiter.consume("ip:route", 2101).allowed, true);
});

test("Store hashes app and connection tokens and supports rotation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "velarumpay-token-hardening-"));
  try {
    const store = new Store(path.join(dir, "store.json"));
    const device = store.registerDevice("device_hash", "device-token");

    assert.equal(device.token, "device-token");
    assert.equal(store.device("device_hash").token, undefined);
    assert.match(store.device("device_hash").token_hash, /^sha256:/);
    assert.equal(store.verifyDeviceToken("device_hash", "device-token"), true);
    assert.equal(store.verifyDeviceToken("device_hash", "wrong-token"), false);

    const rotatedDevice = store.rotateDeviceToken("device_hash", "device-token-2");
    assert.equal(rotatedDevice.token, "device-token-2");
    assert.equal(store.verifyDeviceToken("device_hash", "device-token"), false);
    assert.equal(store.verifyDeviceToken("device_hash", "device-token-2"), true);

    const connection = store.createConnection("conn_hash", "conn-token", {
      approved_by_device_id: "device_hash",
      scopes: ["payment.requests.read"]
    });
    assert.equal(connection.connection_token, "conn-token");
    assert.equal(store.connection("conn_hash").connection_token, undefined);
    assert.match(store.connection("conn_hash").connection_token_hash, /^sha256:/);
    assert.equal(store.connectionByToken("conn-token").connection_id, "conn_hash");

    const rotatedConnection = store.rotateConnectionToken("conn_hash", "conn-token-2");
    assert.equal(rotatedConnection.connection_token, "conn-token-2");
    assert.equal(store.connectionByToken("conn-token"), null);
    assert.equal(store.connectionByToken("conn-token-2").connection_id, "conn_hash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idempotency replay never returns another wallet's payment intent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "velarumpay-idem-intent-"));
  try {
    const store = new Store(path.join(dir, "store.json"));
    store.putIntent({
      intent_id: "pi_alice",
      idempotency_key: "shared-key",
      target_app_device_id: "wallet_alice",
      status: "pending",
      payment: { asset: "USDC", amount: "10.00" }
    });

    // Same key, a different wallet device: must NOT surface Alice's intent.
    assert.equal(store.findByIdempotency("shared-key", "wallet_bob"), null);
    // Same key, no device scope at all: also must not leak.
    assert.equal(store.findByIdempotency("shared-key"), null);
    // Same key AND the owning device: legitimate dedupe still works.
    assert.equal(store.findByIdempotency("shared-key", "wallet_alice").intent_id, "pi_alice");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idempotency replay never leaks a payment request across connections", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "velarumpay-idem-request-"));
  try {
    const store = new Store(path.join(dir, "store.json"));

    // A connection-less (legacy) request and a real connection's request that
    // happen to reuse the same caller-chosen idempotency key.
    store.putPaymentRequest({
      request_id: "prq_legacy",
      idempotency_key: "shared-key",
      connection_id: "",
      status: "pending",
      created_at: new Date().toISOString()
    });
    store.putPaymentRequest({
      request_id: "prq_conn_a",
      idempotency_key: "scoped-key",
      connection_id: "conn_a",
      status: "pending",
      created_at: new Date().toISOString()
    });

    // A different connection replaying either key gets nothing.
    assert.equal(store.findPaymentRequestByIdempotency("shared-key", "conn_b"), null);
    assert.equal(store.findPaymentRequestByIdempotency("scoped-key", "conn_b"), null);
    // The legacy request is not reachable by any real connection.
    assert.equal(store.findPaymentRequestByIdempotency("shared-key", "conn_a"), null);

    // Each caller can still dedupe its own request.
    assert.equal(store.findPaymentRequestByIdempotency("shared-key", "").request_id, "prq_legacy");
    assert.equal(store.findPaymentRequestByIdempotency("scoped-key", "conn_a").request_id, "prq_conn_a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a transaction context is only readable by the device that approved its connection", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "velarumpay-context-read-"));
  try {
    const store = new Store(path.join(dir, "store.json"));

    // Two independently paired wallets, each with its own connection.
    store.registerDevice("wallet_alice", "alice-token");
    store.registerDevice("wallet_bob", "bob-token");
    store.createConnection("conn_alice", "conn-alice-token", {
      approved_by_device_id: "wallet_alice",
      scopes: ["transaction_contexts.read"]
    });
    store.createConnection("conn_bob", "conn-bob-token", {
      approved_by_device_id: "wallet_bob",
      scopes: ["transaction_contexts.read"]
    });

    // A context created on Alice's connection.
    store.putTransactionContext({
      transaction_id: "txn_alice",
      connection_id: "conn_alice",
      status: "ready"
    });
    const aliceContext = store.transactionContext("txn_alice");

    // The device that approved the owning connection can read it.
    assert.equal(store.deviceCanReadTransactionContext("wallet_alice", aliceContext), true);
    // An arbitrary other registered device cannot, even though its OWN token is
    // perfectly valid: a valid device token must not read another wallet's context.
    assert.equal(store.deviceCanReadTransactionContext("wallet_bob", aliceContext), false);
    // An unknown / unregistered device id never qualifies.
    assert.equal(store.deviceCanReadTransactionContext("wallet_mallory", aliceContext), false);
    // A missing device id is never treated as an owner.
    assert.equal(store.deviceCanReadTransactionContext("", aliceContext), false);
    assert.equal(store.deviceCanReadTransactionContext("   ", aliceContext), false);

    // A connection-less / legacy context is owned by no wallet device, so the
    // app read path can never surface it (it is reachable only via its own
    // connection token or the explicitly trusted legacy connector path).
    store.putTransactionContext({ transaction_id: "txn_legacy", connection_id: "", status: "ready" });
    assert.equal(
      store.deviceCanReadTransactionContext("wallet_alice", store.transactionContext("txn_legacy")),
      false
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function mockReq({ ip = "127.0.0.1", rawBody = "", headers = {} } = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    ip,
    rawBody,
    method: "POST",
    path: "/v1/payment-intents",
    get(name) {
      return normalizedHeaders[String(name).toLowerCase()] || "";
    }
  };
}
