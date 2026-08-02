import { PortalApiError, ReauthenticationRequiredError, SessionExpiredError } from "../../../public/modules/api-client.js";
import { escapeHtml, renderMembers } from "../../components/members/view.js";

const SERVER_ROLE_CAPABILITIES = Object.freeze({
  owner: Object.freeze(["organization.manage", "members.manage"]),
  admin: Object.freeze(["organization.manage", "members.manage"]),
  developer: Object.freeze([]),
  viewer: Object.freeze([])
});

export function capabilitiesForServerRole(role) {
  return SERVER_ROLE_CAPABILITIES[String(role || "").toLowerCase()] || Object.freeze([]);
}

export function createOrganizationMembersModel({ api, session, confirmAction = () => false, onSessionInvalid = () => {} }) {
  if (!api || !session?.merchantId) throw new TypeError("Organization model requires API and authenticated merchant session");
  const capabilities = capabilitiesForServerRole(session.role);
  let state = Object.freeze({ loading: true, busy: false, merchant: null, members: [], invitations: [], message: "", errorCode: "", stepUpRequired: false });
  const listeners = new Set();

  function publish(patch) {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener(state);
  }

  async function run(operation, { refreshOnConflict = false, preserveMessage = false } = {}) {
    publish({ busy: true, ...(preserveMessage ? {} : { message: "", errorCode: "" }) });
    try {
      const result = await operation();
      publish({ busy: false, stepUpRequired: false });
      return result;
    } catch (error) {
      if (error instanceof SessionExpiredError || error instanceof ReauthenticationRequiredError) {
        clearSensitiveState("session_invalid", "Your session can no longer authorize this page.");
        onSessionInvalid(error);
        return null;
      }
      if (error?.status === 404 || error?.code === "resource_not_found") {
        clearSensitiveState("resource_not_found", "The organization resource is unavailable.");
        return null;
      }
      const message = messageForError(error);
      publish({ busy: false, message, errorCode: error?.code || "api_error", stepUpRequired: error?.code === "step_up_required" });
      if (refreshOnConflict && error?.code === "concurrency_conflict") await load({ preserveMessage: true });
      return null;
    }
  }

  function clearSensitiveState(errorCode, message) {
    publish({ loading: false, busy: false, merchant: null, members: [], invitations: [], errorCode, message, stepUpRequired: false });
  }

  async function load({ preserveMessage = false } = {}) {
    publish({ loading: true, ...(preserveMessage ? {} : { message: "", errorCode: "" }) });
    const result = await run(async () => {
      const [merchant, members] = await Promise.all([api.getMerchant(session.merchantId), api.listMemberships(session.merchantId)]);
      publish({ loading: false, merchant, members: Array.isArray(members) ? members : [], busy: false });
      return true;
    }, { preserveMessage });
    if (!result && state.loading) publish({ loading: false, busy: false });
  }

  async function updateProfile(input) {
    if (!capabilities.includes("organization.manage") || !state.merchant) return forbidden();
    const merchant = await run(() => api.updateMerchant(session.merchantId, {
      display_name: input.displayName,
      legal_name: input.legalName,
      version: state.merchant.version
    }), { refreshOnConflict: true });
    if (merchant) publish({ merchant, message: "Organization profile updated." });
    return merchant;
  }

  async function changeLifecycle(nextStatus, confirmed) {
    if (!capabilities.includes("organization.manage") || !state.merchant) return forbidden();
    if (!["suspended", "closed"].includes(nextStatus) || confirmed !== true || confirmAction(nextStatus) !== true) return null;
    const merchant = await run(() => api.updateMerchant(session.merchantId, { status: nextStatus, version: state.merchant.version }), { refreshOnConflict: true });
    if (merchant) publish({ merchant, message: `Organization is now ${merchant.status}.` });
    return merchant;
  }

  async function invite(input) {
    if (!capabilities.includes("members.manage")) return forbidden();
    const invitation = await run(() => api.inviteMember(session.merchantId, { email: input.email, role: input.role }));
    if (invitation) publish({ invitations: [...state.invitations, publicInvitation(invitation)], message: "Invitation created. The delivery token is never displayed here." });
    return invitation;
  }

  async function changeRole(membershipId, role, version) {
    if (!capabilities.includes("members.manage")) return forbidden();
    const membership = await run(() => api.changeMemberRole(session.merchantId, membershipId, { role, version }), { refreshOnConflict: true });
    if (membership) replaceMember(membership, "Member role updated.");
    return membership;
  }

  async function remove(membershipId, version, confirmed) {
    if (!capabilities.includes("members.manage") || confirmed !== true) return forbidden();
    const membership = await run(() => api.removeMember(session.merchantId, membershipId, { version }), { refreshOnConflict: true });
    if (membership) replaceMember(membership, "Member removed.");
    return membership;
  }

  async function startStepUp() {
    const result = await run(() => api.startStepUp());
    if (result) publish({ message: "A short-lived step-up challenge was sent to the verified account email.", stepUpRequired: true });
    return result;
  }

  async function completeStepUp(token) {
    const result = await run(() => api.completeStepUp(token));
    if (result) publish({ message: "Step-up authentication completed. Retry the sensitive action.", stepUpRequired: false });
    return result;
  }

  function replaceMember(membership, message) {
    publish({ members: state.members.map((item) => item.membership_id === membership.membership_id ? membership : item), message });
  }

  function forbidden() {
    publish({ message: "Your server-issued role does not include this capability.", errorCode: "forbidden" });
    return null;
  }

  return Object.freeze({
    getState: () => state,
    can: (capability) => capabilities.includes(capability),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    load,
    updateProfile,
    changeLifecycle,
    invite,
    changeRole,
    remove,
    startStepUp,
    completeStepUp
  });
}

