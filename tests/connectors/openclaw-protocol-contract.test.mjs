// Contract test: the OpenClaw Telegram connector is intentionally self-contained
// (no runtime dependency on @Paytobe/protocol — see Paytobe_adapter.js), so it
// keeps LOCAL copies of a few protocol constants. That is fine for deployment but
// risks silent drift: if the protocol enum/constants change and the connector's
// mirror doesn't, the money/context-validation paths diverge.
//
// This test locks the two together WITHOUT coupling them at runtime: it fails the
// moment the connector's local mirror disagrees with the canonical protocol
// package. It is the anti-drift guarantee the assessment asked for, achieved with
// a test rather than a dependency (the sibling connectors don't import protocol
// either — they use @Paytobe/sdk-js).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PAYMENT_REQUEST_PROTOCOL as ADAPTER_PROTOCOL,
  BASE_USDC_CONTRACT as ADAPTER_BASE_USDC,
  VALID_CONTEXT_TYPES as ADAPTER_CONTEXT_TYPES,
  normalizePayment
} from "../../connectors/openclaw-telegram/src/Paytobe_adapter.js";

import {
  PAYMENT_REQUEST_PROTOCOL,
  BASE_USDC_CONTRACT,
  TRANSACTION_CONTEXT_TYPES,
  findSupportedTransferAsset,
  validateTransferAddress,
  SUPPORTED_TRANSFER_RAILS
} from "../../packages/protocol/src/index.js";

test("OpenClaw protocol id stays in sync with @Paytobe/protocol", () => {
  assert.equal(
    ADAPTER_PROTOCOL,
    PAYMENT_REQUEST_PROTOCOL,
    "Paytobe_adapter.PAYMENT_REQUEST_PROTOCOL drifted from protocol package"
  );
});

test("OpenClaw Base USDC contract stays in sync with @Paytobe/protocol", () => {
  assert.equal(
    ADAPTER_BASE_USDC.toLowerCase(),
    BASE_USDC_CONTRACT.toLowerCase(),
    "Paytobe_adapter.BASE_USDC_CONTRACT drifted from protocol package — this is a money address allowlist; drift here is dangerous"
  );
});

test("OpenClaw context-type enum stays in sync with protocol TRANSACTION_CONTEXT_TYPES", () => {
  const adapter = [...ADAPTER_CONTEXT_TYPES].sort();
  const canonical = [...TRANSACTION_CONTEXT_TYPES].sort();
  assert.deepEqual(
    adapter,
    canonical,
    "Paytobe_adapter.VALID_CONTEXT_TYPES drifted from protocol TRANSACTION_CONTEXT_TYPES — update both together"
  );
});

// ---------------------------------------------------------------------------
// Money-validation facts (added 2026-06-20).
//
// The three checks above lock the protocol id, the USDC contract address, and the
// context-type enum. But normalizePayment() ALSO hardcodes other money-critical
// facts — chain_id, decimals, the recipient address rules, and the set of rails it
// accepts. Those currently match the protocol package, yet nothing prevented them
// from drifting apart. We lock them too, by driving the connector's exported
// normalizePayment() and comparing its output/behaviour against the canonical
// protocol asset registry. Still test-only: the connector keeps zero runtime
// dependency on @Paytobe/protocol.
// ---------------------------------------------------------------------------

// Minimal recipient samples that satisfy the protocol's own address rules.
const VALID_EVM_ADDRESS = "0x" + "a".repeat(40);     // matches /^0x[0-9a-fA-F]{40}$/
const VALID_STELLAR_ADDRESS = "G" + "A".repeat(55);  // matches /^G[A-Z2-7]{55}$/

// Rails the OpenClaw connector implements today. Kept explicit so adding a new
// rail to the connector is a conscious edit that must also extend this list.
const ADAPTER_SUPPORTED_RAILS = ["base_usdc", "stellar_xlm"];

