import {
  SUPPORTED_TRANSFER_ASSETS,
  SUPPORTED_TRANSFER_RAILS
} from "./transfer-assets.js";

export const PAYMENT_REQUEST_PROTOCOL = "Paytobe.payment_request.v1";
export const TRANSACTION_CONTEXT_PROTOCOL = "Paytobe.transaction_context.v1";

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

// Canonical risk caps shared by the backend risk policy and the wallet clients.
// THIS is the single source of truth for the default daily spend cap and the
// unverified-recipient cap. The runtime consumers MUST match these values:
//   - services/platform-api/src/risk/limits.js  (dailyLimitFor fallback)
//   - apps/android/app/src/main/java/ai/agentwallet/hd/RiskPolicy.java
//       (DAILY_*_LIMIT and UNVERIFIED_*_CAP literals)
//   - apps/ios/Paytobe/RiskPolicy.swift
//       (LocalRiskPolicy.dailyXLMLimit and .unverifiedXLMCap literals)
// Amounts are exact decimal STRINGS (never float), consistent with decimal.js
// and Android's BigDecimal. Consistency is enforced by
// tests/protocol/risk-limits-contract.test.mjs.
export const RISK_LIMITS = Object.freeze({
  // Default per-asset daily spend cap when no DAILY_LIMIT_<ASSET> env override is set.
  daily_limit_default: "1000",
  // With no recipient whitelist configured, a payment above this cap to an
  // unverified recipient is blocked (fail closed) rather than merely warned.
  unverified_recipient_cap: "100"
});

// Canonical pairing scopes, dot-namespaced. THIS is the single source of truth for
// the pairing/authorization vocabulary. The runtime consumers MUST match this list:
//   - services/platform-api/src/domain/scopes.js  (ALLOWED_PAIRING_SCOPES)
//   - connectors/mcp-server/src/tools.js   (DEFAULT_SCOPES)
//   - connectors/hermes/src/index.js       (HERMES_DEFAULT_SCOPES)
// Consistency is enforced by tests/protocol/scope-contract.test.mjs.
export const PAIRING_SCOPES = Object.freeze([
  "payment.requests.create",
  "payment.requests.read",
  "transaction_contexts.create",
  "transaction_contexts.read",
  "wallet.addresses.read"
]);

// The default subset a connector requests at pairing time (no wallet.addresses.read).
// Matches connectors/mcp-server DEFAULT_SCOPES and connectors/hermes HERMES_DEFAULT_SCOPES.
export const DEFAULT_PAIRING_SCOPES = Object.freeze([
  "payment.requests.create",
  "payment.requests.read",
  "transaction_contexts.create",
  "transaction_contexts.read"
]);

// Pre-1.0 scope names, retained ONLY to translate legacy pairing payloads during
// migration. These are never enforced; new code must use the dotted names above.
// (save_merchants / manage_connections were dropped in v1 and have no successor.)
export const DEPRECATED_PAIRING_SCOPE_ALIASES = Object.freeze({
  request_payments: "payment.requests.create",
  read_payment_status: "payment.requests.read",
  create_transaction_contexts: "transaction_contexts.create",
  view_balances: "wallet.addresses.read"
});

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
