import { ReauthenticationRequiredError, SessionExpiredError } from "../../../public/modules/api-client.js";
import { renderMerchantAudit } from "../audit/index.js";
import { renderWebhooks, replayAllowed } from "../../components/webhooks/view.js";

const MANAGER_ROLES = new Set(["owner", "admin", "developer"]);

export function createWebhookAuditModel({ api, session, confirmAction = () => false, onSessionInvalid = () => {} }) {
  let state = Object.freeze({ endpoints: [], deliveries: [], auditEvents: [], showCreate: false, oneTimeSecret: null, ownershipChallenge: null, busy: false, message: "", errorCode: "", stepUpRequired: false, stepUpFresh: false });
  const listeners = new Set();
  function publish(patch) { state = Object.freeze({ ...state, ...patch }); for (const listener of listeners) listener(state); }
  function canManage() { return MANAGER_ROLES.has(String(session.role || "").toLowerCase()); }

  async function run(operation, { clearOnNotFound = false } = {}) {
    publish({ busy: true, message: "", errorCode: "" });
    try { const result = await operation(); publish({ busy: false }); return result; }
    catch (error) {
      if (error instanceof SessionExpiredError || error instanceof ReauthenticationRequiredError) { clear("session_invalid", "Your session can no longer authorize this page."); onSessionInvalid(error); return null; }
      if (clearOnNotFound && (error?.status === 404 || error?.code === "resource_not_found")) { clear("resource_not_found", "The Webhook resource is unavailable."); return null; }
      const code = String(error?.code || "webhook_request_failed"); publish({ busy: false, errorCode: code, message: errorMessage(code), stepUpRequired: code === "step_up_required" }); return null;
    }
  }
  function clear(errorCode, message) { publish({ endpoints: [], deliveries: [], auditEvents: [], showCreate: false, oneTimeSecret: null, ownershipChallenge: null, busy: false, message, errorCode, stepUpRequired: false, stepUpFresh: false }); }

  async function load() {
    const result = await run(async () => Promise.all([api.listWebhookEndpoints(), api.listWebhookDeliveries(), api.listMerchantAuditEvents()]));
    if (result) publish({ endpoints: array(result[0]).map(sanitizeEndpoint), deliveries: array(result[1]).map(sanitizeDelivery), auditEvents: array(result[2]).map(sanitizeAuditEvent) });
  }
  async function create(input) {
    if (!canManage() || state.oneTimeSecret) return forbidden(state.oneTimeSecret ? "secret_unacknowledged" : "forbidden");
    const result = await run(() => api.createWebhookEndpoint({ url: input.url, event_types: input.eventTypes }));
    if (result) { const endpoint = sanitizeEndpoint(result.webhook_endpoint); publish({ endpoints: [endpoint, ...state.endpoints], showCreate: false, oneTimeSecret: secretReceipt(result.secret, "create"), ownershipChallenge: result.ownership_challenge ? Object.freeze({ endpointId: endpoint.webhook_endpoint_id, value: String(result.ownership_challenge) }) : null, message: "Endpoint created. Save the one-time Secret before continuing." }); }
    return result;
  }
  function acknowledgeSecret(saved) { if (!state.oneTimeSecret) return true; if (saved !== true) { publish({ errorCode: "secret_save_confirmation_required", message: "Confirm the Secret is saved before hiding it." }); return false; } publish({ oneTimeSecret: null, message: "Secret hidden and removed from portal state.", errorCode: "" }); return true; }
  async function verifyEndpoint(id) { const result = await run(() => api.verifyWebhookEndpoint(id), { clearOnNotFound: true }); if (result) publish({ endpoints: replace(state.endpoints, sanitizeEndpoint(result.webhook_endpoint), "webhook_endpoint_id"), ownershipChallenge: null, message: "Endpoint verified." }); return result; }
  async function rotateSecret(id, confirmed) {
    if (!canManage() || state.oneTimeSecret || confirmed !== true || confirmAction("rotate") !== true) return null;
    if (!state.stepUpFresh) return requireStepUp();
    const result = await run(() => api.rotateWebhookSecret(id), { clearOnNotFound: true });
    if (result) publish({ endpoints: replace(state.endpoints, sanitizeEndpoint(result.webhook_endpoint), "webhook_endpoint_id"), oneTimeSecret: secretReceipt(result.secret, "rotate"), message: "Secret rotated. Save the new value; the previous Secret remains valid only during the displayed overlap.", stepUpFresh: false });
    return result;
  }
  async function revokeEndpoint(id, confirmed) { if (!canManage() || confirmed !== true || confirmAction("revoke") !== true) return null; if (!state.stepUpFresh) return requireStepUp(); const result = await run(() => api.revokeWebhookEndpoint(id), { clearOnNotFound: true }); if (result) publish({ endpoints: replace(state.endpoints, sanitizeEndpoint(result.webhook_endpoint), "webhook_endpoint_id"), message: "Endpoint and active Secrets revoked.", stepUpFresh: false }); return result; }
  async function replay(deliveryId, confirmed) {
    const original = state.deliveries.find((item) => item.delivery_id === deliveryId);
    if (!canManage() || !original || !replayAllowed(original) || confirmed !== true || confirmAction("replay") !== true) return null;
    if (!state.stepUpFresh) return requireStepUp();
    const result = await run(() => api.replayWebhookDelivery(deliveryId), { clearOnNotFound: true });
    if (result) { const delivery = sanitizeDelivery(result.delivery); if (delivery.event_id !== original.event_id) { clear("webhook_replay_event_mismatch", "Replay was rejected because its Event ID changed."); return null; } publish({ deliveries: [delivery, ...state.deliveries], message: `Replay queued with stable Event ID ${delivery.event_id}.`, stepUpFresh: false }); }
    return result;
  }
  async function startStepUp() { const result = await run(() => api.startStepUp()); if (result) publish({ stepUpRequired: true, message: "A short-lived step-up challenge was sent." }); return result; }
  async function completeStepUp(token) { const result = await run(() => api.completeStepUp(token)); if (result) publish({ stepUpRequired: false, stepUpFresh: true, message: "Step-up completed. Confirm the sensitive action again." }); return result; }
  function requireStepUp() { publish({ stepUpRequired: true, errorCode: "step_up_required", message: errorMessage("step_up_required") }); return null; }
  function forbidden(code) { publish({ errorCode: code, message: errorMessage(code) }); return null; }
  return Object.freeze({ getState: () => state, canManage, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, setView(patch) { publish(patch); }, load, create, acknowledgeSecret, verifyEndpoint, rotateSecret, revokeEndpoint, replay, startStepUp, completeStepUp });
}

