import { ReauthenticationRequiredError, SessionExpiredError } from "../../../public/modules/api-client.js";
import { renderRecipients } from "../../components/recipients/view.js";

const MANAGER_ROLES = new Set(["owner", "admin", "developer"]);

export function createRecipientsModel({ api, session, clock = () => Date.now(), confirmAction = () => false, onSessionInvalid = () => {} }) {
  if (!api || !session?.merchantId) throw new TypeError("Recipient model requires API and authenticated merchant session");
  let state = Object.freeze({ recipients: [], selectedRecipientId: "", versions: [], selectedVersionId: "", evidenceByVersion: Object.freeze({}), notificationByVersion: Object.freeze({}), showCreate: false, showVersionForm: false, busy: false, message: "", errorCode: "", stepUpRequired: false, stepUpFresh: false });
  const listeners = new Set();

  function publish(patch) { state = Object.freeze({ ...state, ...patch }); for (const listener of listeners) listener(state); }
  function recipient() { return state.recipients.find((item) => item.recipient_id === state.selectedRecipientId) || null; }
  function version() { return state.versions.find((item) => item.recipient_version_id === state.selectedVersionId) || null; }
  function canManage() { return MANAGER_ROLES.has(String(session.role || "").toLowerCase()); }

  async function run(operation, { clearOnNotFound = false } = {}) {
    publish({ busy: true, message: "", errorCode: "" });
    try { const result = await operation(); publish({ busy: false }); return result; }
    catch (error) {
      if (error instanceof SessionExpiredError || error instanceof ReauthenticationRequiredError) { clear("session_invalid", "Your session can no longer authorize this page."); onSessionInvalid(error); return null; }
      if (clearOnNotFound && (error?.status === 404 || error?.code === "resource_not_found")) { clear("resource_not_found", "The Recipient resource is unavailable."); return null; }
      const code = String(error?.code || "recipient_request_failed");
      publish({ busy: false, errorCode: code, message: errorMessage(code), stepUpRequired: code === "step_up_required" });
      return null;
    }
  }

  function clear(errorCode, message) { publish({ recipients: [], selectedRecipientId: "", versions: [], selectedVersionId: "", evidenceByVersion: Object.freeze({}), notificationByVersion: Object.freeze({}), showCreate: false, showVersionForm: false, busy: false, message, errorCode, stepUpRequired: false, stepUpFresh: false }); }

  async function load() {
    const items = await run(() => api.listRecipients());
    if (!items) return;
    const recipients = Array.isArray(items) ? items.map(sanitizeRecipient) : [];
    publish({ recipients, selectedRecipientId: recipients[0]?.recipient_id || "" });
    if (recipients[0]) await select(recipients[0].recipient_id);
  }

  async function select(recipientId) {
    const target = state.recipients.find((item) => item.recipient_id === recipientId);
    if (!target || target.status === "revoked") { publish({ versions: [], selectedVersionId: "", errorCode: "recipient_revoked", message: errorMessage("recipient_revoked") }); return null; }
    publish({ selectedRecipientId: recipientId, versions: [], selectedVersionId: "", showCreate: false, showVersionForm: false });
    const items = await run(() => api.listRecipientVersions(recipientId), { clearOnNotFound: true });
    if (items) {
      const versions = Array.isArray(items) ? items.map(sanitizeVersion) : [];
      const selectable = versions.find((item) => item.verification_state !== "revoked");
      publish({ versions, selectedVersionId: selectable?.recipient_version_id || "" });
    }
    return items;
  }

  async function create(input) {
    if (!canManage()) return forbidden();
    const result = await run(() => api.createRecipient({ name: input.name, ...factsInput(input) }));
    if (result) {
      const safeRecipient = sanitizeRecipient(result.recipient);
      const safeVersion = sanitizeVersion(result.recipient_version);
      publish({ recipients: [...state.recipients, safeRecipient], selectedRecipientId: safeRecipient.recipient_id, versions: [safeVersion], selectedVersionId: safeVersion.recipient_version_id, showCreate: false, notificationByVersion: withNotification(state.notificationByVersion, safeVersion.recipient_version_id, result.owner_notification), message: "Recipient draft and first immutable version created." });
    }
    return result;
  }

  async function createVersion(input) {
    const target = recipient();
    if (!canManage() || !target || target.status === "revoked") return forbidden();
    const result = await run(() => api.createRecipientVersion(target.recipient_id, { ...factsInput(input), version: target.version }), { clearOnNotFound: true });
    if (result) {
      const nextRecipient = sanitizeRecipient(result.recipient);
      const nextVersion = sanitizeVersion(result.recipient_version);
      const cooling = Date.parse(nextVersion.cooling_until) > clock();
      publish({ recipients: replace(state.recipients, nextRecipient, "recipient_id"), versions: [...state.versions, nextVersion], selectedVersionId: nextVersion.recipient_version_id, showVersionForm: false, evidenceByVersion: Object.freeze({ ...state.evidenceByVersion, [nextVersion.recipient_version_id]: null }), notificationByVersion: withNotification(state.notificationByVersion, nextVersion.recipient_version_id, result.owner_notification), message: cooling ? "New immutable facts version created. Activation remains subject to the configured cooling period." : "New immutable facts version created. Testnet activation is available after verification." });
    }
    return result;
  }

  async function verify(input) {
    const target = recipient(); const selected = version();
    if (!canManage() || !target || !selected || target.status === "revoked" || selected.verification_state === "revoked") return forbidden();
    const result = await run(() => api.verifyRecipient(target.recipient_id, { recipient_version_id: selected.recipient_version_id, type: input.type, source_id: input.sourceId, evidence_digest: input.evidenceDigest, version: target.version }), { clearOnNotFound: true });
    if (result) {
      const nextRecipient = sanitizeRecipient(result.recipient); const nextVersion = sanitizeVersion(result.recipient_version); const evidence = sanitizeEvidence(result.evidence);
      const cooling = Date.parse(nextVersion.cooling_until) > clock();
      publish({ recipients: replace(state.recipients, nextRecipient, "recipient_id"), versions: replace(state.versions, nextVersion, "recipient_version_id"), evidenceByVersion: Object.freeze({ ...state.evidenceByVersion, [nextVersion.recipient_version_id]: evidence }), notificationByVersion: withNotification(state.notificationByVersion, nextVersion.recipient_version_id, result.owner_notification), message: cooling ? "Verification evidence accepted. Activation remains subject to the configured cooling period and recent authentication." : "Verification evidence accepted. Confirm activation with recent authentication." });
    }
    return result;
  }

  async function activate(confirmed) {
    const target = recipient(); const selected = version(); const evidence = state.evidenceByVersion[state.selectedVersionId];
    if (!canManage() || !target || !selected || !evidence || target.status === "revoked" || selected.verification_state === "revoked") return forbidden();
    if (Date.parse(selected.cooling_until) > clock()) { publish({ errorCode: "recipient_cooling_active", message: errorMessage("recipient_cooling_active") }); return null; }
    if (confirmed !== true || confirmAction("activate") !== true) return null;
    if (!state.stepUpFresh) return requireStepUp();
    const result = await run(() => api.activateRecipientVersion(target.recipient_id, selected.recipient_version_id, { evidence_id: evidence.evidence_id, evidence_digest: evidence.evidence_digest, version: target.version }), { clearOnNotFound: true });
    if (result) {
      const nextRecipient = sanitizeRecipient(result.recipient); const nextVersion = sanitizeVersion(result.recipient_version);
      publish({ recipients: replace(state.recipients, nextRecipient, "recipient_id"), versions: replace(state.versions, nextVersion, "recipient_version_id"), message: "Recipient version activated.", stepUpFresh: false });
    }
    return result;
  }

  async function revoke(confirmed) {
    const target = recipient();
    if (!canManage() || !target || confirmed !== true || confirmAction("revoke") !== true) return null;
    if (!state.stepUpFresh) return requireStepUp();
    const result = await run(() => api.updateRecipient(target.recipient_id, { status: "revoked", version: target.version }), { clearOnNotFound: true });
    if (result) { const next = sanitizeRecipient(result.recipient); publish({ recipients: replace(state.recipients, next, "recipient_id"), versions: [], selectedVersionId: "", evidenceByVersion: Object.freeze({}), message: "Recipient revoked. No version remains selectable.", stepUpFresh: false }); }
    return result;
  }

  async function startStepUp() { const result = await run(() => api.startStepUp()); if (result) publish({ stepUpRequired: true, message: "A short-lived step-up challenge was sent." }); return result; }
  async function completeStepUp(token) { const result = await run(() => api.completeStepUp(token)); if (result) publish({ stepUpRequired: false, stepUpFresh: true, message: "Step-up completed. Confirm the action again." }); return result; }
  function requireStepUp() { publish({ stepUpRequired: true, errorCode: "step_up_required", message: errorMessage("step_up_required") }); return null; }
  function forbidden() { publish({ errorCode: "forbidden", message: errorMessage("forbidden") }); return null; }

  return Object.freeze({ getState: () => state, canManage, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, setView(patch) { publish(patch); }, selectVersion(id) { const target = state.versions.find((item) => item.recipient_version_id === id); if (!target || recipient()?.status === "revoked" || target.verification_state === "revoked") return forbidden(); publish({ selectedVersionId: id }); return id; }, load, select, create, createVersion, verify, activate, revoke, startStepUp, completeStepUp });
}

