// Payment Request projection, state machine, and risk-summary helpers.
//
// Extracted verbatim from server.js (the only change: paymentFactsFromPaymentRequest
// now calls decimal.js's addDecimalStringsOrEmpty instead of a server-local copy).
// Everything here is pure: it reads a stored Payment Request and derives the
// projection / review-state the API and wallet UI consume.

import { addDecimalStringsOrEmpty } from "../decimal.js";

export const PAYMENT_REQUEST_STATUS_UPDATES = new Set([
  "signed",
  "broadcasted",
  "confirmed",
  "failed",
  "expired",
  "rejected"
]);
const TERMINAL_PAYMENT_REQUEST_STATUSES = new Set([
  "confirmed",
  "expired",
  "rejected"
]);
// M5: explicit, ordered state machine for device-reported Payment Request
// status. Each key lists the ONLY statuses it may move to; anything else is a
// 409. This blocks pending→confirmed (skipping the signature step), reviving a
// failed request (failed→confirmed), and any mutation of a terminal status —
// all of which used to slip through the old "terminal is immutable" check and
// could poison the daily-spend ledger. `confirmed` is reachable only after
// `broadcasted`, and `failed` is irreversible.
export const PAYMENT_REQUEST_STATUS_TRANSITIONS = {
  pending: new Set(["signed", "broadcasted", "failed", "expired", "rejected"]),
  signed: new Set(["broadcasted", "failed", "expired", "rejected"]),
  broadcasted: new Set(["confirmed", "failed"]),
  confirmed: new Set(),
  failed: new Set(),
  expired: new Set(),
  rejected: new Set()
};
const FINAL_PAYMENT_REQUEST_REVIEW_STATES = new Set([
  "confirmed",
  "expired",
  "rejected",
  "cancelled"
]);
const ATTENTION_PAYMENT_REQUEST_REVIEW_STATES = new Set([
  "missing_context",
  "blocked",
  "needs_review",
  "source_review_required",
  "network_disabled",
  "broadcasting",
  "failed"
]);

export function paymentRequestMetricLabels(request) {
  return {
    status: request.status || "unknown",
    rail: request.payment?.rail || "unknown",
    network: request.payment?.network || "unknown",
    risk_level: request.risk?.level || "unknown"
  };
}

export function paymentRequestProjection(request) {
  const {
    connection_token: _connectionToken,
    token: _token,
    target_app_device_id: _targetAppDeviceId,
    ...safe
  } = request || {};
  const context = paymentRequestContextSummary(safe);
  const risk = paymentRequestRiskSummary(safe, context);
  const statusProjection = paymentRequestStatusProjection(safe, risk, context);
  return {
    ...safe,
    request_id: safe.request_id || null,
    transaction_id: safe.transaction_id || null,
    status: safe.status || "pending",
    created_at: safe.created_at || null,
    updated_at: safe.updated_at || safe.created_at || null,
    expires_at: safe.expires_at || null,
    source: safe.source || {},
    payee: safe.payee || {},
    payment: safe.payment || {},
    payment_facts: safe.payment_facts || paymentFactsFromPaymentRequest(safe),
    context,
    risk,
    status_projection: statusProjection,
    status_label: statusProjection.label,
    review_state: statusProjection.review_state,
    status_group: statusProjection.group,
    inbox_group: statusProjection.inbox_group,
    is_final: statusProjection.is_final,
    requires_attention: statusProjection.requires_attention,
    history: Array.isArray(safe.history) ? safe.history : []
  };
}

export function paymentRequestEventProjection(event, request = null) {
  const data = event.data || {};
  return {
    seq: event.seq,
    type: event.type,
    request_id: event.request_id || data.request_id || event.intent_id || null,
    transaction_id: data.transaction_id || null,
    connection_id: data.connection_id || null,
    status: data.status || null,
    tx_hash: data.tx_hash || null,
    error: data.error || null,
    recipient_id: data.recipient_id || request?.recipient_id || null,
    recipient_version_id: data.recipient_version_id || request?.recipient_version_id || null,
    recipient_facts_hash: data.recipient_facts_hash || request?.recipient_facts_hash || null,
    recipient_snapshot: data.recipient_snapshot || request?.recipient_snapshot || null,
    at: event.at,
    data
  };
}

export function validatePaymentRequestStatusUpdate(request, nextStatus) {
  const currentStatus = request.status || "pending";

  if (currentStatus === nextStatus) {
    // Re-reporting a terminal status (e.g. a retried "confirmed") must be
    // rejected so its side effects — like recording daily spend — never run
    // twice. Re-reporting a non-terminal status is an idempotent no-op.
    if (TERMINAL_PAYMENT_REQUEST_STATUSES.has(currentStatus)) {
      return terminalPaymentRequestConflict(currentStatus, nextStatus);
    }
    return { ok: true };
  }

  if (TERMINAL_PAYMENT_REQUEST_STATUSES.has(currentStatus)) {
    return terminalPaymentRequestConflict(currentStatus, nextStatus);
  }

  const allowed = PAYMENT_REQUEST_STATUS_TRANSITIONS[currentStatus] || new Set();
  if (!allowed.has(nextStatus)) {
    return {
      ok: false,
      status: 409,
      code: "invalid_status_transition",
      message: `Payment Request cannot move from ${currentStatus} to ${nextStatus}`,
      details: {
        current_status: currentStatus,
        requested_status: nextStatus,
        allowed_transitions: Array.from(allowed)
      }
    };
  }
  return { ok: true };
}

