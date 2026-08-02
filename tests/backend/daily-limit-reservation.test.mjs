import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../services/platform-api/src/store.js";
import { evaluatePaymentRequest } from "../../services/platform-api/src/risk.js";

// F1 regression coverage: the daily cap used to be CHECKED at request/intent
// creation but only RECORDED at on-chain `confirmed`. Between those two moments an
// unbounded number of payments could each pass the check against the same
// un-incremented total, then all confirm — blowing the cap under concurrent
// fan-out. The fix is an atomic reservation ledger (see store.js): reserve against
// the cap at commit time, settle into confirmed spend on `confirmed`, release back
// to the cap on failed/expired/rejected. The cap is checked against "committed" =
// confirmed spend PLUS live reservations. These tests pin that ledger and prove the
// concurrent-bypass window is closed.

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-reserve-"));
  const file = path.join(dir, "relay-store.json"); // .json => in-memory JSON driver
  return { store: new Store(file), file, dir };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function xlmRequest(amount, to = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF") {
  return {
    transaction_id: "tx_reserve",
    payment: { rail: "stellar_xlm", network: "stellar_public", asset: "XLM", to, amount }
  };
}

const CAP1 = {
  STELLAR_PUBLIC_ENABLED: "true",
  STELLAR_PUBLIC_SINGLE_PAYMENT_MAX_XLM: "1",
  STELLAR_PUBLIC_HORIZON_URL: "https://horizon.stellar.org",
  ADDRESS_WHITELIST_STELLAR: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  DAILY_LIMIT_XLM: "1"
};

// --- the core bypass test ---------------------------------------------------

test("F1: a reservation atomically consumes headroom so a concurrent payment can't reuse it", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));

  // Two "concurrent" payments of 0.6 against a cap of 1. Under the old check-only
  // gate both saw dailySpent 0 and both passed. Now the first RESERVES 0.6 and the
  // second is measured against committed = 0.6, so it cannot also fit.
  const a = store.reserveDailyLimit("pay_a", "XLM", "0.6", "1");
  const b = store.reserveDailyLimit("pay_b", "XLM", "0.6", "1");
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.reason, "over_limit");

  // A third payment that DOES fit in the remaining 0.4 is allowed.
  assert.equal(store.reserveDailyLimit("pay_c", "XLM", "0.4", "1").ok, true);

  assert.equal(store.dailyReserved("XLM"), "1");
  assert.equal(store.dailySpent("XLM"), "0"); // nothing confirmed yet
  assert.equal(store.dailyCommitted("XLM"), "1");
});

test("F1: the read-only evaluate gate also counts live reservations", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));

  // Reserve the whole cap (in-flight, not yet confirmed).
  assert.equal(store.reserveDailyLimit("pay_full", "XLM", "1", "1").ok, true);
  assert.equal(store.dailySpent("XLM"), "0");

  // A new Payment Request for the smallest valid increment must be BLOCKED, even
  // though confirmed spend is still 0 — because committed (reserved) is already 1.
  const risk = evaluatePaymentRequest(xlmRequest("0.0000001"), {}, store, CAP1);
  assert.equal(risk.errors.some((e) => e.code === "daily_limit_exceeded"), true);
  assert.equal(risk.signing_allowed, false);
});

test("F1: many small reservations accumulate exactly and block past the cap", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));

  // Ten 0.1 reservations exactly fill a cap of 1 (float would drift to 0.999…9).
  for (let i = 0; i < 10; i++) {
    assert.equal(store.reserveDailyLimit(`p${i}`, "XLM", "0.1", "1").ok, true);
  }
  assert.equal(store.dailyReserved("XLM"), "1");
  // The next smallest increment is rejected — no phantom headroom.
  assert.equal(store.reserveDailyLimit("p_over", "XLM", "0.0000001", "1").ok, false);
});

// --- settle / release -------------------------------------------------------

test("F1: settle moves a reservation into confirmed spend, conserving the total", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));

  store.reserveDailyLimit("pay_s", "XLM", "0.6", "1");
  assert.equal(store.dailyReserved("XLM"), "0.6");
  assert.equal(store.dailySpent("XLM"), "0");

  store.settleDailyReservation("pay_s", "XLM", "0.6");
  assert.equal(store.dailyReserved("XLM"), "0"); // reservation gone
  assert.equal(store.dailySpent("XLM"), "0.6"); // now confirmed
  assert.equal(store.dailyCommitted("XLM"), "0.6"); // total unchanged across settle
});

test("F1: release frees headroom for a later payment", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));

  assert.equal(store.reserveDailyLimit("pay_x", "XLM", "0.6", "1").ok, true);
  assert.equal(store.reserveDailyLimit("pay_y", "XLM", "0.6", "1").ok, false); // no room

  store.releaseDailyReservation("pay_x"); // pay_x failed / expired
  assert.equal(store.dailyReserved("XLM"), "0");
  assert.equal(store.reserveDailyLimit("pay_y", "XLM", "0.6", "1").ok, true); // room again
});

test("F1: reserve is idempotent per id and release of a resolved id is a no-op", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));

  store.reserveDailyLimit("pay_i", "XLM", "0.5", "1");
  // Re-reserving the same id is a no-op success, not a double count.
  const dup = store.reserveDailyLimit("pay_i", "XLM", "0.5", "1");
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true);
  assert.equal(store.dailyReserved("XLM"), "0.5");

  store.settleDailyReservation("pay_i", "XLM", "0.5");
  assert.equal(store.dailySpent("XLM"), "0.5");
  // The reservation is already settled, so releasing it must not move the reserved
  // total negative or otherwise disturb the books.
  store.releaseDailyReservation("pay_i");
  assert.equal(store.dailyReserved("XLM"), "0");
  assert.equal(store.dailySpent("XLM"), "0.5");
});

test("F1: settle without a prior reservation still records confirmed spend (legacy / blocked-but-confirmed)", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));

  // No reservation was ever held for this id (e.g. legacy data, or a device that
  // confirmed an already-blocked payment). The money still moved, so it must be
  // counted as confirmed spend rather than silently dropped.
  store.settleDailyReservation("unknown_id", "XLM", "0.5");
  assert.equal(store.dailySpent("XLM"), "0.5");
});

// --- fail-closed ------------------------------------------------------------

test("F1: reserve fails closed on a bad amount or misconfigured limit, without recording", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));

  assert.equal(store.reserveDailyLimit("p1", "XLM", "not-a-number", "1").ok, false);
  assert.equal(store.reserveDailyLimit("p2", "XLM", "0.1", "1,000").ok, false); // comma => unparseable
  assert.equal(store.reserveDailyLimit("p3", "XLM", "-1", "1").ok, false);
  // None of the rejected reservations consumed any headroom.
  assert.equal(store.dailyReserved("XLM"), "0");
});

// --- persistence ------------------------------------------------------------

test("F1: live reservations survive a store reopen and still enforce the cap", (t) => {
  const { store, file, dir } = freshStore();
  t.after(() => cleanup(dir));

  store.reserveDailyLimit("pay_persist", "XLM", "0.7", "1");
  const reopened = new Store(file);
  assert.equal(reopened.dailyReserved("XLM"), "0.7");
  // The cap is still enforced against the restored reservation.
  assert.equal(reopened.reserveDailyLimit("pay_new", "XLM", "0.4", "1").ok, false);
});
