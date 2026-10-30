import assert from "node:assert/strict";
import test from "node:test";

import {
  createConfirmation,
  validateStellarPaymentConfirmation
} from "../../services/platform-api/src/chain/confirmation.js";

test("formal Stellar testnet request uses the server-approved Horizon when its stored payment omits a URL", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    const body = String(url).includes("/operations")
      ? { _embedded: { records: [{ type: "payment", asset_type: "native", to: "GDEST", amount: "0.0100000" }] } }
      : { successful: true, operation_count: 1, memo_type: "none" };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const confirmation = createConfirmation({
    store: null,
    notifyApp() {},
    notifyOpenClaw() {},
    stellarTestnetHorizonUrl: "https://horizon-testnet.stellar.org"
  });
  const result = await confirmation.confirmPaymentRequestLater({
    payment: { rail: "stellar_xlm", network: "stellar_testnet", asset: "XLM", amount: "0.01", to: "GDEST", memo: null }
  }, "tx_success", (status, patch) => ({ status, patch }));

  assert.deepEqual(requestedUrls, [
    "https://horizon-testnet.stellar.org/transactions/tx_success",
    "https://horizon-testnet.stellar.org/transactions/tx_success/operations?limit=20&order=asc"
  ]);
  assert.deepEqual(result, {
    status: "confirmed",
    patch: { tx_hash: "tx_success", error: null }
  });
});

test("formal Stellar confirmation rejects a successful transaction whose immutable payment facts differ", () => {
  const request = {
    payment: { asset: "XLM", amount: "0.01", to: "GDEST", memo: null }
  };
  const transaction = {
    successful: true,
    operation_count: 1,
    memo_type: "none",
    _Paytobe_operations: [{ type: "payment", asset_type: "native", to: "GATTACKER", amount: "0.0100000" }]
  };
  assert.deepEqual(validateStellarPaymentConfirmation(request, transaction), {
    ok: false,
    error: "Stellar transaction does not match Payment Request recipient"
  });
});

test("one-time recovery accepts the affected legacy null-text memo only with matching payment facts", () => {
  const result = validateStellarPaymentConfirmation({
    error: "Missing Stellar Horizon URL for confirmation",
    payment: { asset: "XLM", amount: "0.01", to: "GDEST", memo: null }
  }, {
    successful: true,
    operation_count: 1,
    memo_type: "text",
    memo: "null",
    _Paytobe_operations: [{ type: "payment", asset_type: "native", to: "GDEST", amount: "0.0100000" }]
  });
  assert.deepEqual(result, { ok: true });
});
