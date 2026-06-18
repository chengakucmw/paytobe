import {
  SUPPORTED_TRANSFER_ASSETS,
  SUPPORTED_TRANSFER_RAILS
} from "./transfer-assets.js";

export const PAYMENT_REQUEST_PROTOCOL = "velarum.payment_request.v1";
export const TRANSACTION_CONTEXT_PROTOCOL = "velarum.transaction_context.v1";

export const BASE_USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export const PAYMENT_RAILS = Object.freeze([
  ...SUPPORTED_TRANSFER_RAILS,
  "evm_erc20"
]);

export const CANONICAL_PAYMENT_RAILS = Object.freeze([...SUPPORTED_TRANSFER_RAILS]);

export const PAYMENT_STATUSES = Object.freeze([
  "pending",
  "signed",
  "broadcasted",
  "confirmed",
  "failed",
  "expired",
  "rejected"
]);

export const TERMINAL_PAYMENT_STATUSES = Object.freeze([
  "confirmed",
  "failed",
  "expired",
  "rejected"
]);

export const SOURCE_TYPES = Object.freeze([
  "payment_request_fact",
  "wallet_derived",
  "user_provided",
  "user_agent_inferred",
  "merchant_web_observed",
  "merchant_ai_claim",
  "merchant_api_response",
  "merchant_signed_quote",
  "platform_verified",
  "external_verified",
  "unknown"
]);

export const VERIFICATION_STATUSES = Object.freeze([
  "signature_verified",
  "domain_verified",
  "address_verified",
  "api_authenticated",
  "observed_only",
  "ai_claim_only",
  "inferred_only",
  "conflicted",
  "missing",
  "unverified"
]);

export const RISK_SEVERITIES = Object.freeze([
  "blocker",
  "warning",
  "review_required",
  "info"
]);

export const PAIRING_SCOPES = Object.freeze([
  "request_payments",
  "create_transaction_contexts",
  "view_balances",
  "read_payment_status",
  "save_merchants",
  "manage_connections"
]);

export const TRANSACTION_CONTEXT_TYPES = Object.freeze([
  "purchase",
  "online_purchase",
  "food_order",
  "api_paid_call",
  "subscription",
  "virtual_goods",
  "service_booking",
  "travel_booking",
  "transfer_request",
  "invoice_payment",
  "donation",
  "developer_test",
  "generic",
  "generic_task"
]);

export const TRANSACTION_CONTEXT_STATUSES = Object.freeze([
  "draft",
  "proposed",
  "awaiting_payment",
  "ready_for_payment",
  "payment_pending",
  "paid",
  "failed",
  "cancelled",
  "fulfilled",
  "disputed"
]);

export const SUPPORTED_NETWORKS = Object.freeze([
  ...new Set([
    ...SUPPORTED_TRANSFER_ASSETS.map((asset) => asset.network),
    "stellar_testnet"
  ])
]);
