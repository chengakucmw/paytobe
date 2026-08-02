// Standard HTTP error / warning responders.
//
// apiWarning is pure. sendApiError needs the observability handle (to mark the
// error on the response for metrics), so it's produced by a small factory the
// server wires once at startup — call sites keep the exact same signature
// `sendApiError(res, status, code, message, options)`.

export function apiWarning(code, message, details = {}) {
  return {
    code,
    message,
    details
  };
}

export function createResponders({ observability }) {
  function sendApiError(res, status, code, message, options = {}) {
    const requestId = String(res.getHeader?.("x-request-id") || options.requestId || "unknown");
    const error = {
      code,
      message,
      request_id: requestId,
      severity: options.severity || "blocker"
    };
    if (options.field) error.field = options.field;
    if (options.details) error.details = options.details;
    observability.markApiError(res, { status, code, field: error.field || options.details?.field || null });
    return res.status(status).json({ ok: false, error });
  }

  function sendAuthFailure(res, auth) {
    return sendApiError(res, auth.status || 401, auth.code || "unauthorized_connection", auth.message || "Unauthorized connection");
  }

  return { sendApiError, sendAuthFailure };
}