function sanitizeEndpoint(value) { if (!value?.webhook_endpoint_id) throw new TypeError("Endpoint response is invalid"); return Object.freeze({ webhook_endpoint_id: String(value.webhook_endpoint_id), url: String(value.url || ""), event_types: array(value.event_types).map(String), status: String(value.status || "draft"), verification_mode: String(value.verification_mode || ""), secret_overlap_until: String(value.secret_overlap_until || ""), version: Number(value.version || 0) }); }
function sanitizeDelivery(value) { if (!value?.delivery_id || !value.event_id) throw new TypeError("Delivery response is invalid"); return Object.freeze({ delivery_id: String(value.delivery_id), event_id: String(value.event_id), webhook_endpoint_id: String(value.webhook_endpoint_id || ""), attempt: Number(value.attempt || 0), status: String(value.status || "pending"), response_status: value.response_status ? Number(value.response_status) : null, failure_code: safeFailure(value.failure_code), next_attempt_at: String(value.next_attempt_at || ""), replay_of_delivery_id: String(value.replay_of_delivery_id || "") }); }
function sanitizeAuditEvent(value) { return Object.freeze({ audit_event_id: String(value?.audit_event_id || ""), actor: Object.freeze({ type: String(value?.actor?.type || ""), id: String(value?.actor?.id || "") }), action: String(value?.action || "unknown"), resource: Object.freeze({ type: String(value?.resource?.type || ""), id: String(value?.resource?.id || "") }), result: String(value?.result || "unknown"), occurred_at: String(value?.occurred_at || "") }); }
function secretReceipt(value, reason) { const secret = String(value || ""); if (!/^whsec_[A-Za-z0-9_-]{43}$/.test(secret)) throw new TypeError("Webhook Secret response is invalid"); return Object.freeze({ value: secret, reason }); }
function safeFailure(value) { const code = String(value || ""); return /^[a-z0-9_]{1,80}$/.test(code) ? code : "webhook_delivery_failed"; }
function errorMessage(code) { const map = { step_up_required: "Recent step-up authentication is required.", secret_unacknowledged: "Save and hide the current one-time Secret before requesting another.", webhook_not_active: "Only an active endpoint can rotate its Secret.", webhook_replay_event_mismatch: "Replay Event ID did not match the original.", resource_not_found: "The Webhook resource is unavailable.", forbidden: "Your server-issued role does not permit Webhook management." }; return map[code] || "The Webhook request could not be completed."; }
function array(value) { return Array.isArray(value) ? value : []; }
function replace(items, value, key) { return items.map((item) => item[key] === value[key] ? value : item); }

export function mountWebhookAudit({ container, api, session, route, onSessionInvalid }) {
  if (!container) return null;
  const model = createWebhookAuditModel({ api, session, confirmAction: (action) => globalThis.confirm(action === "replay" ? "Replay this delivery with the same Event ID? The receiver may process it again." : `Confirm Webhook ${action}?`), onSessionInvalid });
  const paint = (state) => { container.innerHTML = route === "audit" ? renderMerchantAudit(state.auditEvents) : renderWebhooks(state, model.canManage()); if (route !== "audit") bind(container, model); };
  model.subscribe(paint); paint(model.getState()); void model.load(); return model;
}
function bind(container, model) {
  container.querySelector("#show-create-webhook")?.addEventListener("click", () => model.setView({ showCreate: true }));
  container.querySelector("#create-webhook-form")?.addEventListener("submit", (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void model.create({ url: data.get("url"), eventTypes: String(data.get("event_types") || "").split(",").map((item) => item.trim()).filter(Boolean) }); });
  container.querySelector("#acknowledge-webhook-secret")?.addEventListener("click", () => model.acknowledgeSecret(container.querySelector("#secret-saved-confirmation")?.checked === true));
  for (const card of container.querySelectorAll("[data-endpoint-id]")) { const id = card.dataset.endpointId; card.querySelector("[data-verify-endpoint]")?.addEventListener("click", () => void model.verifyEndpoint(id)); card.querySelector("[data-rotate-secret]")?.addEventListener("click", () => void model.rotateSecret(id, true)); card.querySelector("[data-revoke-endpoint]")?.addEventListener("click", () => void model.revokeEndpoint(id, true)); }
  for (const row of container.querySelectorAll("[data-delivery-id]")) row.querySelector("[data-replay-delivery]")?.addEventListener("click", () => void model.replay(row.dataset.deliveryId, true));
  container.querySelector("#start-webhook-step-up")?.addEventListener("click", () => void model.startStepUp());
  container.querySelector("#complete-webhook-step-up-form")?.addEventListener("submit", (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void model.completeStepUp(data.get("challenge_token")); event.currentTarget.reset(); });
}
export { renderMerchantAudit, renderWebhooks };
