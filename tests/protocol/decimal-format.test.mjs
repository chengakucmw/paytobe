import assert from "node:assert/strict";
import test from "node:test";
import {
  DECIMAL_STRING,
  isDecimalString,
  isPositiveDecimalString
} from "../../packages/protocol/src/decimal-format.js";
import { PAYMENT_REQUEST_PROTOCOL, normalizePaymentRequestV1 } from "../../packages/protocol/src/index.js";

// F4: ONE canonical money-amount pattern, shared by the protocol validators and the
// services-side decimal arithmetic (services/platform-api/src/decimal.js imports it).
// F3: positivity is a pure string test, never float64 Number() — which underflows a
// very long fractional to 0 and would wrongly reject a tiny-but-valid amount.

test("DECIMAL_STRING accepts canonical amounts and rejects junk", () => {
  for (const ok of ["0", "0.1", "24.00", "1000", "0.0000001"]) {
    assert.equal(isDecimalString(ok), true, ok);
    assert.equal(DECIMAL_STRING.test(ok), true, ok);
  }
  for (const bad of ["-1", "01", "1.", ".5", "1e3", "abc", " 1", "", "1,000"]) {
    assert.equal(isDecimalString(bad), false, bad);
  }
});

test("isPositiveDecimalString rejects only zero, with no float underflow (F3)", () => {
  assert.equal(isPositiveDecimalString("0"), false);
  assert.equal(isPositiveDecimalString("0.0"), false);
  assert.equal(isPositiveDecimalString("0.000000"), false);
  assert.equal(isPositiveDecimalString("0.1"), true);
  assert.equal(isPositiveDecimalString("-1"), false); // not a canonical decimal at all

  // A fractional far below Number's underflow point: Number("0.000…1") rounds to 0,
  // but the string test correctly keeps it positive. This is exactly why the old
  // Number(amount) <= 0 positivity check was unsafe.
  const tiny = `0.${"0".repeat(400)}1`;
  assert.equal(Number(tiny), 0);
  assert.equal(isPositiveDecimalString(tiny), true);
});

test("normalizePaymentRequestV1 rejects a zero amount and accepts a tiny positive one", () => {
  const base = {
    protocol: PAYMENT_REQUEST_PROTOCOL,
    request_id: "req_1",
    connection_id: "conn_1",
    created_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    status: "pending",
    source: { device_id: "d1" },
    payee: { name: "Acme" },
    policy: { requires_user_approval: true },
    payment: { rail: "stellar_xlm", network: "stellar_public", asset: "XLM", to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", amount: "0" }
  };

  const zero = normalizePaymentRequestV1(base);
  assert.equal(zero.ok, false);
  assert.equal(zero.error.code, "invalid_decimal_string");

  const tiny = normalizePaymentRequestV1({
    ...base,
    payment: { ...base.payment, amount: `0.${"0".repeat(50)}1` }
  });
  assert.equal(tiny.ok, true);
});
