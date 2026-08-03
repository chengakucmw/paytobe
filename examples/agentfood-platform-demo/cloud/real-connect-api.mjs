const REAL_CONNECT_KEY_PATTERN = /^velarumpay-connect:ck_[A-Za-z0-9_-]{43}$/;
const REAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const REAL_ALLOWED_SCOPES = new Set([
  "payment.requests.create",
  "payment.requests.read",
  "transaction_contexts.create",
  "transaction_contexts.read",
  "wallet.addresses.read"
]);
const REAL_PAYMENT_TRANSITIONS = Object.freeze({
  pending: new Set(["signed", "broadcasted", "rejected", "expired", "failed"]),
  signed: new Set(["broadcasted", "failed"]),
  broadcasted: new Set(["confirmed", "failed"]),
  confirmed: new Set(),
  failed: new Set(),
  expired: new Set(),
  rejected: new Set()
});

function realJson(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders
    }
  });
}

function realApiError(status, code, message, details = undefined) {
  return realJson(status, { ok: false, error: { code, message, ...(details ? { details } : {}) } });
}

async function realBody(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 256 * 1024) throw Object.assign(new Error("Request body is too large"), { status: 413, code: "payload_too_large" });
  try { return await request.json(); }
  catch { throw Object.assign(new Error("Request body must be valid JSON"), { status: 400, code: "invalid_json" }); }
}

function realBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function realRandomToken(prefix) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}_${realBase64Url(bytes)}`;
}

function realId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function realHash(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function remotePlatformConfig(env) {
  const baseUrl = String(env?.VELARUMPAY_CONNECT_PLATFORM_URL || "").trim().replace(/\/+$/, "");
  const agentId = String(env?.AGENTFOOD_AGENT_ID || "agentfood-testnet").trim();
  const clientId = String(env?.AGENTFOOD_AGENT_CLIENT_ID || "agentfood-cloud-demo").trim();
  const kid = String(env?.AGENTFOOD_AGENT_CREDENTIAL_KID || "").trim();
  const privateKeyJwk = String(env?.AGENTFOOD_AGENT_CREDENTIAL_PRIVATE_KEY_JWK || "").trim();
  return baseUrl && agentId && clientId && kid && privateKeyJwk
    ? { baseUrl, agentId, clientId, kid, privateKeyJwk }
    : null;
}

async function remotePlatformRequest(config, path, { token = "", payload } = {}) {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(payload || {})
  });
  const result = await response.json().catch(() => ({ ok: false, error: { code: "invalid_platform_response", message: "VelarumPay Connect Platform returned an invalid response" } }));
  if (!response.ok) return { response: realJson(response.status, result) };
  return { result };
}

async function remoteAgentAccessToken(config) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", kid: config.kid, typ: "JWT" };
  const claims = {
    iss: config.agentId,
    sub: config.clientId,
    aud: "https://api.velarumai.com/v1/agent-auth/token",
    iat: now,
    exp: now + 300,
    jti: crypto.randomUUID(),
    scope: ["payment.requests.create", "payment.requests.read", "transaction_contexts.create", "transaction_contexts.read"]
  };
  let key;
  try {
    key = await crypto.subtle.importKey("jwk", JSON.parse(config.privateKeyJwk), { name: "Ed25519" }, false, ["sign"]);
  } catch {
    return { response: realApiError(503, "agent_signer_unavailable", "AgentFood Agent Assertion signer is unavailable") };
  }
  const signingInput = `${realBase64Url(new TextEncoder().encode(JSON.stringify(header)))}.${realBase64Url(new TextEncoder().encode(JSON.stringify(claims)))}`;
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(signingInput)));
  const exchanged = await remotePlatformRequest(config, "/v1/agent-auth/token", {
    payload: { client_assertion: `${signingInput}.${realBase64Url(signature)}` }
  });
  if (exchanged.response) return exchanged;
  const token = String(exchanged.result.access_token || "");
  return token ? { token } : { response: realApiError(502, "invalid_agent_token_response", "Platform returned an invalid Agent token response") };
}

function recordLegacyAgentFoodAttempt(env, {
  route,
  method = "POST",
  classification = "retired_hosted_write",
  disposition = "retired",
  responseStatus = 410
}) {
  const event = {
    level: "warn",
    event: "agentfood.legacy_path_attempt",
    schema_version: 1,
    surface: "agentfood_hosted_demo",
    classification,
    disposition,
    method,
    route,
    response_status: responseStatus,
    occurred_at: new Date().toISOString()
  };
  console.warn(JSON.stringify(event));
  try {
    env?.AGENTFOOD_LEGACY_METRICS?.writeDataPoint?.({
      indexes: [event.surface],
      blobs: [event.event, classification, disposition, method, route, String(responseStatus)],
      doubles: [1]
    });
  } catch {
    console.error(JSON.stringify({
      level: "error",
      event: "agentfood.legacy_metric_write_failed",
      surface: event.surface,
      classification,
      route,
      occurred_at: new Date().toISOString()
    }));
  }
}

function legacyWriteRetired(env, route, classification) {
  recordLegacyAgentFoodAttempt(env, { route, classification });
  return realApiError(410, "legacy_agentfood_path_retired", "This AgentFood path is retired; configure the standard Platform API and Agent Assertion signer");
}

function realInvitationView(invitation) {
  return {
    connect_invitation_id: invitation.connect_invitation_id,
    status: invitation.status,
    agent_identity: invitation.agent_identity || null,
    identity_assurance: invitation.identity_assurance || null,
    requested_scopes: invitation.requested_scopes || [],
    pairing_session_id: invitation.pairing_session_id || null,
    connection_id: invitation.connection_id || null,
    created_at: invitation.created_at,
    updated_at: invitation.updated_at,
    claimed_at: invitation.claimed_at || null,
    approved_at: invitation.approved_at || null,
    connected_at: invitation.connected_at || null,
    rejected_at: invitation.rejected_at || null,
    cancelled_at: invitation.cancelled_at || null,
    expired_at: invitation.expired_at || null,
    expires_at: invitation.expires_at
  };
}

function realPairingView(invitation) {
  return {
    pairing_session_id: invitation.pairing_session_id,
    pairing_code: "",
    pairing_uri: `velarumpay://pair?pairing_session_id=${encodeURIComponent(invitation.pairing_session_id)}`,
    agent_identity: invitation.agent_identity,
    identity_assurance: invitation.identity_assurance || "unverified",
    requested_scopes: invitation.requested_scopes || [],
    connect_invitation_id: invitation.connect_invitation_id,
    status: invitation.status === "claimed" ? "pending" : invitation.status,
    created_at: invitation.claimed_at || invitation.created_at,
    updated_at: invitation.updated_at,
    expires_at: invitation.expires_at
  };
}

