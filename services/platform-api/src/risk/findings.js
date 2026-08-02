// Risk-finding shaping + the final Payment-Request risk summary. Pure (no I/O).

export function riskItem(code, message, field, severity = "warning", details = {}) {
  const item = {
    code,
    message,
    severity
  };
  if (field) item.field = field;
  if (Object.keys(details).length) item.details = details;
  return item;
}

export function summarizePaymentRequestRisk(errors, warnings, options = {}) {
  const hasContextMissing = options.contextMissing || warnings.some((warning) => warning.code === "context_missing");
  const level = errors.length ? "danger" : warnings.length ? "caution" : "safe";
  const reviewStatus = errors.length
    ? "blocked"
    : hasContextMissing
      ? "missing_context"
      : warnings.some((warning) => warning.code === "ai_only_critical_field")
        ? "source_review_required"
        : warnings.length
          ? "needs_review"
          : "ready";
  const signingAllowed = errors.length === 0 && !hasContextMissing;
  return {
    ok: errors.length === 0,
    level,
    review_status: reviewStatus,
    signing_allowed: signingAllowed,
    errors,
    warnings
  };
}
