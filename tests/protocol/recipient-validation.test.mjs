import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PAYMENT_REQUEST_PROTOCOL,
  normalizePaymentRequestV1,
  normalizeRecipientVersionV1
} from "../../packages/protocol/src/index.js";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/recipients");
const valid = JSON.parse(fs.readFileSync(path.join(directory, "valid.json"), "utf8"));
const invalid = JSON.parse(fs.readFileSync(path.join(directory, "invalid.json"), "utf8"));

test("valid fixtures normalize registered testnet and token facts while retaining safe display values", () => {
  for (const fixture of valid) {
    const result = normalizeRecipientVersionV1(fixture.input);
    assert.equal(result.ok, true, fixture.name);
    assert.deepEqual(pick(result.value, Object.keys(fixture.expected)), fixture.expected, fixture.name);
    assert.equal(result.value.display.asset, fixture.input.asset, `${fixture.name} original safe asset display`);
    assert.equal(result.value.display.address, fixture.input.address, `${fixture.name} original safe address display`);
  }
});

test("invalid fixtures reject network, binding, Unicode, checksum, memo, and unsupported-asset failures", () => {
  for (const fixture of invalid) {
    const result = normalizeRecipientVersionV1(fixture.input);
    assert.equal(result.ok, false, fixture.name);
    assert.equal(result.error.code, fixture.code, fixture.name);
  }
});

test("recipient-specific memo rules enforce required, forbidden, bounded, and charset policy", () => {
  const stellar = valid[0].input;
  const required = { mode: "required", max_bytes: 28, charset: "printable_ascii" };
  assert.equal(normalizeRecipientVersionV1({ ...stellar, memo: undefined }, { memoPolicy: required }).error.code, "recipient_memo_required");
  assert.equal(normalizeRecipientVersionV1({ ...stellar, memo: "invoice-7" }, { memoPolicy: required }).ok, true);
  assert.equal(normalizeRecipientVersionV1({ ...stellar, memo: "发票" }).error.code, "recipient_memo_charset");
  assert.equal(normalizeRecipientVersionV1({ ...stellar, memo: "x".repeat(29) }).error.code, "recipient_memo_too_long");
  assert.equal(normalizeRecipientVersionV1({ ...valid[1].input, memo: "1" }).error.code, "recipient_memo_forbidden");
});

test("Payment Request validation invokes the same recipient fact validator", () => {
  for (const fixture of invalid.filter((item) => [
    "cross-network", "wrong-contract", "unicode-asset-confusable", "stellar-checksum",
    "oversized-stellar-memo", "forbidden-base-memo"
  ].includes(item.name))) {
    const direct = normalizeRecipientVersionV1(fixture.input, { requireExplicitBindings: true });
    const payment = normalizePaymentRequestV1(paymentRequest(fixture.input), { now: "2026-08-01T16:00:00.000Z" });
    assert.equal(payment.ok, false, fixture.name);
    assert.equal(payment.error.code, direct.error.code, fixture.name);
  }

  const accepted = normalizePaymentRequestV1(paymentRequest(valid[0].input), { now: "2026-08-01T16:00:00.000Z" });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.value.payment.network, "stellar_testnet");
  assert.equal(accepted.value.payment.memo, "testnet-order-42");
});

test("metadata and display cannot repair or override invalid authoritative facts", () => {
  const broken = { ...valid[0].input, address: "not-an-address" };
  const display = normalizeRecipientVersionV1({ ...broken, display: { address: valid[0].input.address } });
  assert.equal(display.error.code, "authoritative_display_forbidden");
  const metadata = normalizeRecipientVersionV1({ ...broken, metadata: { address: valid[0].input.address } });
  assert.equal(metadata.error.code, "authoritative_metadata_forbidden");
  const harmless = normalizeRecipientVersionV1({ ...valid[0].input, display: { label: "Treasury" }, metadata: { order_type: "test" } });
  assert.equal(harmless.ok, true);
});

function paymentRequest(input) {
  const base = {
    protocol: PAYMENT_REQUEST_PROTOCOL,
    request_id: "pr_recipient_validation",
    connection_id: "conn_recipient_validation",
    created_at: "2026-08-01T16:00:00.000Z",
    expires_at: "2026-08-01T17:00:00.000Z",
    status: "pending",
    source: { type: "agent", name: "Fixture" },
    payee: { name: "Fixture merchant" },
    payment: {
      rail: input.rail || "stellar_xlm",
      network: input.network,
      asset: input.asset,
      amount: "1",
      to: input.address,
      ...(input.contract ? { token_contract: input.contract } : {}),
      ...(input.issuer ? { issuer: input.issuer } : {}),
      ...(input.memo ? { memo: input.memo } : {}),
      ...(input.rail === "base_usdc" ? { chain_id: 8453, decimals: 6 } : {})
    },
    policy: { requires_user_approval: true }
  };
  return base;
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