function realConnectionView(connection, connectionToken = "") {
  return {
    connection_id: connection.connection_id,
    ...(connectionToken ? { connection_token: connectionToken } : {}),
    pairing_session_id: connection.pairing_session_id,
    scopes: connection.scopes,
    approved_scopes: connection.scopes,
    agent_identity: connection.agent_identity,
    status: connection.status,
    created_at: connection.created_at,
    updated_at: connection.updated_at,
    last_activity_at: connection.last_activity_at || connection.updated_at,
    expires_at: connection.expires_at
  };
}

function normalizeRealAgent(value) {
  const agentId = String(value?.agent_id || "").trim().slice(0, 160);
  const agentName = String(value?.agent_name || "").trim().slice(0, 160);
  const runtime = String(value?.runtime || "unknown").trim().slice(0, 80);
  const source = String(value?.source || "").trim().slice(0, 160);
  if (!agentId || !agentName) return null;
  return { agent_id: agentId, agent_name: agentName, runtime, source };
}

function normalizeRealScopes(value) {
  const requested = Array.isArray(value) ? value : ["payment.requests.create", "payment.requests.read"];
  const normalized = [...new Set(requested.map((scope) => String(scope).trim()).filter(Boolean))];
  if (!normalized.length || normalized.some((scope) => !REAL_ALLOWED_SCOPES.has(scope))) return null;
  return normalized;
}

async function verifyRealApp(store, deviceId, token) {
  if (!deviceId || !token) return false;
  return store.verifyDevice(String(deviceId), await realHash(String(token)));
}

function realBearer(request, fallback = "") {
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return (match?.[1] || request.headers.get("x-connect-claim-token") || fallback || "").trim();
}

