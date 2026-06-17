import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BASE_USDC_CONTRACT,
  PAYMENT_RAILS,
  PAYMENT_STATUSES,
  PAIRING_SCOPES,
  RISK_SEVERITIES,
  SOURCE_TYPES,
  VERIFICATION_STATUSES,
  normalizePaymentRequestV1,
  normalizeTransactionContextV1,
  paymentRequestFixtures,
  protocolFixtureClock,
  transactionContextFixtures
} from "../../packages/protocol/src/index.js";
import {
  normalizePaymentRequestV1 as normalizeApiPaymentRequestV1
} from "../../services/platform-api/src/velarum.js";
import {
  normalizeTransactionContextV1 as normalizeApiTransactionContextV1
} from "../../services/platform-api/src/velarum.js";
import { Store } from "../../services/platform-api/src/store.js";

test("protocol enums cover v0.1 shared contracts", () => {
  for (const rail of ["stellar_xlm", "base_usdc", "evm_erc20"]) assert.ok(PAYMENT_RAILS.includes(rail));
  for (const status of ["pending", "signed", "broadcasted", "confirmed", "failed", "expired", "rejected"]) {
    assert.ok(PAYMENT_STATUSES.includes(status));
  }
  for (const sourceType of ["payment_request_fact", "merchant_signed_quote", "merchant_ai_claim", "user_agent_inferred"]) {
    assert.ok(SOURCE_TYPES.includes(sourceType));
  }
  for (const status of ["signature_verified", "address_verified", "ai_claim_only", "inferred_only", "missing"]) {
    assert.ok(VERIFICATION_STATUSES.includes(status));
  }
  for (const severity of ["blocker", "warning", "review_required"]) assert.ok(RISK_SEVERITIES.includes(severity));
  for (const scope of ["request_payments", "create_transaction_contexts", "view_balances"]) {
    assert.ok(PAIRING_SCOPES.includes(scope));
  }
});

test("valid Base USDC Payment Request normalizes stable payment facts", () => {
  const result = normalizePaymentRequestV1(paymentRequestFixtures.valid_base_usdc, { now: protocolFixtureClock.now });
  assert.equal(result.ok, true);
  assert.equal(result.value.payment.rail, "base_usdc");
  assert.equal(result.value.payment.asset, "USDC");
  assert.equal(result.value.payment.network, "base_mainnet");
  assert.equal(result.value.payment.amount, "24.00");
  assert.equal(result.value.payment.to, "0x9b1c2f4e3a8d5c6b7e9f0a1b2c3d4e5f60718293");
  assert.equal(result.value.payment.token_contract, BASE_USDC_CONTRACT);
  assert.equal(result.value.payment.chain_id, 8453);
  assert.equal(result.value.payment.decimals, 6);
});

test("legacy evm_erc20 Base alias normalizes to base_usdc with warning", () => {
  const result = normalizePaymentRequestV1(paymentRequestFixtures.legacy_base_alias, { now: protocolFixtureClock.now });
  assert.equal(result.ok, true);
  assert.equal(result.value.payment.rail, "base_usdc");
  assert.equal(result.warnings.some((warning) => warning.code === "legacy_rail_alias"), true);
});

test("valid Stellar XLM Payment Request is accepted", () => {
  const result = normalizePaymentRequestV1(paymentRequestFixtures.valid_stellar_xlm, { now: protocolFixtureClock.now });
  assert.equal(result.ok, true);
  assert.equal(result.value.payment.rail, "stellar_xlm");
  assert.equal(result.value.payment.asset, "XLM");
  assert.equal(result.value.payment.network, "stellar_testnet");
});

test("Payment Request negative fixtures return structured errors", () => {
  const wrongProtocol = normalizePaymentRequestV1({
    ...paymentRequestFixtures.valid_base_usdc,
    protocol: "agentwallet.payment_intent.v1"
  }, { now: protocolFixtureClock.now });
  assert.equal(wrongProtocol.ok, false);
  assert.equal(wrongProtocol.error.code, "invalid_protocol");

  const missingTo = normalizePaymentRequestV1({
    ...paymentRequestFixtures.valid_base_usdc,
    payment: { ...paymentRequestFixtures.valid_base_usdc.payment, to: "" }
  }, { now: protocolFixtureClock.now });
  assert.equal(missingTo.ok, false);
  assert.equal(missingTo.error.code, "invalid_payment_request");
  assert.equal(missingTo.error.details.field, "payment.to");

  const floatAmount = normalizePaymentRequestV1({
    ...paymentRequestFixtures.valid_base_usdc,
    payment: { ...paymentRequestFixtures.valid_base_usdc.payment, amount: 24 }
  }, { now: protocolFixtureClock.now });
  assert.equal(floatAmount.ok, false);
  assert.equal(floatAmount.error.code, "invalid_decimal_string");

  const expired = normalizePaymentRequestV1(paymentRequestFixtures.expired, { now: protocolFixtureClock.now });
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, "expired_request");

  const unsupported = normalizePaymentRequestV1({
    ...paymentRequestFixtures.valid_base_usdc,
    payment: { ...paymentRequestFixtures.valid_base_usdc.payment, rail: "solana_spl" }
  }, { now: protocolFixtureClock.now });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.code, "unsupported_rail");
});

test("prototype-aligned Payment Request fixtures preserve hard fields", () => {
  for (const name of ["missing_context", "mismatch", "ai_only"]) {
    const result = normalizePaymentRequestV1(paymentRequestFixtures[name], { now: protocolFixtureClock.now });
    assert.equal(result.ok, true, name);
    assert.equal(result.value.payment.amount, paymentRequestFixtures[name].payment.amount);
    assert.equal(result.value.payment.to, paymentRequestFixtures[name].payment.to);
    assert.equal(result.value.payment.asset, paymentRequestFixtures[name].payment.asset);
    assert.equal(result.value.payment.network, paymentRequestFixtures[name].payment.network);
  }
});

