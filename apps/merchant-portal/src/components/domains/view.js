const HTTPS_PATH = "/.well-known/velarumpay-domain-verification";

export function renderDomainVerification(state, canManage) {
  if (!state.domain) return `<section aria-labelledby="domains-title"><h2 id="domains-title">Verify a domain</h2>
    ${statusMessage(state)}
    ${canManage ? `<p>Prove control with a DNS TXT record or a controlled HTTPS well-known response.</p>
      <form id="create-domain-form">
        <label for="domain-name">Domain</label><input id="domain-name" name="domain" required inputmode="url" autocomplete="off" placeholder="pay.example.org">
        <label for="domain-method">Verification method</label><select id="domain-method" name="method"><option value="dns_txt">DNS TXT</option><option value="https_well_known">HTTPS well-known</option></select>
        <button type="submit" ${state.busy ? "disabled" : ""}>Create challenge</button>
      </form>` : '<p class="muted">Your server-issued role does not permit domain management.</p>'}
  </section>`;

  const domain = state.domain;
  return `<section aria-labelledby="domains-title">
    <div class="section-heading"><div><h2 id="domains-title">Domain verification</h2><p>${escapeHtml(domain.domain)}</p></div><span class="status-badge status-${statusClass(state.displayStatus)}">${escapeHtml(statusLabel(state.displayStatus))}</span></div>
    ${statusMessage(state)}
    <dl class="domain-facts"><div><dt>Method</dt><dd>${domain.method === "dns_txt" ? "DNS TXT" : "HTTPS well-known"}</dd></div><div><dt>Challenge expires</dt><dd>${formatTime(state.challengeExpiresAt)}</dd></div><div><dt>Next re-verification</dt><dd>${formatTime(state.reverifyAt)}</dd></div></dl>
    ${state.challenge ? challengePanel(state) : ""}
    ${canManage ? actionPanel(state) : '<p class="muted">Your server-issued role has read-only domain access.</p>'}
    ${state.stepUpRequired ? stepUpPanel() : ""}
  </section>`;
}

function challengePanel(state) {
  const isDns = state.domain.method === "dns_txt";
  return `<section class="challenge-panel" aria-labelledby="challenge-title"><h3 id="challenge-title">Publish this challenge</h3>
    ${isDns ? `<dl><div><dt>TXT name</dt><dd><code>${escapeHtml(state.dnsName)}</code></dd></div><div><dt>TXT value</dt><dd><code>${escapeHtml(state.challenge)}</code></dd></div></dl>`
      : `<dl><div><dt>HTTPS path</dt><dd><code>${HTTPS_PATH}</code></dd></div><div><dt>JSON response</dt><dd><code>${escapeHtml(JSON.stringify({ challenge: state.challenge }))}</code></dd></div></dl>`}
    <button type="button" id="copy-domain-challenge" class="secondary">Copy challenge value</button>
    <span id="copy-domain-status" role="status"></span>
  </section>`;
}

function actionPanel(state) {
  const status = state.displayStatus;
  if (["pending", "failed", "expired", "reverification_required"].includes(status)) {
    return `<button type="button" id="verify-domain" ${state.busy ? "disabled" : ""}>${status === "reverification_required" ? "Verify again" : "Check verification"}</button>`;
  }
  if (status === "verified") {
    return `<section class="danger-zone"><h3>Replace verification proof</h3><p>Starting re-verification invalidates the previous evidence and requires recent step-up authentication.</p><button type="button" id="reverify-domain" class="danger" ${state.busy ? "disabled" : ""}>Start re-verification</button></section>`;
  }
  return "";
}

function stepUpPanel() {
  return `<section class="notice" aria-labelledby="domain-step-up-title"><h3 id="domain-step-up-title">Recent authentication required</h3>
    <p>Send a short-lived challenge to the verified account email before replacing domain proof.</p>
    <button type="button" id="start-domain-step-up" class="secondary">Send challenge</button>
    <form id="complete-domain-step-up-form" autocomplete="off"><label for="domain-step-up-token">Challenge token</label><input id="domain-step-up-token" name="challenge_token" type="password" required autocomplete="one-time-code"><button type="submit">Verify</button></form>
  </section>`;
}

function statusMessage(state) {
  return state.message ? `<div class="notice ${state.errorCode ? "notice-error" : ""}" role="status">${escapeHtml(state.message)}</div>` : "";
}

function statusLabel(status) {
  const labels = { pending: "Pending", failed: "Failed", expired: "Expired", verified: "Verified", reverification_required: "Re-verification required" };
  return labels[status] || "Pending";
}

function statusClass(status) {
  return String(status || "pending").replaceAll("_", "-");
}

function formatTime(value) {
  if (!value) return "Not provided by API";
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }) : "Not provided by API";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}
