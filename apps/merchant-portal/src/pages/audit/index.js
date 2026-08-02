export function renderMerchantAudit(events) {
  return `<section aria-labelledby="audit-title"><div class="section-heading"><div><h2 id="audit-title">Merchant audit</h2><p>Tenant-scoped security and control-plane decisions.</p></div></div>
    <div class="table-scroll"><table><thead><tr><th scope="col">Time</th><th scope="col">Action</th><th scope="col">Resource</th><th scope="col">Result</th><th scope="col">Actor</th></tr></thead><tbody>
      ${events.length ? events.map(row).join("") : '<tr><td colspan="5">No audit events returned.</td></tr>'}
    </tbody></table></div></section>`;
}

function row(event) {
  return `<tr><td>${escapeHtml(formatTime(event.occurred_at))}</td><td>${escapeHtml(event.action)}</td><td>${escapeHtml(`${event.resource?.type || "unknown"}:${event.resource?.id || ""}`)}</td><td>${escapeHtml(event.result)}</td><td>${escapeHtml(`${event.actor?.type || "unknown"}:${event.actor?.id || ""}`)}</td></tr>`;
}
function formatTime(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }) : "Unavailable"; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
