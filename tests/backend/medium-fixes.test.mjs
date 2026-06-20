// Regression tests for the 2026-06-18 backend Medium audit (M1–M7).
//
// Each test pins the SECURITY / CORRECTNESS contract a fix establishes, so the
// original bug can never silently come back. Pure helpers (velarum, crypto,
// risk, store) are exercised directly; the three server.js-internal fixes
// (M1 socket routing, M3 confirmLater, M5 state machine) use the small set of
// internals server.js now exports for testing.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { adaptVelarum } from "../../services/platform-api/src/velarum.js";
import { randomNumericCode } from "../../services/platform-api/src/crypto.js";
import { evaluatePaymentRequest } from "../../services/platform-api/src/risk.js";
import { Store } from "../../services/platform-api/src/store.js";

// server.js instantiates a Store at import time, so point it at a throwaway
// JSON store and disable the port bind BEFORE dynamically importing it.
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-medium-"));
process.env.VP_NO_AUTO_LISTEN = "1";
process.env.RELAY_STORE_PATH = path.join(storeDir, "relay-store.json"); // .json => JSON driver
const {
  notifyOpenClaw,
  addSocket,
  openclawSockets,
  confirmLater,
  validatePaymentRequestStatusUpdate
} = await import("../../services/platform-api/src/server.js");

// ---------------------------------------------------------------------------
// M1 — status pushes must not broadcast to a shared "default" bucket
// ---------------------------------------------------------------------------
function fakeSocket() {
  return { readyState: 1, OPEN: 1, sent: [], send(msg) { this.sent.push(msg); } };
}

test("M1: notifyOpenClaw delivers only to the addressed connection, never 'default'", () => {
  openclawSockets.clear();
  const a = fakeSocket();
  const b = fakeSocket();
  const legacy = fakeSocket();
  const def = fakeSocket(); // an old anonymous socket parked under "default"
  addSocket(openclawSockets, "conn_A", a);
  addSocket(openclawSockets, "conn_B", b);
  addSocket(openclawSockets, "legacy_x", legacy);
  addSocket(openclawSockets, "default", def);

  notifyOpenClaw("conn_A", { request_id: "req_1", tx_hash: "0xSECRET" });

  assert.equal(a.sent.length, 1, "the addressed connection receives the status");
  assert.equal(b.sent.length, 0, "another connection must NOT see req_1/tx_hash");
  assert.equal(legacy.sent.length, 0, "a legacy socket must NOT see it either");
  assert.equal(def.sent.length, 0, "the shared 'default' bucket must NOT be broadcast to");

  // A falsy/absent route is dropped, not fanned out.
  notifyOpenClaw(undefined, { request_id: "req_2" });
  assert.equal(def.sent.length, 0, "an unroutable message is dropped, never broadcast");
  openclawSockets.clear();
});

// ---------------------------------------------------------------------------
// M2 — "what you sign vs what you see" check is unconditional + value-based
// ---------------------------------------------------------------------------
test("M2: consistency check runs even when payload.asset is omitted", () => {
  const intent = {
    payment: { network: "base", asset: "USDC", amount: "5", to: "0xALICE" },
    velarum: {
      request_id: "r1",
      // No `asset` key — this is exactly what used to bypass every check.
      payload: { amount: "5", recipient: { address: "0xATTACKER" } }
    }
  };
  const result = adaptVelarum(intent, {});
  assert.equal(result.ok, false, "a recipient mismatch must be caught without payload.asset");
  assert.match(result.error, /recipient/i);
});

test("M2: amounts are compared by value, so 24.0 === 24.00", () => {
  const intent = {
    payment: { network: "base", asset: "USDC", amount: "24.00", to: "0xA" },
    velarum: {
      request_id: "r2",
      payload: { asset: { network: "base", symbol: "USDC" }, amount: "24.0", recipient: { address: "0xA" } }
    }
  };
  const result = adaptVelarum(intent, {});
  assert.equal(result.ok, true, "'24.0' and '24.00' are the same amount, not a mismatch");
});

test("M2: a genuine amount mismatch is still rejected", () => {
  const intent = {
    payment: { network: "base", asset: "USDC", amount: "5", to: "0xA" },
    velarum: {
      request_id: "r3",
      payload: { asset: { symbol: "USDC" }, amount: "50", recipient: { address: "0xA" } }
    }
  };
  assert.equal(adaptVelarum(intent, {}).ok, false, "50 != 5 must be rejected");
});

// ---------------------------------------------------------------------------
// M3 — confirmLater must not crash when the intent was pruned mid-flight
// ---------------------------------------------------------------------------
test("M3: confirmLater tolerates a null store result without rejecting", async () => {
  // rail base_usdc with no rpc_url makes waitForConfirmation throw immediately
  // (no network call, no 4s sleeps). The intent_id is not in the store, so the
  // catch-path store.updateStatus returns null — the exact null that used to be
  // dereferenced and turned into a process-killing unhandled rejection.
  const ghost = {
    intent_id: `pi_ghost_${Date.now()}`,
    payment: { rail: "base_usdc", asset: "USDC", amount: "1" },
    source: {},
    target_app_device_id: "dev_missing"
  };
  await assert.doesNotReject(confirmLater(ghost, "0xdeadbeef"));
});

