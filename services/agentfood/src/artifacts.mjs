import crypto from "node:crypto";

export function buildTestnetArtifacts(order, config, now = new Date()) {
  const createdAt = now.toISOString();
  const transactionId = `txn_${order.order_id}`;
  const amount = order.settlement.amount;
  const source = {
    agent_id: config.platform.agentId,
    agent_name: "AgentFood Production Connector",
    runtime: "node",
    channel: "independent_service"
  };
  const context = {
    protocol: "velarum.transaction_context.v1",
    transaction_id: transactionId,
    created_at: createdAt,
    type: "generic",
    status: "awaiting_payment",
    title: "AgentFood official testnet demonstration",
    summary: `A real transaction flow for ${amount} test XLM was requested for a mock AgentFood order. No food will be fulfilled.`,
    source,
    user_intent: { prompt_summary: "Create an official testnet payment for a mock AgentFood order." },
    agent_activity: [
      {
        at: createdAt,
        action: "mock_order_created",
        label: "Created a mock order",
        summary: "Merchant, menu, price, and fulfillment data are representative only.",
        source_type: "merchant_ai_claim"
      },
      {
        at: createdAt,
        action: "payment_requested",
        label: "Requested a testnet transaction",
        summary: `Requested ${amount} test XLM on Stellar testnet for local wallet approval and signing.`,
        source_type: "payment_request_fact"
      }
    ],
    items: [],
    costs: {},
    media: [],
    evidence: [],
    provenance: { service: "agentfood-production", data_mode: order.data_mode },
    truth_fields: [
      {
        field: "pricing.total",
        value: amount,
        currency: "XLM",
        source_type: "payment_request_fact",
        verification_status: "api_authenticated",
        confidence: "high",
        observed_at: createdAt
      }
    ],
    missing_context: ["recipient_facts_are_bound_by_platform", "real_merchant_catalog", "real_food_fulfillment", "real_order_acceptance"],
    risk_findings: [
      {
        code: "merchant_ai_claim_only",
        message: "Merchant, food, pricing, order acceptance, and fulfillment remain mock data.",
        field: "metadata.food_order",
        severity: "review_required"
      }
    ],
    metadata: {
      food_order: {
        order_id: order.order_id,
        mock: true,
        merchant: order.merchant,
        mock_quote: order.mock_quote,
        items: order.items.map((item) => ({
          item_id: item.item_id,
          name: item.name,
          quantity: item.quantity,
          mock_unit_amount: item.mock_unit_price,
          mock_currency: "MOCK_CREDITS"
        })),
        settlement_summary: { total: amount, currency: "XLM" },
        fulfillment: "none"
      }
    }
  };

  const paymentRequest = {
    recipient_id: config.stellar.recipientId,
    recipient_version_id: config.stellar.recipientVersionId,
    transaction_context_ref: { transaction_id: transactionId },
    expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    idempotency_key: `agentfood:${order.order_id}:testnet:v1`,
    payment: {
      amount
    },
    display: {
      title: "AgentFood testnet payment",
      summary: `${amount} test XLM on Stellar testnet; the associated food order and fulfillment are mock only.`,
      primary_action: "Review testnet transaction"
    },
    metadata: {
      environment: "official_testnet",
      data_mode: order.data_mode,
      real_transaction_process: true,
      real_value_transfer: false,
      fulfillment: "none",
      order_reference: crypto.createHash("sha256").update(order.order_id).digest("hex").slice(0, 24)
    }
  };

  return { context, paymentRequest };
}