async function realConnectionAuth(store, token, scope) {
  if (!token) return { error: realApiError(401, "unauthorized_connection", "Connection token is required") };
  const connection = await store.connectionByTokenHash(await realHash(token));
  if (!connection || connection.status !== "active") return { error: realApiError(401, "unauthorized_connection", "Connection token is invalid or inactive") };
  if (connection.expires_at && connection.expires_at <= new Date().toISOString()) return { error: realApiError(401, "unauthorized_connection", "Connection token expired") };
  if (!connection.scopes.includes(scope)) return { error: realApiError(403, "scope_denied", `Missing required scope: ${scope}`) };
  return { connection };
}

async function createRealInvitation(store, payload) {
  const deviceId = String(payload.device_id || "").trim();
  const token = String(payload.token || "").trim();
  if (!await verifyRealApp(store, deviceId, token)) return { response: realApiError(401, "invalid_app_device_token", "Invalid app device token") };
  const ttl = Number(payload.expires_in_seconds || 300);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 600) return { response: realApiError(400, "invalid_expiration", "expires_in_seconds must be between 60 and 600") };
  const connectKey = realRandomToken("ck");
  const at = new Date().toISOString();
  const invitation = await store.createInvitation({
    connect_invitation_id: realId("cinv"),
    connect_key_hash: await realHash(`velarumpay-connect:${connectKey}`),
    target_app_device_id: deviceId,
    created_at: at,
    updated_at: at,
    expires_at: new Date(Date.now() + ttl * 1000).toISOString()
  });
  return { connectKey: `velarumpay-connect:${connectKey}`, invitation };
}

async function claimRealInvitation(store, payload) {
  const connectKey = String(payload.connect_key || "").trim();
  if (!REAL_CONNECT_KEY_PATTERN.test(connectKey)) return { response: realApiError(409, "connect_key_unavailable", "Connect Key is invalid, expired, or already used") };
  const agent = normalizeRealAgent(payload.agent_identity || payload.agent);
  if (!agent) return { response: realApiError(400, "invalid_agent_identity", "agent_id and agent_name are required") };
  const scopes = normalizeRealScopes(payload.requested_scopes);
  if (!scopes) return { response: realApiError(400, "unsupported_scope", "One or more requested scopes are unsupported") };
  const claimToken = realRandomToken("claim_tok");
  const at = new Date().toISOString();
  const invitation = await store.claimInvitation(await realHash(connectKey), await realHash(claimToken), agent, scopes, realId("pair"), at);
  if (!invitation) return { response: realApiError(409, "connect_key_unavailable", "Connect Key is invalid, expired, or already used") };
  return { claimToken, invitation };
}

async function createRealHostedArtifacts(order, connection, origin) {
  const now = new Date();
  const createdAt = now.toISOString();
  const transactionId = `txn_${order.order_id}`;
  const quote = JSON.stringify({ merchant: order.merchant.id, items: order.items.map((item) => [item.id, item.quantity, item.price]), total: order.total, currency: order.currency });
  const evidenceHash = await realHash(quote);
  const source = { agent_id: "agentfood-cloud-demo", agent_name: "AgentFood Cloud Demo", runtime: "cloudflare-worker", channel: "demo_website" };
  const context = {
    protocol: "velarum.transaction_context.v1",
    transaction_id: transactionId,
    connection_id: connection.connection_id,
    created_at: createdAt,
    type: "generic",
    status: "awaiting_payment",
    title: `Demo order from ${order.merchant.name}`,
    summary: `AgentFood prepared a real wallet-bound testnet request totaling ${order.total} XLM.`,
    source,
    user_intent: { prompt_summary: order.prompt_summary },
    agent_activity: [
      { at: createdAt, action: "cart_built", label: "Built a demo cart", summary: `Selected ${order.items.length} menu item(s) within budget.`, source_type: "merchant_web_observed" },
      { at: createdAt, action: "payment_requested", label: "Created a Payment Request", summary: "Sent a testnet Payment Request to VelarumPay for user review.", source_type: "payment_request_fact" }
    ],
    items: [],
    costs: {},
    media: [],
    evidence: [{ evidence_id: `evidence_${order.order_id}`, type: "web_snapshot", title: "AgentFood hosted demo quote", source_url: `${origin}/merchants/${order.merchant.id}`, captured_at: createdAt, hash: evidenceHash }],
    provenance: { model: "truth_layer_v1" },
    truth_fields: [
      { field: "pricing.total", value: order.total, currency: order.currency, source_type: "merchant_web_observed", verification_status: "observed_only", evidence_ref: `evidence_${order.order_id}`, confidence: "medium", observed_at: createdAt }
    ],
    missing_context: ["recipient_facts_are_bound_by_platform"],
    risk_findings: [],
    metadata: {
      food_order: {
        order_id: order.order_id,
        merchant: { id: order.merchant.id, name: order.merchant.name },
        items: order.items.map((item) => ({ item_id: item.id, name: item.name, quantity: item.quantity, unit_amount: item.price, currency: order.currency })),
        quote: { total: order.total, currency: order.currency },
        demo: true
      }
    }
  };
  const paymentRequest = {
    recipient_id: "agentfood-reference-recipient",
    recipient_version_id: "agentfood-reference-recipient-v1",
    transaction_context_ref: { transaction_id: transactionId },
    expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    idempotency_key: `${order.order_id}-payment-1`,
    payment: { amount: order.total },
    display: { title: `Demo order from ${order.merchant.name}`, summary: "AgentFood sent this testnet request after a real Connect Key approval.", primary_action: "Review" },
    metadata: { environment: "hosted_reference_demo", demo: true, order_reference: order.order_id }
  };
  return { context, paymentRequest };
}