// ---------------------------------------------------------------------------
// M4 — pairing codes are uniform 6-digit values (crypto.randomInt)
// ---------------------------------------------------------------------------
test("M4: randomNumericCode returns zero-padded, in-range 6-digit codes", () => {
  let sawLeadingZero = false;
  for (let i = 0; i < 5000; i++) {
    const code = randomNumericCode(6);
    assert.match(code, /^\d{6}$/, `code "${code}" must be exactly 6 digits`);
    const n = Number(code);
    assert.ok(n >= 0 && n <= 999999, `code ${n} must be within [0, 999999]`);
    if (code[0] === "0") sawLeadingZero = true;
  }
  assert.ok(sawLeadingZero, "small values must be zero-padded, not collapsed");
});

// ---------------------------------------------------------------------------
// M5 — explicit, ordered payment-request state machine
// ---------------------------------------------------------------------------
const at = (status) => ({ status });

test("M5: pending cannot jump straight to confirmed (skip-sign blocked)", () => {
  const r = validatePaymentRequestStatusUpdate(at("pending"), "confirmed");
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_status_transition");
});

test("M5: a failed request cannot be revived to confirmed", () => {
  assert.equal(validatePaymentRequestStatusUpdate(at("failed"), "confirmed").ok, false);
  assert.equal(validatePaymentRequestStatusUpdate(at("failed"), "broadcasted").ok, false, "failed is irreversible");
});

test("M5: the canonical lifecycle is allowed", () => {
  assert.equal(validatePaymentRequestStatusUpdate(at("pending"), "signed").ok, true);
  assert.equal(validatePaymentRequestStatusUpdate(at("signed"), "broadcasted").ok, true);
  assert.equal(validatePaymentRequestStatusUpdate(at("broadcasted"), "confirmed").ok, true);
});

test("M5: terminal statuses are immutable (no re-confirm double-spend)", () => {
  const r = validatePaymentRequestStatusUpdate(at("confirmed"), "confirmed");
  assert.equal(r.ok, false, "re-reporting confirmed must be refused so spend isn't counted twice");
  assert.equal(r.code, "terminal_payment_request");
});

test("M5: idempotent re-report of a non-terminal status is allowed", () => {
  assert.equal(validatePaymentRequestStatusUpdate(at("broadcasted"), "broadcasted").ok, true);
});

// ---------------------------------------------------------------------------
// M6 — app device registration is first-create-only (no token takeover)
// ---------------------------------------------------------------------------
test("M6: re-registering an existing device_id is refused, token_hash untouched", () => {
  const store = new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "velarum-m6-")), "relay-store.json"));
  const first = store.registerDevice("dev-1", "owner-token");
  assert.ok(first && first.device_id === "dev-1", "first registration succeeds");
  const originalHash = store.device("dev-1").token_hash;

  const takeover = store.registerDevice("dev-1", "attacker-token");
  assert.equal(takeover, null, "a second registration of the same id must be refused");
  assert.equal(store.device("dev-1").token_hash, originalHash, "the stored token_hash must be unchanged");

  assert.equal(store.verifyDeviceToken("dev-1", "owner-token"), true, "owner can still authenticate");
  assert.equal(store.verifyDeviceToken("dev-1", "attacker-token"), false, "attacker token is rejected");
});

// ---------------------------------------------------------------------------
// M7 — a client-supplied context snapshot is never trusted by risk scoring
// ---------------------------------------------------------------------------
test("M7: risk ignores request.transaction_context_snapshot when the server context is missing", () => {
  // A forged "snapshot" carrying a blocker finding the attacker hopes risk will
  // either trust as evidence or — in the original bug — silently substitute for
  // the real one.
  const forgedSnapshot = {
    risk_findings: [{ code: "amount_mismatch", severity: "blocker", message: "forged", field: "payment.amount" }]
  };
  const request = {
    transaction_id: "tx_forged",
    connection_id: "conn_1",
    payment: { asset: "USDC", amount: "5", network: "base", to: "0xA" },
    transaction_context_snapshot: forgedSnapshot // client-supplied — must be ignored
  };

  // Server context is missing → contextResult.snapshot is null. The fix must NOT
  // fall back to the client snapshot, so the forged finding never appears.
  const ignored = evaluatePaymentRequest(request, { ref: { status: "missing" }, context: null, snapshot: null });
  assert.ok(
    !ignored.errors.some((e) => e.code === "context_amount_mismatch"),
    "a client-supplied snapshot must not inject risk findings"
  );

  // Sanity: the SAME snapshot, supplied by the server (contextResult.snapshot),
  // IS honored — proving the vector above is real and the assertion non-vacuous.
  const honored = evaluatePaymentRequest(request, { ref: { status: "ready" }, context: null, snapshot: forgedSnapshot });
  assert.ok(
    honored.errors.some((e) => e.code === "context_amount_mismatch"),
    "a server-built snapshot's findings are honored"
  );
});
