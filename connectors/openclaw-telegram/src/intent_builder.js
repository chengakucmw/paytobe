import { buildVelarumRequest } from "./velarum_adapter.js";

export function buildPaymentIntent(payment, source) {
  const velarum = buildVelarumRequest(payment, source);
  const now = new Date();
  const expires = new Date(Date.now() + 5 * 60 * 1000);
  const enrichedPayment = { ...payment };
  if (payment.rail === "evm_erc20") {
    enrichedPayment.rpc_url = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  }
  if (payment.rail === "stellar_xlm") {
    enrichedPayment.horizon_url = process.env.STELLAR_HORIZON_URL || "https://horizon.stellar.org";
    enrichedPayment.stellar_testnet = enrichedPayment.network === "stellar_testnet";
  }
  return {
    protocol: "agentwallet.payment_intent.v1",
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    target_app_device_id: process.env.TARGET_APP_DEVICE_ID || "",
    source: {
      type: "openclaw",
      device_id: process.env.OPENCLAW_DEVICE_ID || "mac-openclaw-01",
      channel: "telegram",
      telegram_chat_id_hash: source.telegram_chat_id_hash || ""
    },
    velarum,
    payment: enrichedPayment,
    display: {
      title: payment.asset === "USDC" ? `Send ${payment.amount} USDC` : `Send ${payment.amount} XLM`,
      summary: "OpenClaw requested a payment from Telegram.",
      button: "Pay"
    },
    risk: {
      warnings: ["Requested from Telegram", "Review recipient and amount on the phone"]
    },
    idempotency_key: source.idempotency_key
  };
}

