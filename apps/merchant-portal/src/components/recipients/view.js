export function renderRecipients(state, canManage, now = Date.now()) {
  return `<section aria-labelledby="recipients-title"><div class="section-heading"><div><h2 id="recipients-title">Recipients</h2><p>Names are labels. Versioned payment facts remain authoritative.</p></div>${canManage ? '<button type="button" id="show-create-recipient" class="secondary">Create Recipient</button>' : ""}</div>
    ${statusMessage(state)}${state.stepUpRequired ? stepUpPanel() : ""}
    <div class="recipient-layout"><aside class="recipient-list" aria-label="Recipients">${state.recipients.map((recipient) => `<button type="button" class="agent-list-item ${recipient.recipient_id === state.selectedRecipientId ? "selected" : ""}" data-select-recipient="${escapeHtml(recipient.recipient_id)}"><strong>${escapeHtml(recipient.name)}</strong><span>${escapeHtml(recipient.status)}</span></button>`).join("") || '<p class="muted">No Recipients registered.</p>'}</aside>
    <div>${state.showCreate ? factsForm("create-recipient-form", "Create Recipient", null, state.busy, true) : recipientDetail(state, canManage, now)}</div></div>
  </section>`;
}

function recipientDetail(state, canManage, now) {
  const recipient = state.recipients.find((item) => item.recipient_id === state.selectedRecipientId);
  if (!recipient) return '<p class="muted">Select a Recipient to inspect immutable facts.</p>';
  const selected = state.versions.find((item) => item.recipient_version_id === state.selectedVersionId);
  return `<section aria-labelledby="recipient-detail-title"><div class="section-heading"><div><p class="eyebrow">Display label</p><h3 id="recipient-detail-title">${escapeHtml(recipient.name)}</h3><p>Status: ${escapeHtml(recipient.status)}</p></div>${canManage && recipient.status !== "revoked" ? '<button type="button" id="show-new-recipient-version" class="secondary">New facts version</button>' : ""}</div>
    ${state.showVersionForm ? factsForm("create-recipient-version-form", "Create new facts version", selected, state.busy, false) : ""}
    ${selected ? factPanel(selected, now) : '<p class="muted">No version selected.</p>'}
    ${selected ? verificationPanel(state, selected, recipient, canManage, now) : ""}
    ${versionHistory(state.versions, state.selectedVersionId, recipient.status)}
    ${canManage && recipient.status !== "revoked" ? `<section class="danger-zone"><h4>Recipient lifecycle</h4><button type="button" id="revoke-recipient" class="danger" ${state.busy ? "disabled" : ""}>Revoke Recipient</button></section>` : ""}
  </section>`;
}

function factPanel(version, now) {
  const remaining = Math.max(0, Date.parse(version.cooling_until) - now);
  return `<section class="fact-panel" aria-labelledby="facts-title"><div class="section-heading"><h4 id="facts-title">Immutable payment facts</h4><span class="status-badge">${escapeHtml(version.verification_state)}</span></div><dl>
    ${fact("Network", version.network)}${fact("Asset", version.asset)}${fact("Address", version.address, true)}${fact("Contract", version.contract)}${fact("Issuer", version.issuer)}${fact("Memo or tag", version.memo)}
  </dl><p class="cooling-time" data-cooling-ms="${remaining}">${remaining ? `Cooling period: ${formatDuration(remaining)} remaining` : "Cooling period complete"}</p></section>`;
}

function verificationPanel(state, version, recipient, canManage, now) {
  const evidence = state.evidenceByVersion[version.recipient_version_id] || null;
  const notification = state.notificationByVersion[version.recipient_version_id] || null;
  const cooling = Date.parse(version.cooling_until) > now;
  return `<section class="verification-panel" aria-labelledby="verification-title"><h4 id="verification-title">Verification and activation</h4><dl>
    <div><dt>Evidence type</dt><dd>${escapeHtml(evidence?.type || "Not verified")}</dd></div><div><dt>Evidence state</dt><dd>${escapeHtml(evidence?.status || version.verification_state)}</dd></div><div><dt>Owner notification</dt><dd>${escapeHtml(notification?.status || "Not returned by API")}</dd></div></dl>
    ${canManage && !["active", "superseded", "revoked"].includes(version.verification_state) ? evidenceForm(state.busy, version) : ""}
    ${canManage && evidence ? `<button type="button" id="activate-recipient-version" ${cooling || state.busy ? "disabled" : ""}>Activate this version</button>${cooling ? '<p class="muted">Activation remains disabled until the server cooling time completes.</p>' : ""}` : ""}
  </section>`;
}