function sanitizeRecipient(value) { if (!value?.recipient_id) throw new TypeError("Recipient response is invalid"); return Object.freeze({ recipient_id: String(value.recipient_id), name: String(value.name || "Unnamed Recipient"), status: String(value.status || "draft"), active_version_id: value.active_version_id ? String(value.active_version_id) : null, version: Number(value.version || 0) }); }
function sanitizeVersion(value) { if (!value?.recipient_version_id || !value.network || !value.asset || !value.address) throw new TypeError("Recipient version response is invalid"); return Object.freeze({ recipient_version_id: String(value.recipient_version_id), rail: String(value.rail || ""), network: String(value.network), asset: String(value.asset), address: String(value.address), contract: value.contract ? String(value.contract) : null, issuer: value.issuer ? String(value.issuer) : null, memo: value.memo ? String(value.memo) : null, verification_state: String(value.verification_state || "unverified"), cooling_until: String(value.cooling_until || value.effective_at || ""), created_at: String(value.created_at || "") }); }
function sanitizeEvidence(value) { if (!value?.evidence_id || !value.evidence_digest) throw new TypeError("Recipient evidence response is invalid"); return Object.freeze({ evidence_id: String(value.evidence_id), evidence_digest: String(value.evidence_digest), type: String(value.type || "unknown"), status: String(value.status || "valid"), expires_at: String(value.expires_at || "") }); }
function factsInput(input) { return { rail: input.rail, network: input.network, asset: input.asset, address: input.address, ...(input.contract ? { contract: input.contract } : {}), ...(input.issuer ? { issuer: input.issuer } : {}), ...(input.memo ? { memo: input.memo } : {}) }; }
function replace(items, value, key) { return items.map((item) => item[key] === value[key] ? value : item); }
function withNotification(current, versionId, value) { return Object.freeze({ ...current, [versionId]: value ? Object.freeze({ status: String(value.status || "unknown"), audience_role: String(value.audience_role || "owner") }) : null }); }
function errorMessage(code) { const map = { invalid_recipient: "Recipient facts failed validation. Review network, asset, full address, bindings, and memo/tag.", unsupported_asset: "This network and asset combination is not supported.", recipient_unicode_confusable: "Recipient facts contain unsafe or confusable characters.", concurrency_conflict: "This Recipient changed elsewhere. Reload before retrying.", recipient_revoked: "This Recipient is revoked and no version can be selected or activated.", recipient_cooling_active: "The configured Recipient cooling period has not completed.", recipient_evidence_expired: "Verification evidence expired and must be renewed.", recipient_evidence_facts_mismatch: "Verification evidence does not bind the selected immutable facts.", step_up_required: "Recent step-up authentication is required.", forbidden: "Your server-issued role does not permit Recipient management." }; return map[code] || "The Recipient request could not be completed."; }