export function terminalPaymentRequestConflict(currentStatus, nextStatus) {
  return {
    ok: false,
    status: 409,
    code: "terminal_payment_request",
    message: "Terminal Payment Request status cannot be changed",
    details: {
      current_status: currentStatus,
      requested_status: nextStatus
    }
  };
}

export function paymentRequestStatusMessage(request, patch = {}) {
  return {
    type: "payment_request_status",
    request_id: request.request_id,
    transaction_id: request.transaction_id || null,
    connection_id: request.connection_id || null,
    status: request.status,
    tx_hash: patch.tx_hash || request.tx_hash || null,
    error: patch.error || request.error || null
  };
}

export function paymentFactsFromPaymentRequest(request) {
  const payment = request.payment || {};
  const fee = payment.estimated_fee || payment.fee || null;
  return {
    amount: payment.amount,
    token: payment.asset,
    network: payment.network,
    recipient: payment.to,
    fee,
    total: payment.total || request.payment_facts?.total || addDecimalStringsOrEmpty(payment.amount, fee) || payment.amount,
    payee: request.payee || null
  };
}

export function paymentRequestContextSummary(request) {
  const ref = request.transaction_context_ref || {};
  const snapshot = request.transaction_context_snapshot || null;
  const status = ref.status || (request.transaction_id ? "missing" : "missing");
  const warnings = (request.warnings || []).filter((warning) => warning?.code === "context_missing");
  return {
    status,
    transaction_id: ref.transaction_id || request.transaction_id || snapshot?.transaction_id || null,
    snapshot_hash: ref.snapshot_hash || snapshot?.snapshot_hash || null,
    has_snapshot: Boolean(snapshot),
    warnings
  };
}

export function paymentRequestRiskSummary(request, context = paymentRequestContextSummary(request)) {
  const risk = request.risk || {};
  const errors = Array.isArray(risk.errors) ? risk.errors : [];
  const warnings = Array.isArray(risk.warnings) ? risk.warnings : [];
  const requestStatus = request.status || "pending";
  const contextMissing = context.status === "missing" || warnings.some((warning) => warning.code === "context_missing");
  const level = risk.level || (errors.length ? "danger" : warnings.length ? "caution" : "safe");
  const reviewStatus = risk.review_status || (errors.length
    ? "blocked"
    : contextMissing
      ? "missing_context"
      : warnings.some((warning) => warning.code === "ai_only_critical_field")
        ? "source_review_required"
        : warnings.length
          ? "needs_review"
          : "ready");
  const storedSigningAllowed = risk.signing_allowed ?? (errors.length === 0 && !contextMissing);
  return {
    ...risk,
    level,
    review_status: reviewStatus,
    signing_allowed: requestStatus === "pending" && Boolean(storedSigningAllowed) && errors.length === 0 && !contextMissing,
    errors,
    warnings
  };
}

export function paymentRequestStatusProjection(request, risk, context) {
  const reviewState = paymentRequestReviewState(request, risk, context);
  const isFinal = FINAL_PAYMENT_REQUEST_REVIEW_STATES.has(reviewState);
  const requiresAttention = ATTENTION_PAYMENT_REQUEST_REVIEW_STATES.has(reviewState)
    || risk.level === "danger"
    || risk.review_status === "needs_review";
  return {
    lifecycle_status: request.status || "pending",
    review_state: reviewState,
    label: paymentRequestStatusLabel(reviewState),
    tone: paymentRequestStatusTone(reviewState, risk),
    group: isFinal ? "final" : requiresAttention ? "active_attention" : "pending",
    inbox_group: isFinal ? "final" : "pending",
    is_final: isFinal,
    requires_attention: requiresAttention,
    signing_allowed: risk.signing_allowed
  };
}

export function paymentRequestReviewState(request, risk, context) {
  const status = String(request.status || "pending");
  if (status === "broadcasted") return "broadcasting";
  if (status === "signed") return "signed_locally";
  if (["confirmed", "expired", "rejected", "cancelled", "failed"].includes(status)) return status;
  if (hasRiskCode(risk, "network_disabled")) return "network_disabled";
  if (risk.errors.length) return "blocked";
  if (context.status === "missing" || risk.review_status === "missing_context") return "missing_context";
  if (risk.review_status === "source_review_required" || hasRiskCode(risk, "ai_only_critical_field")) {
    return "source_review_required";
  }
  if (risk.review_status === "needs_review") return "needs_review";
  return "pending";
}

export function paymentRequestStatusLabel(reviewState) {
  const labels = {
    pending: "Awaiting signature",
    missing_context: "Missing context",
    blocked: "Risk blocked",
    needs_review: "Needs review",
    source_review_required: "Source review required",
    network_disabled: "Network disabled",
    signed_locally: "Signed locally",
    broadcasting: "Broadcasting",
    failed: "Failed",
    expired: "Expired",
    rejected: "Rejected",
    confirmed: "Confirmed",
    cancelled: "Cancelled"
  };
  return labels[reviewState] || "Awaiting signature";
}

export function paymentRequestStatusTone(reviewState, risk) {
  if (["blocked", "failed", "rejected"].includes(reviewState)) return "danger";
  if (["missing_context", "needs_review", "source_review_required", "network_disabled"].includes(reviewState)) return "caution";
  if (["broadcasting", "expired", "cancelled", "signed_locally"].includes(reviewState)) return "info";
  if (reviewState === "confirmed") return "safe";
  return risk.level || "safe";
}

export function hasRiskCode(risk, code) {
  return [...(risk.errors || []), ...(risk.warnings || [])].some((item) => item?.code === code);
}