async function handleAgentFoodRealChat(request, store, url, env) {
  const payload = await realBody(request);
  const message = String(payload.message || "").trim().slice(0, 2_000);
  if (!message) return realApiError(400, "message_required", "A message is required");
  const connectKey = message.match(/velarumpay-connect:ck_[A-Za-z0-9_-]{43}/)?.[0];
  const remote = remotePlatformConfig(env);
  if (connectKey) {
    if (remote) {
      const agentToken = await remoteAgentAccessToken(remote);
      if (agentToken.response) return agentToken.response;
      const claimed = await remotePlatformRequest(remote, "/v1/connect-invitations/claim", {
        token: agentToken.token,
        payload: {
          connect_key: connectKey,
          requested_scopes: ["payment.requests.create", "payment.requests.read", "transaction_contexts.create", "transaction_contexts.read"]
        }
      });
      if (claimed.response) return claimed.response;
      return realJson(201, {
        ...claimed.result,
        connect_invitation_id: claimed.result.connect_invitation_id || claimed.result.connect_invitation?.connect_invitation_id,
        type: "connect_invitation_claimed",
        message: "Connect Key recognized and consumed. Review AgentFood's registered identity and requested scopes in VelarumPay, then approve or reject it."
      });
    }
    return legacyWriteRetired(env, "/api/chat", "standard_agent_config_missing_connect_claim");
  }

  const connectionToken = String(payload.connection_token || "");
  if (remote) {
    if (!connectionToken) return realApiError(409, "connection_required", "Approve the Connect Invitation in VelarumPay before requesting an order");
    const order = recommend(message, String(payload.preferred_merchant_id || ""));
    const artifacts = await createRealHostedArtifacts(order, { connection_id: "resolved-by-platform" }, url.origin);
    const contextResult = await remotePlatformRequest(remote, "/v1/transaction-contexts", { token: connectionToken, payload: artifacts.context });
    if (contextResult.response) return contextResult.response;
    const paymentResult = await remotePlatformRequest(remote, "/v1/payment-requests", { token: connectionToken, payload: artifacts.paymentRequest });
    if (paymentResult.response) return paymentResult.response;
    return realJson(201, {
      ok: true,
      type: "payment_request_created",
      message: `I prepared a ${order.total} XLM testnet order from ${order.merchant.name} and sent a Payment Request through the VelarumPay Connect Platform.`,
      order,
      transaction_context: contextResult.result.context,
      payment_request: paymentResult.result.payment_request,
      warnings: paymentResult.result.warnings || []
    });
  }
  return legacyWriteRetired(env, "/api/chat", "standard_agent_config_missing_payment_request");
}

