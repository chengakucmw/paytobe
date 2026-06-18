import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../services/platform-api/src/store.js";
import { evaluateIntent } from "../../services/platform-api/src/risk.js";
import {
  addDecimalStrings,
  compareDecimalStrings,
  normalizeDecimalString
} from "../../services/platform-api/src/decimal.js";

// Regression coverage for H3: the daily spend cap used to accumulate and
// compare money with float64 `Number`s. 0.1 + 0.2 !== 0.3 in float, so the
// stored total drifted with every payment — making the cap inaccurate and
// letting spend slip past it through accumulated error. The cap is now kept
// in exact BigInt minor units (see services/platform-api/src/decimal.js).

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-limit-"));
  const file = path.join(dir, "relay-store.json"); // .json => in-memory JSON driver
  const store = new Store(file);
  return { store, file, dir };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function dayKey(asset) {
  return `${new Date().toISOString().slice(0, 10)}:${asset.toUpperCase()}`;
}

function stellarIntent(amount, { ttlMs = 3_600_000 } = {}) {
  return {
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
    idempotency_key: "idem_test",
    velarum: { request_id: "req_test" },
    payment: {
      rail: "stellar_xlm",
      network: "stellar_public",
      asset: "XLM",
      to: `G${"A".repeat(55)}`,
      amount
    }
  };
}

const LIMIT_MSG = "Daily XLM limit exceeded";

// --- decimal module ---------------------------------------------------------

test("normalizeDecimalString accepts clean decimals and rejects junk", () => {
  assert.equal(normalizeDecimalString("0.1"), "0.1");
  assert.equal(normalizeDecimalString("1000"), "1000");
  assert.equal(normalizeDecimalString("  24.00  "), "24.00");
  // Legacy persisted float totals arrive as numbers.
  assert.equal(normalizeDecimalString(0.1), "0.1");
  assert.equal(normalizeDecimalString(1e-7), "0.0000001"); // no exponent leaks through
  assert.equal(normalizeDecimalString(0), "0");
  // Anything that is not a non-negative decimal is rejected (caller fails closed).
  assert.equal(normalizeDecimalString("abc"), null);
  assert.equal(normalizeDecimalString("-5"), null);
  assert.equal(normalizeDecimalString("01"), null);
  assert.equal(normalizeDecimalString(Number.NaN), null);
  assert.equal(normalizeDecimalString(undefined), null);
});

test("addDecimalStrings is exact where float addition is not", () => {
  assert.equal(addDecimalStrings("0.1", "0.2"), "0.3"); // float gives 0.30000000000000004
  assert.equal(addDecimalStrings("0.3", "0.6"), "0.9"); // float gives 0.8999999999999999
  assert.equal(addDecimalStrings("1000", "0.000001"), "1000.000001");

  let exact = "0";
  let float = 0;
  for (let i = 0; i < 10; i++) {
    exact = addDecimalStrings(exact, "0.1");
    float += 0.1;
  }
  assert.equal(exact, "1");
  assert.notEqual(float, 1); // documents the bug: 0.9999999999999999
});

test("compareDecimalStrings orders values exactly across scales", () => {
  assert.equal(compareDecimalStrings("1.0", "1"), 0);
  assert.equal(compareDecimalStrings("1.000001", "1"), 1);
  assert.equal(compareDecimalStrings("0.9999999", "1"), -1);
});

// --- store accumulation -----------------------------------------------------

test("addDailySpent accumulates to an exact decimal string, not a float", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));

  for (let i = 0; i < 10; i++) store.addDailySpent("USDC", "0.1");

  // The whole point of H3: ten 0.1 payments are exactly 1, stored as a string.
  assert.equal(store.dailySpent("USDC"), "1");
  assert.equal(typeof store.state.dailySpent[dayKey("USDC")], "string");

  // For contrast, the old float path would have stored 0.9999999999999999.
  let float = 0;
  for (let i = 0; i < 10; i++) float += 0.1;
  assert.notEqual(String(float), "1");
});

test("daily spend survives a store reopen as an exact string", (t) => {
  const { store, file, dir } = freshStore();
  t.after(() => cleanup(dir));

  store.addDailySpent("USDC", "12.5");
  store.addDailySpent("USDC", "0.25");

  const reopened = new Store(file);
  assert.equal(reopened.dailySpent("USDC"), "12.75");
});

test("dailySpent tolerates a legacy float total left by the old code", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));

  // Simulate data written before the fix: a raw float64 Number on disk.
  store.state.dailySpent[dayKey("XLM")] = 0.9999999999999999;

  assert.equal(typeof store.dailySpent("XLM"), "string");
  // Adding to it must not throw and must not silently reset the cap.
  store.addDailySpent("XLM", "0.1");
  assert.equal(compareDecimalStrings(store.dailySpent("XLM"), "1"), 1);
});

// --- limit enforcement ------------------------------------------------------

test("payments are allowed up to the cap and blocked exactly past it", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));
  const env = { DAILY_LIMIT_XLM: "1" };

  // Spend 0.9 across nine 0.1 payments.
  for (let i = 0; i < 9; i++) store.addDailySpent("XLM", "0.1");

  // The tenth 0.1 lands exactly on the cap (0.9 + 0.1 === 1) and is allowed.
  const atCap = evaluateIntent(stellarIntent("0.1"), store, env);
  assert.equal(atCap.errors.includes(LIMIT_MSG), false);

  // Record it, reaching the cap exactly.
  store.addDailySpent("XLM", "0.1");
  assert.equal(store.dailySpent("XLM"), "1");

  // Now the smallest valid increment over the cap is rejected.
  const overCap = evaluateIntent(stellarIntent("0.0000001"), store, env);
  assert.equal(overCap.errors.includes(LIMIT_MSG), true);
});

test("accumulated float drift can no longer open phantom headroom under the cap", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));
  const env = { DAILY_LIMIT_XLM: "1" };

  // Ten exact 0.1 payments == 1.0, i.e. the cap is fully used.
  for (let i = 0; i < 10; i++) store.addDailySpent("XLM", "0.1");
  assert.equal(store.dailySpent("XLM"), "1");

  // Under the old float store this read back as 0.9999999999999999, leaving
  // ~1e-16 of phantom headroom that let an extra payment slip through. With
  // exact accounting there is no headroom: any further spend is blocked.
  const extra = evaluateIntent(stellarIntent("0.0000001"), store, env);
  assert.equal(extra.errors.includes(LIMIT_MSG), true);
});

test("checkDailyLimit fails closed on a bad amount or a misconfigured limit", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));

  // Non-decimal amount must be rejected, not coerced to NaN and waved through.
  const badAmount = evaluateIntent(stellarIntent("not-a-number"), store, { DAILY_LIMIT_XLM: "1" });
  assert.equal(badAmount.errors.includes(LIMIT_MSG), true);

  // A misconfigured limit must reject rather than silently allow unlimited spend.
  const badLimit = evaluateIntent(stellarIntent("0.1"), store, { DAILY_LIMIT_XLM: "1,000" });
  assert.equal(badLimit.errors.includes(LIMIT_MSG), true);
});
