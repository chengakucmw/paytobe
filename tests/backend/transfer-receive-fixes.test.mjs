// Regression tests for the 2026-06-19 "转账 / 收款 深度Bug排查" Medium items that
// live in the backend:
//
//   M-1  the daily-limit + whitelist gates must run on the MAIN Payment Request
//        path (evaluatePaymentRequest), not only the legacy evaluateIntent path.
//   M-2  a Stellar transaction is "confirmed" only when Horizon reports
//        successful === true — a found-but-failed transaction is NOT a success.
//
// These pin the contract so the gaps the report found cannot silently reopen.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { evaluatePaymentRequest, stellarConfirmationResult } from "../../services/platform-api/src/risk.js";
import { Store } from "../../services/platform-api/src/store.js";

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-tr-store-"));
  return { store: new Store(path.join(dir, "relay-store.json")), dir };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function xlmRequest(amount, to = `G${"A".repeat(55)}`) {
  return {
    transaction_id: "tx_main",
    connection_id: "conn_main",
    payment: { rail: "stellar_xlm", network: "stellar_public", asset: "XLM", to, amount }
  };
}

const hasCode = (items, code) => items.some((item) => item && item.code === code);

// ---------------------------------------------------------------------------
// M-1 — daily limit on the MAIN path
// ---------------------------------------------------------------------------
test("M-1: evaluatePaymentRequest blocks a payment that pushes spend over the cap", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));
  const env = { DAILY_LIMIT_XLM: "1" };

  // Use up the whole cap, then attempt the smallest valid increment over it.
  store.addDailySpent("XLM", "1");
  const over = evaluatePaymentRequest(xlmRequest("0.0000001"), {}, store, env);

  assert.equal(over.ok, false, "over-cap payment must not be ok");
  assert.equal(over.signing_allowed, false, "signing must be disallowed once blocked");
  assert.equal(over.review_status, "blocked");
  assert.ok(hasCode(over.errors, "daily_limit_exceeded"), "the limit blocker must be present");
});

test("M-1: a payment within the cap carries no limit blocker", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));
  const env = { DAILY_LIMIT_XLM: "1000" };

  const ok = evaluatePaymentRequest(xlmRequest("1.5"), {}, store, env);
  assert.equal(hasCode(ok.errors, "daily_limit_exceeded"), false);
});

test("M-1: the cap fails closed on an unparseable amount", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));
  const bad = evaluatePaymentRequest(xlmRequest("not-a-number"), {}, store, { DAILY_LIMIT_XLM: "1" });
  assert.ok(hasCode(bad.errors, "daily_limit_exceeded"), "a bad amount must be rejected, not waved through");
});

// ---------------------------------------------------------------------------
// M-1 — recipient whitelist on the MAIN path
// ---------------------------------------------------------------------------
test("M-1: an off-whitelist recipient is blocked when a whitelist is configured", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));
  const allowed = `G${"B".repeat(55)}`;
  const env = { DAILY_LIMIT_XLM: "1000", ADDRESS_WHITELIST_STELLAR: allowed };

  const blocked = evaluatePaymentRequest(xlmRequest("1", `G${"A".repeat(55)}`), {}, store, env);
  assert.ok(hasCode(blocked.errors, "recipient_not_whitelisted"), "off-list recipient must be blocked");

  const permitted = evaluatePaymentRequest(xlmRequest("1", allowed), {}, store, env);
  assert.equal(hasCode(permitted.errors, "recipient_not_whitelisted"), false, "whitelisted recipient is allowed");
});

test("M-1: an unconfigured whitelist does not block or add noise", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));
  const result = evaluatePaymentRequest(xlmRequest("1"), {}, store, { DAILY_LIMIT_XLM: "1000" });
  assert.equal(hasCode(result.errors, "recipient_not_whitelisted"), false);
});

test("M-1: evaluatePaymentRequest without a store is unchanged (no enforcement, no throw)", () => {
  const result = evaluatePaymentRequest(xlmRequest("999999"), {});
  assert.equal(hasCode(result.errors, "daily_limit_exceeded"), false);
  assert.equal(hasCode(result.errors, "recipient_not_whitelisted"), false);
});

// ---------------------------------------------------------------------------
// M-2 — Stellar success must be verified, not assumed from "tx exists"
// ---------------------------------------------------------------------------
test("M-2: a not-yet-found transaction keeps polling (null)", () => {
  assert.equal(stellarConfirmationResult(null), null);
});

test("M-2: only successful === true is confirmed", () => {
  assert.deepEqual(stellarConfirmationResult({ successful: true }), { ok: true });
});

test("M-2: a found-but-failed transaction is NOT confirmed", () => {
  const failed = stellarConfirmationResult({ successful: false, result_xdr: "AAAAAg==" });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /failed/i);
  assert.match(failed.error, /AAAAAg==/);
});

test("M-2: a missing successful flag fails closed (treated as not successful)", () => {
  const ambiguous = stellarConfirmationResult({ hash: "abc" });
  assert.equal(ambiguous.ok, false);
});