async function handleRealConnectRoute(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const store = realConnectStore(env);
  const method = request.method.toUpperCase();

  if (method === "GET" && path === "/health") return realJson(200, { ok: true, service: "agentfood-real-connect", persistence: env?.DB ? "d1" : "memory" });
  if (method === "POST" && path === "/api/chat") return handleAgentFoodRealChat(request, store, url, env);
  if (method === "POST" && path === "/api/connect") {
    const payload = await realBody(request);
    const invitationId = String(payload.connect_invitation_id || "");
    const claimToken = String(payload.claim_token || "");
    if (!invitationId || !claimToken) return realApiError(401, "invalid_connect_claim_token", "Connect claim token is required");
    const remote = remotePlatformConfig(env);
    if (remote) {
      const exchanged = await remotePlatformRequest(remote, `/v1/connect-invitations/${encodeURIComponent(invitationId)}/exchange`, { token: claimToken, payload: {} });
      if (exchanged.response) {
        if (exchanged.response.status === 409) {
          const error = await exchanged.response.clone().json().catch(() => ({}));
          if (error?.error?.code === "connect_invitation_pending") return realJson(200, { ok: true, connection: { status: "claimed", connected: false, connect_invitation_id: invitationId } });
        }
        return exchanged.response;
      }
      return realJson(200, { ok: true, connection: { ...exchanged.result.connection, connected: true, connect_invitation_id: invitationId } });
    }
    return legacyWriteRetired(env, "/api/connect", "standard_agent_config_missing_connect_exchange");
  }

  if (path.startsWith("/v1/") && ["POST", "PATCH", "DELETE"].includes(method)) {
    recordLegacyAgentFoodAttempt(env, {
      route: "/v1/*",
      method,
      classification: "retired_direct_platform_write"
    });
    return realApiError(410, "legacy_agentfood_path_retired", "This AgentFood path is retired; configure the standard Platform API and Agent Assertion signer");
  }

  if (method === "POST" && path === "/v1/devices/app") {
    const payload = await realBody(request);
    const deviceId = String(payload.device_id || "").trim();
    const token = String(payload.token || "").trim();
    if (!deviceId || !REAL_TOKEN_PATTERN.test(token)) return realApiError(400, "invalid_app_device_registration", "device_id and a valid token are required");
    const device = await store.registerDevice(deviceId, await realHash(token), new Date().toISOString());
    if (device.conflict) return realApiError(409, "app_device_exists", "App device already registered with different credentials");
    return realJson(200, { ok: true, device });
  }

  if (method === "POST" && path === "/v1/connect-invitations") {
    const created = await createRealInvitation(store, await realBody(request));
    if (created.response) return created.response;
    return realJson(201, { ok: true, connect_key: created.connectKey, connect_invitation: realInvitationView(created.invitation) });
  }

  if (method === "POST" && path === "/v1/connect-invitations/claim") {
    const claimed = await claimRealInvitation(store, await realBody(request));
    if (claimed.response) return claimed.response;
    return realJson(201, { ok: true, claim_token: claimed.claimToken, connect_invitation: realInvitationView(claimed.invitation), pairing_session: realPairingView(claimed.invitation), warnings: [{ code: "agent_identity_unverified", message: "Agent identity is self-declared and must be reviewed in the wallet" }] });
  }

  const invitationMatch = path.match(/^\/v1\/connect-invitations\/([^/]+)$/);
  if (invitationMatch && method === "GET") {
    const id = decodeURIComponent(invitationMatch[1]);
    let invitation = await store.invitationById(id);
    if (!invitation) return realApiError(404, "connect_invitation_not_found", "Connect Invitation not found");
    const deviceId = url.searchParams.get("device_id") || "";
    const deviceToken = url.searchParams.get("token") || "";
    if (deviceId || deviceToken) {
      if (!await verifyRealApp(store, deviceId, deviceToken) || invitation.target_app_device_id !== deviceId) return realApiError(404, "connect_invitation_not_found", "Connect Invitation not found");
    } else {
      const claim = realBearer(request);
      if (!claim || invitation.claim_token_hash !== await realHash(claim)) return realApiError(404, "connect_invitation_not_found", "Connect Invitation not found");
    }
    invitation = await store.expireInvitation(invitation, new Date().toISOString());
    return realJson(200, { ok: true, connect_invitation: realInvitationView(invitation) });
  }

  if (invitationMatch && method === "DELETE") {
    const payload = await realBody(request);
    const id = decodeURIComponent(invitationMatch[1]);
    const invitation = await store.invitationById(id);
    if (!invitation || invitation.target_app_device_id !== String(payload.device_id || "") || !await verifyRealApp(store, payload.device_id, payload.token)) return realApiError(404, "connect_invitation_not_found", "Connect Invitation not found");
    const cancelled = await store.cancelInvitation(id, invitation.target_app_device_id, new Date().toISOString());
    if (!cancelled) return realApiError(409, "connect_invitation_not_cancellable", "Connect Invitation can no longer be cancelled");
    return realJson(200, { ok: true, connect_invitation: realInvitationView(cancelled) });
  }

  const exchangeMatch = path.match(/^\/v1\/connect-invitations\/([^/]+)\/exchange$/);
  if (exchangeMatch && method === "POST") {
    const id = decodeURIComponent(exchangeMatch[1]);
    const claimToken = realBearer(request);
    let invitation = claimToken ? await store.invitationByClaimHash(await realHash(claimToken)) : null;
    if (!invitation || invitation.connect_invitation_id !== id) return realApiError(401, "invalid_connect_claim_token", "Connect claim token is invalid");
    invitation = await store.expireInvitation(invitation, new Date().toISOString());
    if (invitation.status === "claimed") return realApiError(409, "connect_invitation_pending", "Connect Invitation is awaiting wallet approval");
    if (invitation.status === "expired") return realApiError(410, "connect_invitation_expired", "Connect Invitation expired");
    if (["rejected", "cancelled"].includes(invitation.status)) return realApiError(409, "connect_invitation_not_approved", "Connect Invitation was not approved", { status: invitation.status });
    const connectionToken = realRandomToken("conn_tok");
    const exchanged = await store.exchangeInvitation(invitation, await realHash(connectionToken), new Date().toISOString());
    if (!exchanged) return realApiError(409, "connect_invitation_not_exchangeable", "Connect Invitation cannot be exchanged");
    return realJson(200, { ok: true, connect_invitation: realInvitationView(exchanged.invitation), connection: realConnectionView(exchanged.connection, connectionToken) });
  }

  const pairingMatch = path.match(/^\/v1\/pairing\/sessions\/([^/]+)$/);
  if (pairingMatch && method === "GET") {
    let invitation = await store.invitationByPairingId(decodeURIComponent(pairingMatch[1]));
    if (!invitation) return realApiError(404, "pairing_session_not_found", "Pairing session not found");
    invitation = await store.expireInvitation(invitation, new Date().toISOString());
    return realJson(200, { ok: true, pairing_session: realPairingView(invitation) });
  }

  const pairingAction = path.match(/^\/v1\/pairing\/sessions\/([^/]+)\/(approve|reject)$/);
  if (pairingAction && method === "POST") {
    const payload = await realBody(request);
    const invitation = await store.invitationByPairingId(decodeURIComponent(pairingAction[1]));
    if (!invitation || invitation.target_app_device_id !== String(payload.device_id || "") || !await verifyRealApp(store, payload.device_id, payload.token)) return realApiError(403, "pairing_target_mismatch", "Pairing session belongs to another wallet");
    if (invitation.status !== "claimed") return realApiError(409, "pairing_session_closed", "Pairing session is no longer pending");
    const at = new Date().toISOString();
    if (pairingAction[2] === "reject") {
      const rejected = await store.rejectInvitation(invitation, at);
      return realJson(200, { ok: true, pairing_session: realPairingView(rejected) });
    }
    const approvedScopes = normalizeRealScopes(payload.approved_scopes);
    if (!approvedScopes || approvedScopes.some((scope) => !invitation.requested_scopes.includes(scope))) return realApiError(400, "invalid_approved_scopes", "Approved scopes must be a non-empty subset of requested scopes");
    const approved = await store.approveInvitation(invitation, approvedScopes, realId("conn"), at, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());
    if (!approved) return realApiError(409, "pairing_session_closed", "Pairing session is no longer pending");
    return realJson(201, { ok: true, pairing_session: realPairingView(approved.invitation), connection: realConnectionView(approved.connection) });
  }

  if (method === "GET" && path === "/v1/connections") {
    const deviceId = url.searchParams.get("device_id") || "";
    const token = url.searchParams.get("token") || "";
    if (!await verifyRealApp(store, deviceId, token)) return realApiError(401, "invalid_app_device_token", "Invalid app device token");
    return realJson(200, { ok: true, items: (await store.listConnections(deviceId)).map((item) => realConnectionView(item)) });
  }

  const connectionMatch = path.match(/^\/v1\/connections\/([^/]+)$/);
  if (connectionMatch && ["PATCH", "DELETE"].includes(method)) {
    const payload = await realBody(request);
    const deviceId = String(payload.device_id || "");
    if (!await verifyRealApp(store, deviceId, payload.token)) return realApiError(401, "invalid_app_device_token", "Invalid app device token");
    const status = method === "DELETE" ? "revoked" : String(payload.status || "");
    if (!["active", "paused", "revoked"].includes(status)) return realApiError(400, "invalid_connection_status", "Connection status must be active or paused");
    const connection = await store.updateConnection(decodeURIComponent(connectionMatch[1]), deviceId, status, new Date().toISOString());
    if (!connection) return realApiError(404, "connection_not_found", "Connection not found");
    return realJson(200, { ok: true, connection: realConnectionView(connection) });
  }

  if (method === "POST" && path === "/v1/transaction-contexts") {
    const payload = await realBody(request);
    const auth = await realConnectionAuth(store, realBearer(request, payload.connection_token), "transaction_contexts.create");
    if (auth.error) return auth.error;
    if (payload.protocol !== "velarum.transaction_context.v1" || !payload.transaction_id) return realApiError(400, "invalid_transaction_context", "A valid velarum.transaction_context.v1 payload is required");
    if (payload.connection_id && payload.connection_id !== auth.connection.connection_id) return realApiError(401, "unauthorized_connection", "connection_id does not match the connection token");
    payload.connection_id = auth.connection.connection_id;
    return realJson(201, { ok: true, context: await store.upsertContext(auth.connection.connection_id, payload, new Date().toISOString()) });
  }

  if (method === "POST" && path === "/v1/payment-requests") {
    const payload = await realBody(request);
    const auth = await realConnectionAuth(store, realBearer(request, payload.connection_token), "payment.requests.create");
    if (auth.error) return auth.error;
    if (payload.protocol !== "velarum.payment_request.v1" || !payload.request_id || payload.policy?.requires_user_approval !== true) return realApiError(400, "invalid_payment_request", "A valid user-approved velarum.payment_request.v1 payload is required");
    payload.connection_id = auth.connection.connection_id;
    const payment = await store.createPayment(auth.connection, payload, new Date().toISOString());
    return realJson(201, { ok: true, payment_request: payment, warnings: payment.risk?.warnings || [] });
  }

  if (method === "GET" && path === "/v1/payment-requests") {
    const deviceId = url.searchParams.get("device_id") || "";
    const token = url.searchParams.get("token") || "";
    if (!await verifyRealApp(store, deviceId, token)) return realApiError(401, "invalid_app_device_token", "Invalid app device token");
    return realJson(200, { ok: true, items: await store.listPayments(deviceId) });
  }

  const paymentStatusMatch = path.match(/^\/v1\/payment-requests\/([^/]+)\/status$/);
  if (paymentStatusMatch && method === "POST") {
    const payload = await realBody(request);
    const deviceId = String(payload.device_id || "");
    if (!await verifyRealApp(store, deviceId, payload.token)) return realApiError(401, "invalid_app_device_token", "Invalid app device token");
    const id = decodeURIComponent(paymentStatusMatch[1]);
    const current = await store.paymentById(id);
    if (!current || current.target_app_device_id !== deviceId) return realApiError(404, "payment_request_not_found", "Payment Request not found");
    const nextStatus = String(payload.status || "").toLowerCase();
    const currentStatus = String(current.payload.status || "pending").toLowerCase();
    if (!REAL_PAYMENT_TRANSITIONS[currentStatus]?.has(nextStatus)) return realApiError(409, "invalid_status_transition", `Cannot move Payment Request from ${currentStatus} to ${nextStatus}`);
    const payment = await store.updatePayment(id, deviceId, nextStatus, { ...(payload.tx_hash ? { tx_hash: String(payload.tx_hash) } : {}), ...(payload.error ? { error: String(payload.error) } : {}) }, new Date().toISOString());
    return realJson(200, { ok: true, payment_request: payment });
  }

  const paymentMatch = path.match(/^\/v1\/payment-requests\/([^/]+)$/);
  if (paymentMatch && method === "GET") {
    const deviceId = url.searchParams.get("device_id") || "";
    const token = url.searchParams.get("token") || "";
    if (!await verifyRealApp(store, deviceId, token)) return realApiError(401, "invalid_app_device_token", "Invalid app device token");
    const payment = await store.paymentById(decodeURIComponent(paymentMatch[1]));
    if (!payment || payment.target_app_device_id !== deviceId) return realApiError(404, "payment_request_not_found", "Payment Request not found");
    return realJson(200, { ok: true, payment_request: payment.payload });
  }

  return null;
}
