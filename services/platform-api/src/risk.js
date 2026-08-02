// Risk-evaluation facade. The implementation is split by concern under ./risk/ so
// no single file carries the whole policy:
//   status.js               - payment-request status set + transition guards
//   findings.js             - riskItem + Payment-Request risk summary shaping
//   matchers.js             - value comparators + truth-field classifiers
//   limits.js               - daily-cap + recipient-whitelist gates (caps come from
//                             the canonical packages/protocol RISK_LIMITS)
//   context-review.js       - Transaction-Context cost / truth-field comparison
//   evaluate.js             - the top-level evaluators (intent + payment request)
//   stellar-confirmation.js - Stellar on-chain confirmation result (M-2)
//
// This file re-exports the stable public surface, so existing imports of
// "./risk.js" keep working unchanged.

export {
  ALLOWED_STATUSES,
  INTENT_STATUS_UPDATES,
  canTransition,
  shouldRecordSpent,
  validateIntentStatusUpdate
} from "./risk/status.js";
export { evaluateIntent, evaluatePaymentRequest } from "./risk/evaluate.js";
export { dailyLimitFor, stellarPublicPolicyViolations } from "./risk/limits.js";
export { stellarConfirmationResult } from "./risk/stellar-confirmation.js";
export { BASE_USDC_CONTRACT } from "../../../packages/protocol/src/index.js";