test("OpenClaw base_usdc money facts stay in sync with protocol asset registry", () => {
  const usdc = findSupportedTransferAsset({ rail: "base_usdc" });
  assert.ok(usdc, "protocol package no longer defines a base_usdc asset");

  const out = normalizePayment({
    rail: "base_usdc",
    network: "base_mainnet",
    asset: "USDC",
    amount: "1.50",
    to: VALID_EVM_ADDRESS
  });

  assert.equal(Number(out.chain_id), Number(usdc.chain_id),
    "adapter base_usdc chain_id drifted from protocol asset registry — money path");
  assert.equal(Number(out.decimals), Number(usdc.decimals),
    "adapter base_usdc decimals drifted from protocol asset registry — money path");
  assert.equal(out.token_contract.toLowerCase(), usdc.token_contract.toLowerCase(),
    "adapter base_usdc token_contract drifted from protocol asset registry — money path");
  assert.equal(out.network, usdc.network,
    "adapter base_usdc network drifted from protocol asset registry");
});

test("OpenClaw rejects base_usdc facts the protocol registry would not allow", () => {
  const base = { rail: "base_usdc", network: "base_mainnet", asset: "USDC", amount: "1", to: VALID_EVM_ADDRESS };
  // Locks the adapter's guards to the protocol's chain_id (8453) and decimals (6).
  assert.throws(() => normalizePayment({ ...base, chain_id: 1 }),
    "adapter accepted a base_usdc chain_id the protocol registry does not use");
  assert.throws(() => normalizePayment({ ...base, decimals: 18 }),
    "adapter accepted base_usdc decimals the protocol registry does not use");
});

test("OpenClaw recipient address rules match protocol validateTransferAddress", () => {
  const usdc = findSupportedTransferAsset({ rail: "base_usdc" });
  const xlm = findSupportedTransferAsset({ rail: "stellar_xlm" });

  // EVM asset: protocol accepts an 0x… address and rejects a Stellar G… address.
  assert.ok(validateTransferAddress(usdc, VALID_EVM_ADDRESS));
  assert.ok(!validateTransferAddress(usdc, VALID_STELLAR_ADDRESS));
  // The connector must agree on both.
  assert.doesNotThrow(() =>
    normalizePayment({ rail: "base_usdc", network: "base_mainnet", asset: "USDC", amount: "1", to: VALID_EVM_ADDRESS }));
  assert.throws(() =>
    normalizePayment({ rail: "base_usdc", network: "base_mainnet", asset: "USDC", amount: "1", to: VALID_STELLAR_ADDRESS }));

  // Stellar asset: mirror image.
  assert.ok(validateTransferAddress(xlm, VALID_STELLAR_ADDRESS));
  assert.ok(!validateTransferAddress(xlm, VALID_EVM_ADDRESS));
  assert.doesNotThrow(() =>
    normalizePayment({ rail: "stellar_xlm", network: "stellar_public", asset: "XLM", amount: "1", to: VALID_STELLAR_ADDRESS }));
  assert.throws(() =>
    normalizePayment({ rail: "stellar_xlm", network: "stellar_public", asset: "XLM", amount: "1", to: VALID_EVM_ADDRESS }));
});

test("OpenClaw supported rails are all recognized by the protocol registry", () => {
  for (const rail of ADAPTER_SUPPORTED_RAILS) {
    assert.ok(SUPPORTED_TRANSFER_RAILS.includes(rail),
      `adapter rail "${rail}" is not in protocol SUPPORTED_TRANSFER_RAILS`);
    assert.ok(findSupportedTransferAsset({ rail }),
      `protocol package has no asset for adapter rail "${rail}"`);
  }
  // The evm_erc20 alias must still normalize to the canonical base_usdc rail.
  const aliased = normalizePayment({
    rail: "evm_erc20", network: "base_mainnet", asset: "USDC", amount: "1", to: VALID_EVM_ADDRESS
  });
  assert.equal(aliased.rail, "base_usdc", "adapter evm_erc20 alias no longer maps to base_usdc");
});
