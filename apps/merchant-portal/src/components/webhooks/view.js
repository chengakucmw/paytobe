export function renderWebhooks(state, canManage) {
  return `<section aria-labelledby="webhooks-title"><div class="section-heading"><div><h2 id="webhooks-title">Webhook endpoints</h2><p>Signed delivery configuration and tenant-scoped outcomes.</p></div>${canManage ? '<button type="button" id="show-create-webhook" class="secondary">Add endpoint</button>' : ""}</div>
    ${statusMessage(state)}${state.stepUpRequired ? stepUpPanel() : ""}${state.oneTimeSecret ? secretReceipt(state.oneTimeSecret) : ""}
    ${state.showCreate ? createForm(state.busy) : ""}
    <div class="endpoint-grid">${state.endpoints.map((endpoint) => endpointCard(endpoint, canManage, state.busy, state.ownershipChallenge)).join("") || '<p class="muted">No endpoints registered.</p>'}</div>
    ${deliveryTable(state.deliveries, canManage, state.busy)}
  </section>`;
}

function createForm(busy) {
  return `<form id="create-webhook-form" class="sub-form"><label for="webhook-url">HTTPS endpoint URL</label><input id="webhook-url" name="url" type="url" required placeholder="https://hooks.example.org/velarumpay">
    <label for="webhook-events">Event types (comma separated)</label><input id="webhook-events" name="event_types" required value="payment_request.status_updated">
    <button type="submit" ${busy ? "disabled" : ""}>Create endpoint</button></form>`;
}

function secretReceipt(receipt) {
  return `<section class="secret-receipt" role="alert" aria-labelledby="secret-title"><h3 id="secret-title">Save this signing Secret now</h3><p>It is shown once and cannot be retrieved later.</p><code>${escapeHtml(receipt.value)}</code><label class="check-row"><input id="secret-saved-confirmation" type="checkbox"> I saved this Secret in an approved secret manager.</label><button type="button" id="acknowledge-webhook-secret">Confirm saved and hide</button></section>`;
}

function endpointCard(endpoint, canManage, busy, challenge) {
  return `<article class="endpoint-card" data-endpoint-id="${escapeHtml(endpoint.webhook_endpoint_id)}"><div class="section-heading"><h3>${escapeHtml(endpoint.url)}</h3><span class="status-badge status-${escapeHtml(endpoint.status)}">${escapeHtml(endpoint.status)}</span></div><p>Events: ${endpoint.event_types.map(escapeHtml).join(", ")}</p><p>Secret overlap ends: ${formatTime(endpoint.secret_overlap_until)}</p>
    ${challenge?.endpointId === endpoint.webhook_endpoint_id ? `<div class="notice"><strong>Ownership challenge</strong><code>${escapeHtml(challenge.value)}</code></div>` : ""}
    ${canManage && endpoint.status === "pending_verification" ? `<button type="button" data-verify-endpoint ${busy ? "disabled" : ""}>Verify endpoint</button>` : ""}
    ${canManage && endpoint.status === "active" ? `<div class="row-actions"><button type="button" data-rotate-secret ${busy ? "disabled" : ""}>Rotate Secret</button><button type="button" class="danger" data-revoke-endpoint ${busy ? "disabled" : ""}>Revoke endpoint</button></div>` : ""}</article>`;
}

function deliveryTable(deliveries, canManage, busy) {
  return `<section aria-labelledby="deliveries-title"><h3 id="deliveries-title">Deliveries</h3><div class="table-scroll"><table><thead><tr><th>Event ID</th><th>Delivery ID</th><th>Status</th><th>Attempt</th><th>Next time</th><th>Safe error</th><th>Action</th></tr></thead><tbody>
    ${deliveries.length ? deliveries.map((delivery) => `<tr data-delivery-id="${escapeHtml(delivery.delivery_id)}"><td><code>${escapeHtml(delivery.event_id)}</code></td><td><code>${escapeHtml(delivery.delivery_id)}</code></td><td>${escapeHtml(delivery.status)}</td><td>${delivery.attempt}</td><td>${formatTime(delivery.next_attempt_at)}</td><td>${escapeHtml(delivery.failure_code || "None")}</td><td>${canManage && replayAllowed(delivery) ? `<button type="button" class="secondary" data-replay-delivery ${busy ? "disabled" : ""}>Replay</button>` : "—"}</td></tr>`).join("") : '<tr><td colspan="7">No deliveries returned.</td></tr>'}
  </tbody></table></div></section>`;
}

export function replayAllowed(delivery) {
  const status = Number(delivery.response_status || 0);
  if (delivery.status === "retryable_failed") return true;
  if (delivery.status !== "failed") return false;
  return status === 408 || status === 429 || status >= 500 || ["webhook_network_error", "retry_window_exhausted"].includes(delivery.failure_code);
}

function stepUpPanel() { return `<section class="notice"><h3>Recent authentication required</h3><button type="button" id="start-webhook-step-up" class="secondary">Send challenge</button><form id="complete-webhook-step-up-form" autocomplete="off"><label for="webhook-step-up-token">Challenge token</label><input id="webhook-step-up-token" name="challenge_token" type="password" required autocomplete="one-time-code"><button type="submit">Verify</button></form></section>`; }
function statusMessage(state) { return state.message ? `<div class="notice ${state.errorCode ? "notice-error" : ""}" role="status">${escapeHtml(state.message)}</div>` : ""; }
function formatTime(value) { if (!value) return "None scheduled"; const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }) : "Unavailable"; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
