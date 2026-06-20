// Contract test: the OpenClaw Telegram connector is intentionally self-contained
// (no runtime dependency on @velarumpay/protocol — see velarum_adapter.js), so it
// keeps LOCAL copies of a few protocol constants. That is fine for deployment but
// risks silent drift: if the protocol enum/constants change and the connector's
// mirror doesn't, the money/context-validation paths diverge.
//
// This test locks the two together WITHOUT coupling them at runtime: it fails the
// moment the connector's local mirror disagrees with the canonical protocol
// package. It is the anti-drift guarantee the assessment asked for, achieved with
// a test rather than a dependency (the sibling connectors don't import protocol
// either — they use @velarumpay/sdk-js).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PAYMENT_REQUEST_PROTOCOL as ADAPTER_PROTOCOL,
  BASE_USDC_CONTRACT as ADAPTER_BASE_USDC,
  VALID_CONTEXT_TYPES as ADAPTER_CONTEXT_TYPES
} from "../../connectors/openclaw-telegram/src/velarum_adapter.js";

import {
  PAYMENT_REQUEST_PROTOCOL,
  BASE_USDC_CONTRACT,
  TRANSACTION_CONTEXT_TYPES
} from "../../packages/protocol/src/index.js";

test("OpenClaw protocol id stays in sync with @velarumpay/protocol", () => {
  assert.equal(
    ADAPTER_PROTOCOL,
    PAYMENT_REQUEST_PROTOCOL,
    "velarum_adapter.PAYMENT_REQUEST_PROTOCOL drifted from protocol package"
  );
});

test("OpenClaw Base USDC contract stays in sync with @velarumpay/protocol", () => {
  assert.equal(
    ADAPTER_BASE_USDC.toLowerCase(),
    BASE_USDC_CONTRACT.toLowerCase(),
    "velarum_adapter.BASE_USDC_CONTRACT drifted from protocol package — this is a money address allowlist; drift here is dangerous"
  );
});

test("OpenClaw context-type enum stays in sync with protocol TRANSACTION_CONTEXT_TYPES", () => {
  const adapter = [...ADAPTER_CONTEXT_TYPES].sort();
  const canonical = [...TRANSACTION_CONTEXT_TYPES].sort();
  assert.deepEqual(
    adapter,
    canonical,
    "velarum_adapter.VALID_CONTEXT_TYPES drifted from protocol TRANSACTION_CONTEXT_TYPES — update both together"
  );
});
