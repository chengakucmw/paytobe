// Payment-request lifecycle status set + the pure transition guards. Split out of
// risk.js so the status vocabulary lives in one small, dependency-free module.

export const ALLOWED_STATUSES = new Set([
  "pending",
  "signed",
  "broadcasted",
  "confirmed",
  "failed",
  "expired",
  "rejected"
]);

export function canTransition(status) {
  return ALLOWED_STATUSES.has(status);
}

export function shouldRecordSpent(status) {
  return status === "confirmed";
}

// M5 (intent parity): the legacy Payment Intent status route used to accept ANY
// status in ALLOWED_STATUSES, so pending->confirmed (skipping signature/broadcast),
// reviving a failed intent (failed->confirmed), and re-reporting a terminal status
// all slipped through — each able to re-run the F1 settle/record side effect and
// double-count the daily-spend ledger. This mirrors the Payment Request state
// machine (domain/payment-request.js) for intents.

// Statuses a wallet device may report for an intent (never "pending").
export const INTENT_STATUS_UPDATES = new Set([
  "signed",
  "broadcasted",
  "confirmed",
  "failed",
  "expired",
  "rejected"
]);

// Re-reporting one of these is a conflict (its side effects must never run twice).
// `failed` is a dead-end via the empty transition set below, but re-reporting it is
// an idempotent no-op — matching the Payment Request machine exactly.
const TERMINAL_INTENT_STATUSES = new Set(["confirmed", "expired", "rejected"]);

// The ONLY forward moves allowed from each status. `confirmed` is reachable only
// after `broadcasted`; every terminal status is irreversible.
export const INTENT_STATUS_TRANSITIONS = {
  pending: new Set(["signed", "broadcasted", "failed", "expired", "rejected"]),
  signed: new Set(["broadcasted", "failed", "expired", "rejected"]),
  broadcasted: new Set(["confirmed", "failed"]),
  confirmed: new Set(),
  failed: new Set(),
  expired: new Set(),
  rejected: new Set()
};

export function validateIntentStatusUpdate(intent, nextStatus) {
  const currentStatus = (intent && intent.status) || "pending";

  if (currentStatus === nextStatus) {
    // Re-reporting a terminal status (e.g. a retried "confirmed") is rejected so
    // settling daily spend never runs twice. A non-terminal repeat is a no-op.
    if (TERMINAL_INTENT_STATUSES.has(currentStatus)) {
      return terminalIntentConflict(currentStatus, nextStatus);
    }
    return { ok: true };
  }

  if (TERMINAL_INTENT_STATUSES.has(currentStatus)) {
    return terminalIntentConflict(currentStatus, nextStatus);
  }

  const allowed = INTENT_STATUS_TRANSITIONS[currentStatus] || new Set();
  if (!allowed.has(nextStatus)) {
    return {
      ok: false,
      status: 409,
      code: "invalid_status_transition",
      message: `Payment Intent cannot move from ${currentStatus} to ${nextStatus}`,
      details: {
        current_status: currentStatus,
        requested_status: nextStatus,
        allowed_transitions: Array.from(allowed)
      }
    };
  }
  return { ok: true };
}

export function terminalIntentConflict(currentStatus, nextStatus) {
  return {
    ok: false,
    status: 409,
    code: "terminal_payment_intent",
    message: "Terminal Payment Intent status cannot be changed",
    details: {
      current_status: currentStatus,
      requested_status: nextStatus
    }
  };
}