function evidenceForm(busy, version) {
  return `<form id="verify-recipient-form"><input type="hidden" name="recipient_version_id" value="${escapeHtml(version.recipient_version_id)}">
    <label for="evidence-type">Verification type</label><select id="evidence-type" name="type"><option value="domain_proof">Domain proof</option><option value="address_control">Address control</option><option value="reviewed_operational">Reviewed operational</option></select>
    <label for="evidence-source">Trusted source ID</label><input id="evidence-source" name="source_id" required>
    <label for="evidence-digest">Evidence digest</label><input id="evidence-digest" name="evidence_digest" required autocomplete="off">
    <button type="submit" ${busy ? "disabled" : ""}>Verify evidence</button>
  </form>`;
}

function versionHistory(versions, selectedId, recipientStatus) {
  return `<section aria-labelledby="version-history-title"><h4 id="version-history-title">Version history</h4><ol class="version-history">${versions.map((version, index) => {
    const blocked = recipientStatus === "revoked" || version.verification_state === "revoked";
    return `<li><button type="button" class="secondary" data-select-recipient-version="${escapeHtml(version.recipient_version_id)}" ${blocked ? "disabled" : ""} ${version.recipient_version_id === selectedId ? 'aria-current="true"' : ""}>Version ${index + 1} · ${escapeHtml(version.verification_state)} · ${formatTime(version.created_at)}</button></li>`;
  }).join("") || "<li>No versions returned.</li>"}</ol></section>`;
}

function factsForm(id, title, version, busy, includeName) {
  return `<form id="${id}" class="sub-form"><h4>${title}</h4>${includeName ? '<label for="recipient-name">Display name</label><input id="recipient-name" name="name" required maxlength="120">' : ""}
    <label for="recipient-rail">Rail</label><input id="recipient-rail" name="rail" value="${escapeHtml(version?.rail || "")}" placeholder="stellar" required>
    <label for="recipient-network">Network</label><input id="recipient-network" name="network" value="${escapeHtml(version?.network || "")}" required>
    <label for="recipient-asset">Asset</label><input id="recipient-asset" name="asset" value="${escapeHtml(version?.asset || "")}" required>
    <label for="recipient-address">Full address</label><input id="recipient-address" name="address" value="${escapeHtml(version?.address || "")}" required autocomplete="off">
    <label for="recipient-contract">Contract (when required)</label><input id="recipient-contract" name="contract" value="${escapeHtml(version?.contract || "")}" autocomplete="off">
    <label for="recipient-issuer">Issuer (when required)</label><input id="recipient-issuer" name="issuer" value="${escapeHtml(version?.issuer || "")}" autocomplete="off">
    <label for="recipient-memo">Memo or tag</label><input id="recipient-memo" name="memo" value="${escapeHtml(version?.memo || "")}" autocomplete="off">
    <button type="submit" ${busy ? "disabled" : ""}>${includeName ? "Create Recipient" : "Create version and start 24-hour cooling"}</button>
  </form>`;
}

function stepUpPanel() {
  return `<section class="notice"><h3>Recent authentication required</h3><p>Complete email step-up, then confirm activation or revocation again.</p><button type="button" id="start-recipient-step-up" class="secondary">Send challenge</button><form id="complete-recipient-step-up-form" autocomplete="off"><label for="recipient-step-up-token">Challenge token</label><input id="recipient-step-up-token" name="challenge_token" type="password" required autocomplete="one-time-code"><button type="submit">Verify</button></form></section>`;
}

function statusMessage(state) { return state.message ? `<div class="notice ${state.errorCode ? "notice-error" : ""}" role="status">${escapeHtml(state.message)}</div>` : ""; }
function fact(label, value, full = false) { return `<div class="${full ? "full-fact" : ""}"><dt>${label}</dt><dd>${escapeHtml(value ?? "None")}</dd></div>`; }
function formatTime(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }) : "Unavailable"; }
function formatDuration(ms) { const hours = Math.floor(ms / 3_600_000); const minutes = Math.floor((ms % 3_600_000) / 60_000); return `${hours}h ${minutes}m`; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
