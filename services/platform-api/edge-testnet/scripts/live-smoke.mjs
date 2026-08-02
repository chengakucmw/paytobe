const platform = String(process.argv[2] || "").replace(/\/+$/, "");
const agentFood = String(process.argv[3] || "").replace(/\/+$/, "");
if (!platform.startsWith("https://") || !agentFood.startsWith("https://")) {
  throw new Error("Usage: npm run smoke:live -- <platform-url> <agentfood-url>");
}

const suffix = crypto.randomUUID().replaceAll("-", "");
const device = { device_id: `live-smoke-${suffix}`, token: `awt_${suffix}` };

async function request(base, path, { method = "GET", token = "", payload } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(payload ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${JSON.stringify(result)}`);
  return result;
}

await request(platform, "/v1/devices/app", { method: "POST", payload: device });
const created = await request(platform, "/v1/connect-invitations", { method: "POST", payload: { ...device, expires_in_seconds: 300 } });
const claimed = await request(agentFood, "/api/chat", { method: "POST", payload: { message: created.connect_key } });
if (claimed.connect_invitation?.identity_assurance !== "registered" || claimed.connect_invitation?.agent_identity?.agent_name !== "AgentFood") {
  throw new Error("AgentFood identity was not sourced from the registered Platform client");
}
await request(platform, `/v1/pairing/sessions/${encodeURIComponent(claimed.pairing_session.pairing_session_id)}/approve`, {
  method: "POST",
  payload: { ...device, approved_scopes: claimed.connect_invitation.requested_scopes }
});
const exchanged = await request(agentFood, "/api/connect", {
  method: "POST",
  payload: { connect_invitation_id: claimed.connect_invitation.connect_invitation_id, claim_token: claimed.claim_token }
});
if (!exchanged.connection?.connection_token) throw new Error("AgentFood did not receive a scoped connection token");
const ordered = await request(agentFood, "/api/chat", {
  method: "POST",
  payload: { message: "vegetarian dinner under 15", connection_token: exchanged.connection.connection_token }
});
const inbox = await request(platform, `/v1/payment-requests?device_id=${encodeURIComponent(device.device_id)}&token=${encodeURIComponent(device.token)}`);
if (!inbox.items.some((item) => item.request_id === ordered.payment_request?.request_id)) throw new Error("Wallet inbox did not receive AgentFood's Payment Request");

console.log(JSON.stringify({
  ok: true,
  platform,
  agentfood: agentFood,
  identity_assurance: claimed.connect_invitation.identity_assurance,
  tenant_id: claimed.identity?.tenant_id,
  payment_network: ordered.payment_request.payment.network,
  wallet_inbox_items: inbox.items.length
}));
