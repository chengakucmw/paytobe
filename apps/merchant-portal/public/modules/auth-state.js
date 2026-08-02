export const AUTH_STATUS = Object.freeze({
  CHECKING: "checking",
  SIGNED_OUT: "signed_out",
  SIGNING_IN: "signing_in",
  AUTHENTICATED: "authenticated",
  REAUTH_REQUIRED: "reauth_required",
  EXPIRED: "expired",
  ERROR: "error"
});

export function initialAuthState() {
  return Object.freeze({ status: AUTH_STATUS.CHECKING, session: null, csrfAvailable: false, message: "" });
}

export function reduceAuthState(state, event) {
  switch (event?.type) {
    case "CHECK_FAILED":
      return signedOut(AUTH_STATUS.SIGNED_OUT, "Sign in with a current one-time grant.");
    case "SIGN_IN_STARTED":
      return Object.freeze({ status: AUTH_STATUS.SIGNING_IN, session: null, csrfAvailable: false, message: "Signing in…" });
    case "AUTHENTICATED": {
      const session = sanitizeSession(event.session);
      if (!session) return signedOut(AUTH_STATUS.ERROR, "The server returned an invalid session.");
      return Object.freeze({
        status: AUTH_STATUS.AUTHENTICATED,
        session,
        csrfAvailable: event.csrfAvailable === true,
        message: event.csrfAvailable === true ? "" : "Reauthenticate before making changes."
      });
    }
    case "SESSION_EXPIRED":
      return signedOut(AUTH_STATUS.EXPIRED, "Your session expired. Sign in again to continue.");
    case "REAUTH_REQUIRED":
      return signedOut(AUTH_STATUS.REAUTH_REQUIRED, "Reauthentication is required before this action.");
    case "SIGNED_OUT":
      return signedOut(AUTH_STATUS.SIGNED_OUT, "You are signed out.");
    case "ERROR":
      return signedOut(AUTH_STATUS.ERROR, safeMessage(event.message));
    default:
      return state;
  }
}

function signedOut(status, message) {
  return Object.freeze({ status, session: null, csrfAvailable: false, message });
}

function sanitizeSession(value) {
  if (!value || typeof value !== "object") return null;
  const sessionId = String(value.session_id || "");
  const merchantId = String(value.merchant_id || "");
  const accountId = String(value.account_id || "");
  const role = String(value.role || "");
  const expiresAt = String(value.expires_at || "");
  if (!sessionId || !merchantId || !accountId || !role || !Number.isFinite(Date.parse(expiresAt))) return null;
  return Object.freeze({
    sessionId,
    merchantId,
    accountId,
    role,
    expiresAt,
    idleExpiresAt: String(value.idle_expires_at || "")
  });
}

function safeMessage(value) {
  const message = String(value || "Unexpected portal error.").trim();
  return message.slice(0, 180) || "Unexpected portal error.";
}
