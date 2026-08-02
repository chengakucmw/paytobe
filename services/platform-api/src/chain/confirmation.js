// On-chain confirmation polling for broadcasted payment intents.
//
// Needs the store and the WS notify helpers, so it's produced by a factory
// wired once at startup. Only confirmLater is returned; waitForConfirmation /
// evmReceipt / stellarTransaction / sleep are internal. confirmLater closes
// over the SAME notify helpers the server uses, which the regression test
// relies on (it seeds the openclaw socket map, then calls confirmLater).

import { stellarConfirmationResult } from "../risk.js";

export function createConfirmation({ store, notifyApp, notifyOpenClaw }) {
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
        const stellar = await stellarTransaction(payment.horizon_url, txHash);
        const result = stellarConfirmationResult(stellar);
        if (result) return result;
      }
      await sleep(4000);
    }
    return { ok: false, error: "Confirmation timeout" };
  }

  return { confirmLater };
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
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