export function mountRecipients({ container, api, session, onSessionInvalid }) {
  if (!container) return null;
  const model = createRecipientsModel({ api, session, confirmAction: (action) => globalThis.confirm(action === "revoke" ? "Revoke this Recipient? No version will remain usable." : "Activate this verified version as the authoritative Recipient facts?"), onSessionInvalid });
  const paint = (state) => { container.innerHTML = renderRecipients(state, model.canManage()); bind(container, model); };
  model.subscribe(paint); paint(model.getState()); void model.load(); return model;
}

function bind(container, model) {
  container.querySelector("#show-create-recipient")?.addEventListener("click", () => model.setView({ showCreate: true }));
  container.querySelector("#show-new-recipient-version")?.addEventListener("click", () => model.setView({ showVersionForm: true }));
  for (const button of container.querySelectorAll("[data-select-recipient]")) button.addEventListener("click", () => void model.select(button.dataset.selectRecipient));
  for (const button of container.querySelectorAll("[data-select-recipient-version]")) button.addEventListener("click", () => model.selectVersion(button.dataset.selectRecipientVersion));
  for (const [selector, action] of [["#create-recipient-form", "create"], ["#create-recipient-version-form", "createVersion"]]) container.querySelector(selector)?.addEventListener("submit", (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void model[action](factsFromForm(data)); });
  container.querySelector("#verify-recipient-form")?.addEventListener("submit", (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void model.verify({ type: data.get("type"), sourceId: data.get("source_id"), evidenceDigest: data.get("evidence_digest") }); });
  container.querySelector("#activate-recipient-version")?.addEventListener("click", () => void model.activate(true));
  container.querySelector("#revoke-recipient")?.addEventListener("click", () => void model.revoke(true));
  container.querySelector("#start-recipient-step-up")?.addEventListener("click", () => void model.startStepUp());
  container.querySelector("#complete-recipient-step-up-form")?.addEventListener("submit", (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void model.completeStepUp(data.get("challenge_token")); event.currentTarget.reset(); });
}
function factsFromForm(data) { return { name: data.get("name"), rail: data.get("rail"), network: data.get("network"), asset: data.get("asset"), address: data.get("address"), contract: data.get("contract"), issuer: data.get("issuer"), memo: data.get("memo") }; }

export { renderRecipients };
