export const AGENT_SCOPES = Object.freeze([
  "payment.requests.create",
  "payment.requests.read",
  "transaction_contexts.create",
  "transaction_contexts.read",
  "wallet.addresses.read"
]);

export function renderAgents(state, canManage) {
  return `<section aria-labelledby="agents-title">
    <div class="section-heading"><div><h2 id="agents-title">Agents and credentials</h2><p>Private keys remain with the local Agent.</p></div></div>
    ${statusMessage(state)}${state.stepUpRequired ? stepUpPanel() : ""}
    <div class="agent-layout"><aside class="agent-list" aria-label="Registered Agents">
      ${state.agents.map((agent) => `<button type="button" class="agent-list-item ${agent.agent_id === state.selectedAgentId ? "selected" : ""}" data-select-agent="${escapeHtml(agent.agent_id)}"><strong>${escapeHtml(agent.name)}</strong><span>${escapeHtml(agent.status)}</span></button>`).join("") || '<p class="muted">No Agents registered.</p>'}
      ${canManage ? '<button type="button" id="show-create-agent" class="secondary">Register Agent</button>' : ""}
    </aside><div class="agent-detail">${state.showCreate ? createAgentForm(state.busy) : selectedAgent(state, canManage)}</div></div>
  </section>`;
}

function createAgentForm(busy) {
  return `<section aria-labelledby="create-agent-title"><h3 id="create-agent-title">Register Agent</h3><form id="create-agent-form">
    <label for="agent-name">Name</label><input id="agent-name" name="name" maxlength="120" required>
    <label for="agent-runtime">Runtime</label><input id="agent-runtime" name="runtime" maxlength="80" required placeholder="node">
    <label for="agent-environment">Environment</label><select id="agent-environment" name="environment"><option value="sandbox">Sandbox</option><option value="testnet">Testnet</option><option value="production">Production</option></select>
    <fieldset><legend>Maximum scopes</legend>${scopeInputs([])}</fieldset>
    <button type="submit" ${busy ? "disabled" : ""}>Register</button>
  </form></section>`;
}

function selectedAgent(state, canManage) {
  const agent = state.agents.find((item) => item.agent_id === state.selectedAgentId);
  if (!agent) return '<p class="muted">Select an Agent to inspect its credentials.</p>';
  return `<section aria-labelledby="agent-detail-title"><div class="section-heading"><div><h3 id="agent-detail-title">${escapeHtml(agent.name)}</h3><p>${escapeHtml(agent.runtime)} · ${escapeHtml(agent.environment)} · ${escapeHtml(agent.status)}</p></div></div>
    <h4>Allowed scopes</h4><ul class="scope-list">${agent.allowed_scopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join("") || "<li>None</li>"}</ul>
    ${canManage ? agentActions(agent, state.busy) : '<p class="muted">Your server-issued role has read-only Agent access.</p>'}
    ${credentialsPanel(state, agent, canManage)}
  </section>`;
}

function agentActions(agent, busy) {
  if (agent.status === "revoked") return '<p class="notice">Revoked Agents cannot be changed.</p>';
  return `<details><summary>Change Agent scopes</summary><form id="change-agent-scopes-form"><fieldset><legend>Maximum scopes</legend>${scopeInputs(agent.allowed_scopes)}</fieldset><button type="submit" ${busy ? "disabled" : ""}>Save scopes</button></form></details>
    <div class="row-actions">${agent.status === "draft" ? `<button type="button" data-agent-status="active" ${busy ? "disabled" : ""}>Activate</button>` : ""}${agent.status === "active" ? `<button type="button" class="danger" data-agent-status="suspended" ${busy ? "disabled" : ""}>Suspend</button>` : ""}${agent.status === "suspended" ? `<button type="button" data-agent-status="active" ${busy ? "disabled" : ""}>Reactivate</button>` : ""}<button type="button" class="danger" data-agent-status="revoked" ${busy ? "disabled" : ""}>Revoke Agent</button></div>`;
}

