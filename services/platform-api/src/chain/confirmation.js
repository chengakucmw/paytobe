// On-chain confirmation polling for broadcasted Payment Intents and Payment Requests.
//
// Needs the store and the WS notify helpers, so it's produced by a factory
// wired once at startup. waitForConfirmation / evmReceipt / stellarTransaction /
// sleep remain internal. The returned confirmation functions close
// over the SAME notify helpers the server uses, which the regression test
// relies on (it seeds the openclaw socket map, then calls confirmLater).

import { stellarConfirmationResult } from "../risk.js";
import { compareDecimalStrings } from "../decimal.js";

const RECOVERABLE_MISSING_HORIZON_ERROR = "Missing Stellar Horizon URL for confirmation";

export function createConfirmation({ store, notifyApp, notifyOpenClaw, stellarTestnetHorizonUrl = "" }) {
  async function confirmLater(intent, txHash) {
    try {
      const confirmed = await waitForConfirmation(intent, txHash);
      const status = confirmed.ok ? "confirmed" : "failed";
      const updated = store.updateStatus(intent.intent_id, status, {
        tx_hash: txHash,
        error: confirmed.error || null
      });
      // F1: settle the held reservation into confirmed spend, or release it back to
      // the cap when the broadcast did not confirm.
      if (status === "confirmed") {
        store.settleDailyReservation(intent.intent_id, intent.payment.asset, intent.payment.amount);
      } else {
        store.releaseDailyReservation(intent.intent_id);
      }
      notifyOpenClaw(intent.source?.device_id, {
        type: "payment_status",
        intent_id: intent.intent_id,
        status,
        tx_hash: txHash,
        error: confirmed.error || null
      });
      // M3: `updated` is null when the intent no longer exists (it expired and was
      // pruned while we awaited confirmation). Dereferencing it here used to throw
      // inside this detached async task — an unhandled rejection that took down the
      // process and meant the final status update was never delivered.
      if (updated) {
        notifyApp(updated.target_app_device_id, {
          type: "payment_intent",
          intent_id: updated.intent_id,
          status: updated.status
        });
      }
    } catch (error) {
      const updated = store.updateStatus(intent.intent_id, "failed", {
        tx_hash: txHash,
        error: error.message
      });
      // F1: the broadcast errored out — release the held cap reservation.
      store.releaseDailyReservation(intent.intent_id);
      notifyOpenClaw(intent.source?.device_id, {
        type: "payment_status",
        intent_id: intent.intent_id,
        status: "failed",
        tx_hash: txHash,
        error: error.message
      });
      if (updated) {
        notifyApp(updated.target_app_device_id, {
          type: "payment_intent",
          intent_id: updated.intent_id,
          status: updated.status
        });
      }
    }
  }

  async function confirmPaymentRequestLater(request, txHash, onResult) {
    if (typeof onResult !== "function") throw new TypeError("Payment Request confirmation callback is required");
    let result;
    try {
      result = await waitForConfirmation(request, txHash);
    } catch (error) {
      result = { ok: false, error: error?.message || "Confirmation failed" };
    }
    return onResult(result.ok ? "confirmed" : "failed", {
      tx_hash: txHash,
      error: result.error || null
    });
  }

  async function waitForConfirmation(intent, txHash) {
    const payment = intent.payment || {};
    for (let attempt = 0; attempt < 30; attempt++) {
      if (payment.rail === "evm_erc20" || payment.rail === "base_usdc") {
        const receipt = await evmReceipt(payment.rpc_url, txHash);
        if (receipt) {
          if (receipt.status === "0x1") return { ok: true };
          return { ok: false, error: "EVM transaction reverted" };
        }
      }
      if (payment.rail === "stellar_xlm") {
        const horizonUrl = payment.horizon_url
          || (payment.network === "stellar_testnet" ? stellarTestnetHorizonUrl : "");
        const stellar = await stellarTransaction(horizonUrl, txHash);
        const result = validateStellarPaymentConfirmation(intent, stellar);
        if (result) return result;
      }
      await sleep(4000);
    }
    return { ok: false, error: "Confirmation timeout" };
  }

  return { confirmLater, confirmPaymentRequestLater };
}

async function evmReceipt(rpcUrl, txHash) {
  if (!rpcUrl) throw new Error("Missing EVM RPC URL for confirmation");
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionReceipt",
      params: [txHash]
    })
  });
  const json = await response.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result || null;
}

async function stellarTransaction(horizonUrl, txHash) {
  if (!horizonUrl) throw new Error("Missing Stellar Horizon URL for confirmation");
  const base = horizonUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/transactions/${txHash}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Horizon HTTP ${response.status}: ${await response.text()}`);
  const transaction = await response.json();
  if (transaction.successful !== true) return transaction;
  const operationsResponse = await fetch(`${base}/transactions/${txHash}/operations?limit=20&order=asc`);
  if (!operationsResponse.ok) {
    throw new Error(`Horizon operations HTTP ${operationsResponse.status}: ${await operationsResponse.text()}`);
  }
  const operations = await operationsResponse.json();
  return { ...transaction, _velarum_operations: operations?._embedded?.records || [] };
}

export function validateStellarPaymentConfirmation(request, stellar) {
  const chainResult = stellarConfirmationResult(stellar);
  if (!chainResult || !chainResult.ok) return chainResult;
  const payment = request?.payment || {};
  const operations = stellar?._velarum_operations;
  if (stellar.operation_count !== 1 || !Array.isArray(operations) || operations.length !== 1) {
    return mismatch("operation_count");
  }
  const operation = operations[0];
  const createAccount = operation.type === "create_account";
  if (operation.type !== "payment" && !createAccount) return mismatch("operation_type");
  if (!createAccount && operation.asset_type !== "native") return mismatch("asset");
  const recipient = createAccount ? operation.account : operation.to;
  const amount = createAccount ? operation.starting_balance : operation.amount;
  if (!payment.to || recipient !== payment.to) return mismatch("recipient");
  try {
    if (compareDecimalStrings(String(amount || ""), String(payment.amount || "")) !== 0) return mismatch("amount");
  } catch {
    return mismatch("amount");
  }

  const expectedMemo = payment.memo == null ? "" : String(payment.memo);
  const expectedMemoType = String(payment.memo_type || payment.memoType || (expectedMemo ? "text" : "none")).toLowerCase();
  const actualMemo = stellar.memo == null ? "" : String(stellar.memo);
  const actualMemoType = String(stellar.memo_type || (actualMemo ? "text" : "none")).toLowerCase();
  const legacyNullMemo = !expectedMemo
    && request?.error === RECOVERABLE_MISSING_HORIZON_ERROR
    && actualMemoType === "text"
    && actualMemo === "null";
  if (!legacyNullMemo && (actualMemoType !== expectedMemoType || actualMemo !== expectedMemo)) return mismatch("memo");
  return { ok: true };
}

function mismatch(field) {
  return { ok: false, error: `Stellar transaction does not match Payment Request ${field}` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