export function renderOrganizationMembers(state, route, capabilities = []) {
  if (state.loading) return '<h2 id="route-title">Loading organization…</h2><p role="status">Retrieving tenant-scoped data.</p>';
  if (!state.merchant) return `<h2 id="route-title">Organization unavailable</h2>${statusMessage(state)}`;
  if (route === "members") {
    return `${statusMessage(state)}${stepUpPanel(state)}${renderMembers({ members: state.members, invitations: state.invitations, canManage: capabilities.includes("members.manage"), busy: state.busy })}`;
  }
  const merchant = state.merchant;
  const canManage = capabilities.includes("organization.manage");
  return `${statusMessage(state)}${stepUpPanel(state)}<section aria-labelledby="organization-title">
    <h2 id="organization-title">Organization profile</h2>
    <dl class="organization-facts"><div><dt>Status</dt><dd>${escapeHtml(merchant.status)}</dd></div><div><dt>Verification</dt><dd>${escapeHtml(merchant.verification_state || "Unavailable")}</dd></div></dl>
    ${canManage ? `<form id="organization-profile-form">
      <label for="display-name">Display name</label><input id="display-name" name="display_name" required maxlength="120" value="${escapeHtml(merchant.display_name)}">
      <label for="legal-name">Legal name</label><input id="legal-name" name="legal_name" maxlength="200" value="${escapeHtml(merchant.legal_name || "")}">
      <button type="submit" ${state.busy ? "disabled" : ""}>Save profile</button>
    </form>${lifecycleControls(merchant, state.busy)}` : '<p class="muted">Your server-issued role has read-only organization access.</p>'}
  </section>`;
}

function lifecycleControls(merchant, busy) {
  if (!['active', 'suspended'].includes(merchant.status)) return "";
  return `<section class="danger-zone" aria-labelledby="lifecycle-title"><h3 id="lifecycle-title">Organization lifecycle</h3>
    <p>Suspension immediately stops platform capabilities. Closure is terminal and cannot be reversed.</p>
    ${merchant.status === "active" ? `<button type="button" class="danger" data-lifecycle="suspended" ${busy ? "disabled" : ""}>Suspend organization</button>` : ""}
    <button type="button" class="danger" data-lifecycle="closed" ${busy ? "disabled" : ""}>Close organization</button>
  </section>`;
}

