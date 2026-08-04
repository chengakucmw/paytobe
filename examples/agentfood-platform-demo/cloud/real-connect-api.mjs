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

async function realHash(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function remotePlatformConfig(env) {
  const baseUrl = String(env?.VELARUMPAY_CONNECT_PLATFORM_URL || "").trim().replace(/\/+$/, "");
  const agentId = String(env?.AGENTFOOD_AGENT_ID || "agentfood-testnet").trim();
  const clientId = String(env?.AGENTFOOD_AGENT_CLIENT_ID || "agentfood-cloud-demo").trim();
  const kid = String(env?.AGENTFOOD_AGENT_CREDENTIAL_KID || "").trim();
  const privateKeyJwk = String(env?.AGENTFOOD_AGENT_CREDENTIAL_PRIVATE_KEY_JWK || "").trim();
  const recipientId = String(env?.AGENTFOOD_RECIPIENT_ID || "").trim();
  const recipientVersionId = String(env?.AGENTFOOD_RECIPIENT_VERSION_ID || "").trim();
  return baseUrl && agentId && clientId && kid && privateKeyJwk && recipientId && recipientVersionId
    ? { baseUrl, agentId, clientId, kid, privateKeyJwk, recipientId, recipientVersionId }
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
  return response.ok ? { result } : { response: realJson(response.status, result) };
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

async function createRealHostedArtifacts(order, origin, config) {
  const now = new Date();
  const createdAt = now.toISOString();
  const transactionId = `txn_${order.order_id}`;
  const quote = JSON.stringify({ merchant: order.merchant.id, items: order.items.map((item) => [item.id, item.quantity, item.price]), total: order.total, currency: order.currency });
  const evidenceHash = await realHash(quote);
  const source = { agent_id: "agentfood-cloud-demo", agent_name: "AgentFood Cloud Demo", runtime: "cloudflare-worker", channel: "demo_website" };
  const foodOrder = {
    order_id: order.order_id,
    merchant: { id: order.merchant.id, name: order.merchant.name },
    items: order.items.map((item) => ({ item_id: item.id, name: item.name, quantity: item.quantity, unit_amount: item.price, currency: order.currency })),
    quote: { total: order.total, currency: order.currency },
    demo: true
  };
  return {
    context: {
      protocol: "velarum.transaction_context.v1",
      transaction_id: transactionId,
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
      items: [], costs: {}, media: [],
      evidence: [{ evidence_id: `evidence_${order.order_id}`, type: "web_snapshot", title: "AgentFood hosted demo quote", source_url: `${origin}/merchants/${order.merchant.id}`, captured_at: createdAt, hash: evidenceHash }],
      provenance: { model: "truth_layer_v1" },
      truth_fields: [{ field: "pricing.total", value: order.total, currency: order.currency, source_type: "merchant_web_observed", verification_status: "observed_only", evidence_ref: `evidence_${order.order_id}`, confidence: "medium", observed_at: createdAt }],
      missing_context: ["recipient_facts_are_bound_by_platform"],
      risk_findings: [],
      metadata: { food_order: foodOrder }
    },
    paymentRequest: {
      recipient_id: config.recipientId,
      recipient_version_id: config.recipientVersionId,
      transaction_context_ref: { transaction_id: transactionId },
      expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      idempotency_key: `${order.order_id}-payment-1`,
      payment: { amount: order.total },
      display: { title: `Demo order from ${order.merchant.name}`, summary: "AgentFood sent this testnet request after a real Connect Key approval.", primary_action: "Review" },
      metadata: { environment: "hosted_reference_demo", demo: true, order_reference: order.order_id }
    }
  };
}

async function handleAgentFoodRealChat(request, url, env) {
  const payload = await realBody(request);
  const message = String(payload.message || "").trim().slice(0, 2_000);
  if (!message) return realApiError(400, "message_required", "A message is required");
  const remote = remotePlatformConfig(env);
  if (!remote) return realApiError(503, "agent_platform_unavailable", "AgentFood standard Platform configuration is unavailable");
  const connectKey = message.match(/velarumpay-connect:ck_[A-Za-z0-9_-]{43}/)?.[0];
  if (connectKey) {
    const agentToken = await remoteAgentAccessToken(remote);
    if (agentToken.response) return agentToken.response;
    const claimed = await remotePlatformRequest(remote, "/v1/connect-invitations/claim", {
      token: agentToken.token,
      payload: { connect_key: connectKey, requested_scopes: ["payment.requests.create", "payment.requests.read", "transaction_contexts.create", "transaction_contexts.read"] }
    });
    if (claimed.response) return claimed.response;
    return realJson(201, {
      ...claimed.result,
      connect_invitation_id: claimed.result.connect_invitation_id || claimed.result.connect_invitation?.connect_invitation_id,
      type: "connect_invitation_claimed",
      message: "Connect Key recognized and consumed. Review AgentFood's registered identity and requested scopes in VelarumPay, then approve or reject it."
    });
  }
  const connectionToken = String(payload.connection_token || "");
  if (!connectionToken) return realApiError(409, "connection_required", "Approve the Connect Invitation in VelarumPay before requesting an order");
  const order = recommend(message, String(payload.preferred_merchant_id || ""));
  const artifacts = await createRealHostedArtifacts(order, url.origin, remote);
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

async function handleRealConnectRoute(request, env) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (method === "GET" && url.pathname === "/health") {
    return realJson(200, { ok: true, service: "agentfood-real-connect", persistence: "platform_api", platform_configured: Boolean(remotePlatformConfig(env)) });
  }
  if (method === "POST" && url.pathname === "/api/chat") return handleAgentFoodRealChat(request, url, env);
  if (method === "POST" && url.pathname === "/api/connect") {
    const remote = remotePlatformConfig(env);
    if (!remote) return realApiError(503, "agent_platform_unavailable", "AgentFood standard Platform configuration is unavailable");
    const payload = await realBody(request);
    const invitationId = String(payload.connect_invitation_id || "");
    const claimToken = String(payload.claim_token || "");
    if (!invitationId || !claimToken) return realApiError(401, "invalid_connect_claim_token", "Connect claim token is required");
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
  return null;
}