function credentialsPanel(state, agent, canManage) {
  return `<section class="credential-section" aria-labelledby="credentials-title"><div class="section-heading"><div><h4 id="credentials-title">Public credentials</h4><p>Only Ed25519 public keys and local proof signatures are accepted.</p></div>${canManage && agent.status !== "revoked" ? '<button type="button" id="show-register-credential" class="secondary">Add public key</button>' : ""}</div>
    ${state.showCredentialForm ? credentialForm(state.busy) : ""}
    ${state.pendingProof ? proofForm(state.pendingProof, state.busy) : ""}
    <div class="credential-grid">${state.credentials.map((credential) => credentialCard(credential, canManage, state.busy)).join("") || '<p class="muted">No credentials registered.</p>'}</div>
  </section>`;
}

function credentialForm(busy) {
  const tomorrow = new Date(Date.now() + 60_000).toISOString().slice(0, 16);
  const nextMonth = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 16);
  return `<form id="register-credential-form" class="sub-form" autocomplete="off">
    <div class="notice">Paste an Ed25519 public key only. Never paste a private key, seed phrase, Secret, Token, or Assertion.</div>
    <label for="credential-kid">Key ID (kid)</label><input id="credential-kid" name="kid" required maxlength="80">
    <label for="credential-public-key">Ed25519 public key</label><textarea id="credential-public-key" name="public_key" required rows="3" autocomplete="off"></textarea>
    <label for="credential-not-before">Valid from</label><input id="credential-not-before" name="not_before" type="datetime-local" required value="${tomorrow}">
    <label for="credential-expires">Expires</label><input id="credential-expires" name="expires_at" type="datetime-local" required value="${nextMonth}">
    <button type="submit" ${busy ? "disabled" : ""}>Register public key</button>
  </form>`;
}

function proofForm(proof, busy) {
  return `<form id="activate-credential-form" class="sub-form" autocomplete="off"><h5>Local proof of possession</h5>
    <p>Ask the local Agent to sign this one-time challenge. It expires ${formatTime(proof.expiresAt)}.</p><code class="proof-challenge">${escapeHtml(proof.challenge)}</code>
    <label for="proof-signature">Agent signature</label><textarea id="proof-signature" name="signature" required rows="3" autocomplete="off"></textarea>
    <button type="submit" ${busy ? "disabled" : ""}>Verify signature and activate</button>
  </form>`;
}

function credentialCard(credential, canManage, busy) {
  const overlap = credential.overlap_expires_at || (credential.status === "expiring" ? credential.expires_at : "");
  return `<article class="credential-card" data-credential-id="${escapeHtml(credential.credential_id)}"><div class="section-heading"><h5>${escapeHtml(credential.kid)}</h5><span class="status-badge status-${escapeHtml(credential.status)}">${escapeHtml(credential.status)}</span></div><dl>
    <div><dt>Valid from</dt><dd>${formatTime(credential.not_before)}</dd></div><div><dt>Expires</dt><dd>${formatTime(credential.expires_at)}</dd></div><div><dt>Last used</dt><dd>${formatTime(credential.last_used_at)}</dd></div><div><dt>Overlap ends</dt><dd>${formatTime(overlap)}</dd></div></dl>
    ${canManage && !["revoked", "expired"].includes(credential.status) ? `<button type="button" class="danger" data-revoke-credential data-version="${credential.version}" ${busy ? "disabled" : ""}>Revoke credential</button>` : ""}</article>`;
}

function scopeInputs(selected) {
  const values = new Set(selected);
  return AGENT_SCOPES.map((scope) => `<label class="check-row"><input type="checkbox" name="allowed_scopes" value="${scope}" ${values.has(scope) ? "checked" : ""}> <code>${scope}</code></label>`).join("");
}

function stepUpPanel() {
  return `<section class="notice" aria-labelledby="agent-step-up-title"><h3 id="agent-step-up-title">Recent authentication required</h3><p>Complete email step-up, then confirm the sensitive action again.</p><button type="button" id="start-agent-step-up" class="secondary">Send challenge</button><form id="complete-agent-step-up-form" autocomplete="off"><label for="agent-step-up-token">Challenge token</label><input id="agent-step-up-token" name="challenge_token" type="password" required autocomplete="one-time-code"><button type="submit">Verify</button></form></section>`;
}

function statusMessage(state) {
  return state.message ? `<div class="notice ${state.errorCode ? "notice-error" : ""}" role="status">${escapeHtml(state.message)}</div>` : "";
}

function formatTime(value) {
  if (!value) return "Not provided by API";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }) : "Not provided by API";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