function stepUpPanel(state) {
  if (!state.stepUpRequired) return "";
  return `<section class="notice" aria-labelledby="step-up-title"><h3 id="step-up-title">Recent authentication required</h3>
    <p>Send a short-lived challenge to the verified account email, complete it, then retry the sensitive action.</p>
    <button type="button" id="start-step-up" class="secondary">Send challenge</button>
    <form id="complete-step-up-form" autocomplete="off"><label for="step-up-token">Challenge token</label><input id="step-up-token" name="challenge_token" type="password" required autocomplete="one-time-code"><button type="submit">Verify</button></form>
  </section>`;
}

function statusMessage(state) {
  return state.message ? `<div class="notice ${state.errorCode ? "notice-error" : ""}" role="status">${escapeHtml(state.message)}</div>` : "";
}

function publicInvitation(invitation) {
  return Object.freeze({
    invitation_id: String(invitation.invitation_id || ""),
    email_normalized: String(invitation.email_normalized || ""),
    role: String(invitation.role || ""),
    status: String(invitation.status || ""),
    expires_at: String(invitation.expires_at || "")
  });
}

function messageForError(error) {
  const messages = {
    concurrency_conflict: "This resource changed elsewhere. Current values were reloaded; review them before retrying.",
    step_up_required: "Recent step-up authentication is required for this action.",
    last_owner_required: "The last Owner cannot be demoted or removed.",
    forbidden: "Your server-issued role does not permit this action."
  };
  if (error instanceof PortalApiError) return messages[error.code] || error.message;
  return String(error?.message || "The organization request failed.").slice(0, 180);
}

export function mountOrganizationMembers({ container, api, session, route, onSessionInvalid }) {
  if (!container) return null;
  const model = createOrganizationMembersModel({
    api,
    session,
    confirmAction(status) {
      const consequence = status === "closed"
        ? "Close this organization permanently? This cannot be undone."
        : "Suspend this organization? Agent, Recipient, and Webhook capabilities will stop immediately.";
      return globalThis.confirm(consequence);
    },
    onSessionInvalid
  });
  const capabilities = capabilitiesForServerRole(session.role);
  const paint = (state) => {
    container.innerHTML = renderOrganizationMembers(state, route, capabilities);
    bind(container, model);
  };
  model.subscribe(paint);
  paint(model.getState());
  void model.load();
  return model;
}

function bind(container, model) {
  container.querySelector("#organization-profile-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void model.updateProfile({ displayName: data.get("display_name"), legalName: data.get("legal_name") });
  });
  container.querySelector("#invite-member-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void model.invite({ email: data.get("email"), role: data.get("role") });
  });
  for (const button of container.querySelectorAll("[data-lifecycle]")) button.addEventListener("click", () => void model.changeLifecycle(button.dataset.lifecycle, true));
  for (const button of container.querySelectorAll("[data-change-role]")) button.addEventListener("click", () => {
    const row = button.closest("[data-membership-id]");
    void model.changeRole(row.dataset.membershipId, row.querySelector("[data-member-role]").value, Number(button.dataset.version));
  });
  for (const button of container.querySelectorAll("[data-remove-member]")) button.addEventListener("click", () => {
    if (!globalThis.confirm("Remove this member? Their active merchant sessions will be revoked.")) return;
    const row = button.closest("[data-membership-id]");
    void model.remove(row.dataset.membershipId, Number(button.dataset.version), true);
  });
  container.querySelector("#start-step-up")?.addEventListener("click", () => void model.startStepUp());
  container.querySelector("#complete-step-up-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void model.completeStepUp(data.get("challenge_token"));
  });
}
