import { PortalApiError, ReauthenticationRequiredError, SessionExpiredError } from "../../../public/modules/api-client.js";
import { renderDomainVerification } from "../../components/domains/view.js";

const MANAGER_ROLES = new Set(["owner", "admin"]);
const EXPIRED_CODES = new Set(["domain_challenge_expired", "challenge_expired"]);

export function createDomainVerificationModel({ api, session, copyText = async () => {}, confirmReplace = () => false, onSessionInvalid = () => {} }) {
  if (!api || !session?.merchantId) throw new TypeError("Domain model requires API and authenticated merchant session");
  let state = Object.freeze(emptyState());
  const listeners = new Set();

  function publish(patch) {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener(state);
  }

  async function run(operation) {
    publish({ busy: true, message: "", errorCode: "" });
    try {
      const result = await operation();
      publish({ busy: false, stepUpRequired: false });
      return result;
    } catch (error) {
      if (error instanceof SessionExpiredError || error instanceof ReauthenticationRequiredError) {
        clear("session_invalid", "Your session can no longer authorize this page.");
        onSessionInvalid(error);
        return null;
      }
      if (error?.status === 404 || error?.code === "resource_not_found") {
        clear("resource_not_found", "The domain resource is unavailable.");
        return null;
      }
      const code = String(error?.code || "domain_verification_failed");
      publish({
        busy: false,
        errorCode: code,
        message: messageForDomainError(code),
        displayStatus: EXPIRED_CODES.has(code) ? "expired" : (code === "step_up_required" ? state.displayStatus : "failed"),
        stepUpRequired: code === "step_up_required"
      });
      return null;
    }
  }

  function clear(errorCode, message) {
    publish({ ...emptyState(), errorCode, message });
  }

  async function create(input) {
    if (!canManage()) return forbidden();
    const result = await run(() => api.createDomain({ domain: input.domain, method: input.method }));
    if (result) applyChallenge(result, "Domain challenge created.");
    return result;
  }

  async function verify() {
    if (!canManage() || !state.domain?.domain_id) return forbidden();
    const result = await run(() => api.verifyDomain(state.domain.domain_id));
    if (result) publish({
      domain: sanitizeDomain(result.merchant_domain),
      displayStatus: result.merchant_domain.status,
      challenge: "",
      dnsName: "",
      message: "Domain ownership verified.",
      errorCode: "",
      reverifyAt: timeField(result, "reverify_at", "next_reverification_at")
    });
    return result;
  }

  async function beginReverification(confirmed) {
    if (!canManage() || !state.domain?.domain_id || confirmed !== true || confirmReplace() !== true) return null;
    const result = await run(() => api.beginDomainReverification(state.domain.domain_id));
    if (result) applyChallenge(result, "Re-verification challenge created. Previous evidence is no longer current.");
    return result;
  }

  async function copyChallenge() {
    if (!state.challenge) return false;
    await copyText(state.challenge);
    publish({ message: "Challenge value copied. No account or session credential was copied.", errorCode: "" });
    return true;
  }

  async function startStepUp() {
    const result = await run(() => api.startStepUp());
    if (result) publish({ message: "A short-lived step-up challenge was sent to the verified account email.", stepUpRequired: true });
    return result;
  }

  async function completeStepUp(token) {
    const result = await run(() => api.completeStepUp(token));
    if (result) publish({ message: "Step-up authentication completed. Confirm re-verification again to continue.", stepUpRequired: false });
    return result;
  }

  function applyChallenge(result, message) {
    const domain = sanitizeDomain(result.merchant_domain);
    publish({
      domain,
      displayStatus: domain.status,
      challenge: String(result.challenge || ""),
      dnsName: domain.method === "dns_txt" ? String(result.dns_name || `_Paytobe.${domain.domain}`) : "",
      challengeExpiresAt: timeField(result, "challenge_expires_at", "expires_at"),
      reverifyAt: timeField(result, "reverify_at", "next_reverification_at"),
      message,
      errorCode: ""
    });
  }

  function canManage() {
    return MANAGER_ROLES.has(String(session.role || "").toLowerCase());
  }

  function forbidden() {
    publish({ errorCode: "forbidden", message: messageForDomainError("forbidden") });
    return null;
  }

  return Object.freeze({
    getState: () => state,
    canManage,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    create,
    verify,
    beginReverification,
    copyChallenge,
    startStepUp,
    completeStepUp
  });
}

