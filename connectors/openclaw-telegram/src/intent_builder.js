import { buildPaymentRequestPayload, buildVelarumRequest } from "./velarum_adapter.js";

export function buildPaymentIntent(payment, source = {}) {
  const paymentRequest = buildPaymentRequest(payment, source);
  const velarum = buildVelarumRequest(payment, source, { paymentRequest });
  const enrichedPayment = { ...paymentRequest.payment };
  if (paymentRequest.payment.rail === "base_usdc") {
    enrichedPayment.rpc_url = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  }
  if (paymentRequest.payment.rail === "stellar_xlm") {
    enrichedPayment.horizon_url = process.env.STELLAR_HORIZON_URL || "https://horizon.stellar.org";
    enrichedPayment.stellar_testnet = enrichedPayment.network === "stellar_testnet";
  }
  return {
    protocol: "agentwallet.payment_intent.v1",
    request_id: paymentRequest.request_id,
    transaction_id: paymentRequest.transaction_id,
    connection_id: paymentRequest.connection_id,
    created_at: paymentRequest.created_at,
    expires_at: paymentRequest.expires_at,
    target_app_device_id: process.env.TARGET_APP_DEVICE_ID || "",
    source: {
      type: "openclaw",
      device_id: paymentRequest.source.device_id,
      channel: "telegram",
      agent_id: paymentRequest.source.agent_id,
      agent_name: paymentRequest.source.agent_name,
      runtime: paymentRequest.source.runtime,
      telegram_chat_id_hash: source.telegram_chat_id_hash || ""
    },
    velarum,
    payment_request: paymentRequest,
    payee: paymentRequest.payee,
    payment: enrichedPayment,
    display: {
      ...paymentRequest.display,
      button: paymentRequest.display.primary_action || "Pay"
    },
    metadata: paymentRequest.metadata,
    policy: paymentRequest.policy,
    risk: {
      warnings: ["Requested from Telegram", "Review recipient and amount on the phone"]
    },
    idempotency_key: paymentRequest.idempotency_key
  };
}

export function buildPaymentRequest(payment, source = {}) {
  return buildPaymentRequestPayload(payment, source);
}