test("network-disabled fixture produces structured network error", () => {
  const result = normalizePaymentRequestV1(paymentRequestFixtures.network_disabled, { now: protocolFixtureClock.now });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unsupported_network");
  assert.equal(result.error.details.field, "payment.network");
});

test("valid Transaction Context Lite normalizes and keeps dossier fields", () => {
  const result = normalizeTransactionContextV1(transactionContextFixtures.valid, { now: protocolFixtureClock.now });
  assert.equal(result.ok, true);
  assert.equal(result.value.transaction_id, "txn_agentfood_1842");
  assert.equal(result.value.user_intent.prompt_summary.includes("Order dinner"), true);
  assert.equal(result.value.agent_activity.length, 3);
  assert.equal(result.value.items.length, 2);
  assert.equal(result.value.costs.total, "24.00");
  assert.equal(result.value.evidence.length, 2);
  assert.equal(result.value.truth_fields.length, 2);
});

test("Transaction Context negative fixtures return structured errors", () => {
  const missingId = normalizeTransactionContextV1({
    ...transactionContextFixtures.valid,
    transaction_id: ""
  }, { now: protocolFixtureClock.now });
  assert.equal(missingId.ok, false);
  assert.equal(missingId.error.code, "invalid_transaction_context");

  const wrongProtocol = normalizeTransactionContextV1({
    ...transactionContextFixtures.valid,
    protocol: "velarum.transaction_context.v0"
  }, { now: protocolFixtureClock.now });
  assert.equal(wrongProtocol.ok, false);
  assert.equal(wrongProtocol.error.code, "invalid_protocol");

  const missingSummary = normalizeTransactionContextV1({
    ...transactionContextFixtures.valid,
    summary: ""
  }, { now: protocolFixtureClock.now });
  assert.equal(missingSummary.ok, false);
  assert.equal(missingSummary.error.details.field, "summary");
});

test("missing, mismatch, and ai_only context fixtures express prototype review states", () => {
  const missing = normalizeTransactionContextV1(transactionContextFixtures.missing_context, { now: protocolFixtureClock.now });
  assert.equal(missing.ok, true);
  assert.equal(missing.value.missing_context.length > 0, true);
  assert.equal(missing.value.risk_findings.some((finding) => finding.code === "critical_field_missing_evidence"), true);

  const mismatch = normalizeTransactionContextV1(transactionContextFixtures.mismatch, { now: protocolFixtureClock.now });
  assert.equal(mismatch.ok, true);
  assert.equal(mismatch.value.risk_findings.some((finding) => finding.severity === "blocker"), true);

  const aiOnly = normalizeTransactionContextV1(transactionContextFixtures.ai_only, { now: protocolFixtureClock.now });
  assert.equal(aiOnly.ok, true);
  assert.equal(aiOnly.warnings.some((warning) => warning.code === "merchant_ai_claim_only"), true);
  assert.equal(aiOnly.warnings.some((warning) => warning.code === "critical_field_ai_inferred"), true);
});

test("Platform API Payment Request wrapper returns hard payment facts", () => {
  const result = normalizeApiPaymentRequestV1({
    ...paymentRequestFixtures.valid_base_usdc,
    display: {
      title: "Pay 999 USDC",
      summary: "Display copy must not override payment facts"
    },
    metadata: {
      demo_amount: "999.00",
      demo_recipient: "0x0000000000000000000000000000000000000000"
    }
  }, { now: protocolFixtureClock.now });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.payment_facts, {
    amount: "24.00",
    token: "USDC",
    network: "base_mainnet",
    recipient: "0x9b1c2f4e3a8d5c6b7e9f0a1b2c3d4e5f60718293",
    fee: "0.01",
    total: "24.01",
    payee: paymentRequestFixtures.valid_base_usdc.payee
  });
});

test("Platform API Payment Request wrapper returns structured errors", () => {
  const expired = normalizeApiPaymentRequestV1(paymentRequestFixtures.expired, { now: protocolFixtureClock.now });
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, "expired_request");
  assert.equal(Array.isArray(expired.errors), true);
});

test("Platform API Transaction Context wrapper returns structured results", () => {
  const valid = normalizeApiTransactionContextV1(transactionContextFixtures.valid, { now: protocolFixtureClock.now });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.transaction_id, "txn_agentfood_1842");

  const invalid = normalizeApiTransactionContextV1({
    ...transactionContextFixtures.valid,
    title: ""
  }, { now: protocolFixtureClock.now });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "invalid_transaction_context");
  assert.equal(invalid.error.details.field, "title");
});

test("Platform API Store persists and reads Transaction Context by transaction_id", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "velarumpay-store-"));
  try {
    const store = new Store(path.join(dir, "store.json"));
    const normalized = normalizeApiTransactionContextV1(transactionContextFixtures.missing_context, {
      now: protocolFixtureClock.now
    });
    assert.equal(normalized.ok, true);

    const stored = store.putTransactionContext(normalized.value);
    const fetched = store.transactionContext("txn_missing_evidence_169");
    assert.deepEqual(fetched, stored);
    assert.equal(fetched.items.length, 0);
    assert.equal(fetched.costs.total, "169.00");
    assert.equal(fetched.agent_activity.length, 2);
    assert.equal(fetched.provenance.model, "truth_layer_v1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