function emptyState() {
  return { busy: false, domain: null, displayStatus: "pending", challenge: "", dnsName: "", challengeExpiresAt: "", reverifyAt: "", message: "", errorCode: "", stepUpRequired: false };
}

function sanitizeDomain(value) {
  if (!value || typeof value !== "object" || !value.domain_id || !value.domain) throw new TypeError("Domain response is invalid");
  return Object.freeze({
    domain_id: String(value.domain_id),
    domain: String(value.domain),
    method: value.method === "https_well_known" ? "https_well_known" : "dns_txt",
    status: String(value.status || "pending"),
    verified_at: String(value.verified_at || ""),
    version: Number(value.version || 0)
  });
}

function timeField(payload, ...keys) {
  for (const key of keys) {
    const value = payload?.[key] || payload?.merchant_domain?.[key];
    if (value && Number.isFinite(Date.parse(value))) return String(value);
  }
  return "";
}

export function messageForDomainError(code) {
  const messages = Object.freeze({
    invalid_domain: "Enter a valid public domain name without a path, port, or credentials.",
    domain_conflict: "This domain is already registered.",
    domain_not_verifiable: "This domain is not waiting for verification.",
    domain_challenge_mismatch: "The published challenge does not match. Check the exact name and value, then retry.",
    domain_redirect_forbidden: "The HTTPS proof redirected. Serve the proof directly at the exact well-known path.",
    domain_http_failed: "The HTTPS well-known path did not return a successful proof.",
    domain_response_invalid: "The HTTPS proof response is not valid JSON.",
    domain_response_too_large: "The HTTPS proof response exceeds the allowed size.",
    domain_dns_rebinding: "Verification was stopped because the domain addresses changed during the check.",
    domain_verification_failed: "Domain verification could not be completed. Check public DNS or HTTPS configuration and retry.",
    domain_challenge_expired: "This challenge expired. Start re-verification to issue a new challenge.",
    challenge_expired: "This challenge expired. Start re-verification to issue a new challenge.",
    step_up_required: "Recent step-up authentication is required before replacing verified domain proof.",
    forbidden: "Your server-issued role does not permit domain management."
  });
  return messages[code] || messages.domain_verification_failed;
}

export function mountDomains({ container, api, session, onSessionInvalid }) {
  if (!container) return null;
  const model = createDomainVerificationModel({
    api,
    session,
    copyText: (value) => navigator.clipboard.writeText(value),
    confirmReplace: () => globalThis.confirm("Replace the verified proof? This requires recent step-up authentication and the domain will require verification again."),
    onSessionInvalid
  });
  const paint = (state) => {
    container.innerHTML = renderDomainVerification(state, model.canManage());
    bind(container, model);
  };
  model.subscribe(paint);
  paint(model.getState());
  return model;
}

function bind(container, model) {
  container.querySelector("#create-domain-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void model.create({ domain: data.get("domain"), method: data.get("method") });
  });
  container.querySelector("#verify-domain")?.addEventListener("click", () => void model.verify());
  container.querySelector("#copy-domain-challenge")?.addEventListener("click", () => void model.copyChallenge());
  container.querySelector("#reverify-domain")?.addEventListener("click", () => void model.beginReverification(true));
  container.querySelector("#start-domain-step-up")?.addEventListener("click", () => void model.startStepUp());
  container.querySelector("#complete-domain-step-up-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void model.completeStepUp(data.get("challenge_token"));
  });
}

export { renderDomainVerification };
