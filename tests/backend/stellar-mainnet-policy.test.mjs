import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePaymentRequest,
  stellarPublicPolicyViolations
} from "../../services/platform-api/src/risk.js";

const RECIPIENT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const OTHER = "GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H";

function payment(overrides = {}) {
  return {
    rail: "stellar_xlm",
    network: "stellar_public",
    asset: "XLM",
    amount: "0.1",
    to: RECIPIENT,
    horizon_url: "https://horizon.stellar.org",
    ...overrides
  };
}

function enabledEnv(overrides = {}) {
  return {
    STELLAR_PUBLIC_ENABLED: "true",
    STELLAR_PUBLIC_SINGLE_PAYMENT_MAX_XLM: "1",
    STELLAR_PUBLIC_HORIZON_URL: "https://horizon.stellar.org",
    ADDRESS_WHITELIST_STELLAR: RECIPIENT,
    ...overrides
  };
}

const codes = (items) => items.map((item) => item.code);

test("Stellar public network is disabled by default", () => {
  const result = stellarPublicPolicyViolations(payment(), {});
  assert.ok(codes(result).includes("stellar_mainnet_disabled"));
});

test("an enabled, allowlisted small XLM payment passes the mainnet gate", () => {
  assert.deepEqual(stellarPublicPolicyViolations(payment(), enabledEnv()), []);
});

test("mainnet gate rejects over-limit amount, endpoint mismatch, and unknown recipient", () => {
  const result = stellarPublicPolicyViolations(payment({
    amount: "1.0000001",
    to: OTHER,
    horizon_url: "https://example.invalid/horizon"
  }), enabledEnv());
  assert.deepEqual(new Set(codes(result)), new Set([
    "stellar_mainnet_amount_exceeded",
    "stellar_horizon_not_approved",
    "recipient_not_whitelisted"
  ]));
});

test("mainnet gate requires a non-empty recipient allowlist", () => {
  const result = stellarPublicPolicyViolations(payment(), enabledEnv({ ADDRESS_WHITELIST_STELLAR: "" }));
  assert.ok(codes(result).includes("stellar_mainnet_recipient_allowlist_required"));
});

test("mainnet gate validates the Stellar StrKey checksum", () => {
  const invalid = `G${"A".repeat(55)}`;
  const result = stellarPublicPolicyViolations(payment({ to: invalid }), enabledEnv({
    ADDRESS_WHITELIST_STELLAR: invalid
  }));
  assert.ok(codes(result).includes("invalid_stellar_recipient"));
});

test("mainnet policy is a blocker even without a daily-limit store", () => {
  const result = evaluatePaymentRequest({
    transaction_id: "tx_mainnet_policy",
    payment: payment()
  }, {}, null, {});
  assert.equal(result.signing_allowed, false);
  assert.ok(codes(result.errors).includes("stellar_mainnet_disabled"));
});

test("Stellar testnet is outside the production mainnet gate", () => {
  assert.deepEqual(stellarPublicPolicyViolations(payment({
    network: "stellar_testnet",
    stellar_testnet: true,
    horizon_url: "https://horizon-testnet.stellar.org"
  }), {}), []);
});
