import cors from "cors";
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { id, verifyHmac } from "./crypto.js";
import { Store } from "./store.js";
import {
  adaptVelarum,
  createTransactionContextSnapshot,
  normalizePaymentRequestV1,
  normalizeTransactionContextV1
} from "./velarum.js";
import { canTransition, evaluateIntent, evaluatePaymentRequest, shouldRecordSpent } from "./risk.js";
import { maybeFundDemoAccount } from "./stellar_funding.js";

const PORT = Number(process.env.PORT || 8787);
const DEFAULT_PAIRING_TTL_SECONDS = 5 * 60;
const MIN_PAIRING_TTL_SECONDS = 60;
const MAX_PAIRING_TTL_SECONDS = 10 * 60;
const DEFAULT_CONNECTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_PAYMENT_REQUEST_TTL_MS = 5 * 60 * 1000;
const PAYMENT_REQUEST_STATUS_UPDATES = new Set([
  "signed",
  "broadcasted",
  "confirmed",
  "failed",
  "expired",
  "rejected"
]);
const TERMINAL_PAYMENT_REQUEST_STATUSES = new Set([
  "confirmed",
  "expired",
  "rejected"
]);
const FINAL_PAYMENT_REQUEST_REVIEW_STATES = new Set([
  "confirmed",
  "expired",
  "rejected",
  "cancelled"
]);
const ATTENTION_PAYMENT_REQUEST_REVIEW_STATES = new Set([
  "missing_context",
  "blocked",
  "needs_review",
  "source_review_required",
  "network_disabled",
  "broadcasting",
  "failed"
]);
const ALLOWED_PAIRING_SCOPES = new Set([
  "payment.requests.create",
  "payment.requests.read",
  "transaction_contexts.create",
  "transaction_contexts.read",
  "wallet.addresses.read"
]);
const DEFAULT_PAIRING_SCOPES = [
  "payment.requests.create",
  "payment.requests.read"
];
const store = new Store();
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const appSockets = new Map();
const openclawSockets = new Map();

app.use(cors());
app.use(express.json({
  limit: "256kb",
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString("utf8");
  }
}));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "agentwallet-relay", time: new Date().toISOString() });
});

app.post("/v1/devices/app", (req, res) => {
  const { device_id, token } = req.body || {};
  if (!device_id || !token) return res.status(400).json({ error: "device_id and token are required" });
  const device = store.registerDevice(device_id, token);
  res.json({ ok: true, device });
});

app.post("/v1/demo/sessions", async (req, res) => {
  const auth = verifyAppBody(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  let session = store.createDemoSession(id("demo"), req.body.device_id, {
    label: req.body.label || "AgentWallet Cafe Demo",
    telegram_bot: req.body.telegram_bot || "",
    stellar_address: req.body.stellar_address || "",
    evm_address: req.body.evm_address || ""
  });
  const funding = await maybeFundDemoAccount(session);
  session = store.updateDemoSession(session.session_id, { funding }) || session;
  res.status(201).json({ ok: true, session });
});

app.get("/v1/demo/overview", (_req, res) => {
  res.json({
    ok: true,
    sessions: store.listDemoSessions(),
    telegram_bindings: store.listTelegramBindings(),
    live_app_devices: liveSocketSummary(appSockets),
    live_openclaw_devices: liveSocketSummary(openclawSockets)
  });
});

app.post("/v1/demo/sessions/:id/telegram", (req, res) => {
  const chatHash = String(req.body?.chat_hash || "");
  if (!chatHash.startsWith("sha256:")) return res.status(400).json({ error: "chat_hash is required" });
  const binding = store.bindTelegramChat(req.params.id, chatHash, {
    telegram_user: req.body.telegram_user || "",
    telegram_name: req.body.telegram_name || ""
  });
  if (!binding) return res.status(404).json({ error: "Demo session not found" });
  res.json({ ok: true, binding });
});

app.post("/v1/transaction-contexts", (req, res) => {
  const auth = authorizeConnection(req, "transaction_contexts.create", { allowLegacyOpenClaw: true });
  if (!auth.ok) return sendAuthFailure(res, auth);

  const normalized = normalizeTransactionContextV1(buildTransactionContextPayload(req.body || {}, auth.connection));
  if (!normalized.ok) {
    return res.status(400).json({
      ok: false,
      error: normalized.error,
      errors: normalized.errors
    });
  }

  const context = store.putTransactionContext(normalized.value);
  if (auth.connection) store.touchConnection(auth.connection.connection_id);
  res.status(201).json({
    ok: true,
    context,
    warnings: normalized.warnings
  });
});

app.get("/v1/transaction-contexts/:transaction_id", (req, res) => {
  const context = store.transactionContext(req.params.transaction_id);
  if (!context) return res.status(404).json({ ok: false, error: "Transaction Context not found" });

  if (req.query.device_id || req.query.token) {
    const walletAuth = verifyAppQuery(req);
    if (!walletAuth.ok) return res.status(walletAuth.status).json({ ok: false, error: walletAuth.error });
    return res.json({ ok: true, context });
  }

  const auth = authorizeConnection(req, "transaction_contexts.read", { allowLegacyOpenClaw: true });
  if (!auth.ok) return sendAuthFailure(res, auth);
  if (auth.connection && context.connection_id !== auth.connection.connection_id) {
    return sendApiError(res, 403, "scope_denied", "Connection cannot read this Transaction Context");
  }
  if (auth.connection) store.touchConnection(auth.connection.connection_id);
  res.json({ ok: true, context });
});

app.post("/v1/pairing/sessions", (req, res) => {
  const body = req.body || {};
  const agent = normalizeAgentIdentity(body.agent_identity || body.agent || {});
  if (!agent.ok) {
    return sendApiError(res, 400, "invalid_agent_identity", agent.error, { field: agent.field });
  }

  const scopes = normalizeRequestedScopes(body.requested_scopes);
  if (!scopes.ok) {
    return sendApiError(res, 400, scopes.code, scopes.error, { field: "requested_scopes" });
  }

  const ttl = normalizePairingTtl(body.expires_in_seconds);
  if (!ttl.ok) {
    return sendApiError(res, 400, "invalid_expiration", ttl.error, { field: "expires_in_seconds" });
  }

  const pairingSessionId = id("pair");
  const pairingCode = uniquePairingCode();
  const expiresAt = new Date(Date.now() + ttl.seconds * 1000).toISOString();
  const pairingUri = `velarumpay://pair?session=${encodeURIComponent(pairingSessionId)}&code=${encodeURIComponent(pairingCode)}`;
  const session = store.createPairingSession(pairingSessionId, pairingCode, {
    pairing_uri: pairingUri,
    agent_identity: agent.value,
    requested_scopes: scopes.value,
    expires_at: expiresAt
  });

  res.status(201).json({
    ok: true,
    pairing_session: session,
    warnings: scopes.warnings
  });
});

app.get("/v1/pairing/sessions/:id", (req, res) => {
  store.expirePairingSessions();
  const session = resolvePairingSession(req.params.id, { pairing_code: req.query.code });
  if (!session) return sendApiError(res, 404, "pairing_session_not_found", "Pairing session not found");
  res.json({
    ok: true,
    pairing_session: pairingSessionResponse(session)
  });
});

app.post("/v1/pairing/sessions/:id/approve", (req, res) => {
  store.expirePairingSessions();
  const walletAuth = verifyAppBody(req);
  if (!walletAuth.ok) {
    return sendApiError(res, walletAuth.status, "invalid_app_device_token", walletAuth.error);
  }

  const session = resolvePairingSession(req.params.id, req.body || {});
  if (!session) return sendApiError(res, 404, "pairing_session_not_found", "Pairing session not found");
  if (session.status !== "pending") {
    if (session.status === "expired") return sendApiError(res, 410, "pairing_session_expired", "Pairing session expired");
    return sendApiError(res, 409, "pairing_session_not_pending", "Pairing session is not pending", {
      details: { status: session.status }
    });
  }
  if (store.isPairingSessionExpired(session)) {
    store.updatePairingSession(session.pairing_session_id, { status: "expired" });
    return sendApiError(res, 410, "pairing_session_expired", "Pairing session expired");
  }

  const scopes = normalizeApprovedScopes(req.body?.approved_scopes, session.requested_scopes);
  if (!scopes.ok) {
    return sendApiError(res, scopes.status || 400, scopes.code, scopes.error, { field: "approved_scopes" });
  }

  const connection = store.createConnection(id("conn"), id("conn_tok"), {
    pairing_session_id: session.pairing_session_id,
    agent_identity: session.agent_identity,
    scopes: scopes.value,
    approved_by_device_id: req.body.device_id,
    expires_at: new Date(Date.now() + DEFAULT_CONNECTION_TTL_MS).toISOString()
  });
  store.updatePairingSession(session.pairing_session_id, {
    status: "approved",
    approved_at: new Date().toISOString(),
    approved_scopes: scopes.value,
    connection_id: connection.connection_id
  });

  res.status(201).json({
    ok: true,
    connection: connectionResponse(connection),
    pairing_session: store.pairingSession(session.pairing_session_id)
  });
});

app.post("/v1/pairing/sessions/:id/reject", (req, res) => {
  store.expirePairingSessions();
  const walletAuth = verifyAppBody(req);
  if (!walletAuth.ok) {
    return sendApiError(res, walletAuth.status, "invalid_app_device_token", walletAuth.error);
  }

  const session = resolvePairingSession(req.params.id, req.body || {});
  if (!session) return sendApiError(res, 404, "pairing_session_not_found", "Pairing session not found");
  if (session.status !== "pending") {
    if (session.status === "expired") return sendApiError(res, 410, "pairing_session_expired", "Pairing session expired");
    return sendApiError(res, 409, "pairing_session_not_pending", "Pairing session is not pending", {
      details: { status: session.status }
    });
  }
  if (store.isPairingSessionExpired(session)) {
    store.updatePairingSession(session.pairing_session_id, { status: "expired" });
    return sendApiError(res, 410, "pairing_session_expired", "Pairing session expired");
  }

  const updated = store.updatePairingSession(session.pairing_session_id, {
    status: "rejected",
    rejected_at: new Date().toISOString(),
    rejected_by_device_id: req.body.device_id
  });
  res.json({ ok: true, pairing_session: updated });
});

app.get("/v1/connections", (req, res) => {
  const auth = verifyAppQuery(req);
  if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
  res.json({
    ok: true,
    items: store.listConnectionsForDevice(req.query.device_id).map(connectionPublicResponse)
  });
});

app.patch("/v1/connections/:id", (req, res) => {
  const auth = verifyAppBody(req);
  if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
  const connection = store.connection(req.params.id);
  if (!connection || connection.approved_by_device_id !== req.body.device_id) {
    return sendApiError(res, 404, "connection_not_found", "Connection not found");
  }
  const status = String(req.body.status || "").trim().toLowerCase();
  if (!["active", "paused"].includes(status)) {
    return sendApiError(res, 400, "invalid_connection_status", "Connection status must be active or paused", {
      field: "status"
    });
  }
  if (connection.status === "revoked") {
    return sendApiError(res, 409, "connection_revoked", "Revoked connections cannot be reactivated");
  }
  const updated = store.updateConnectionStatus(connection.connection_id, status);
  res.json({ ok: true, connection: connectionPublicResponse(updated) });
});

app.delete("/v1/connections/:id", (req, res) => {
  const body = req.body || {};
  const auth = verifyAppBody({ body });
  if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
  const connection = store.connection(req.params.id);
  if (!connection || connection.approved_by_device_id !== body.device_id) {
    return sendApiError(res, 404, "connection_not_found", "Connection not found");
  }
  const revokedAt = new Date().toISOString();
  const updated = store.updateConnectionStatus(connection.connection_id, "revoked", {
    revoked_at: revokedAt,
    revoked_by_device_id: body.device_id
  });
  notifyOpenClaw(updated.connection_id, {
    type: "connection.revoked",
    connection_id: updated.connection_id,
    status: updated.status,
    revoked_at: revokedAt
  });
  res.json({ ok: true, connection: connectionPublicResponse(updated) });
});

app.get("/v1/demo/telegram-bindings/:chatHash", (req, res) => {
  const binding = store.telegramBinding(req.params.chatHash);
  if (!binding) return res.status(404).json({ ok: false, error: "Telegram chat is not bound" });
  res.json({ ok: true, binding });
});

app.post("/v1/payment-requests", (req, res) => {
  const auth = authorizeConnection(req, "payment.requests.create", { allowLegacyOpenClaw: true });
  if (!auth.ok) return sendAuthFailure(res, auth);

  const body = req.body || {};
  const idempotencyKey = req.get("x-idempotency-key") || body.idempotency_key || "";
  if (idempotencyKey) {
    const existing = store.findPaymentRequestByIdempotency(idempotencyKey, auth.connection?.connection_id || body.connection_id || "");
    if (existing) return res.status(200).json({ ok: true, duplicate: true, payment_request: paymentRequestProjection(existing) });
  }

  const target = body.target_app_device_id || process.env.DEFAULT_APP_DEVICE_ID || store.firstDeviceId();
  if (!target) return sendApiError(res, 400, "target_device_required", "No target app device is registered");

  const payload = buildPaymentRequestPayload(body, auth.connection, idempotencyKey);
  const normalized = normalizePaymentRequestV1(payload);
  if (!normalized.ok) {
    return res.status(400).json({
      ok: false,
      error: normalized.error,
      errors: normalized.errors,
      warnings: normalized.warnings
    });
  }

  const context = buildTransactionContextProjection(normalized.value);
  const risk = evaluatePaymentRequest(normalized.value, context);
  const warnings = [...(normalized.warnings || []), ...context.warnings, ...risk.warnings];
  const request = store.putPaymentRequest({
    ...normalized.value,
    target_app_device_id: target,
    transaction_context_ref: context.ref,
    transaction_context_snapshot: context.snapshot || normalized.value.transaction_context_snapshot,
    risk,
    warnings
  });
  if (auth.connection) store.touchConnection(auth.connection.connection_id);
  notifyApp(target, { type: "payment_request", request_id: request.request_id, status: request.status });
  res.status(201).json({
    ok: true,
    payment_request: paymentRequestProjection(request),
    warnings
  });
});

app.get("/v1/payment-requests", (req, res) => {
  store.expireStale();
  if (req.query.device_id || req.query.token) {
    const auth = verifyAppQuery(req);
    if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
    return res.json({
      ok: true,
      items: store.listPaymentRequestsForDevice(req.query.device_id).map(paymentRequestProjection)
    });
  }

  const auth = authorizeConnection(req, "payment.requests.read");
  if (!auth.ok) return sendAuthFailure(res, auth);
  store.touchConnection(auth.connection.connection_id);
  res.json({
    ok: true,
    items: store.listPaymentRequestsForConnection(auth.connection.connection_id).map(paymentRequestProjection)
  });
});

app.get("/v1/payment-requests/events", (req, res) => {
  const auth = authorizeConnection(req, "payment.requests.read");
  if (!auth.ok) return sendAuthFailure(res, auth);
  const since = Number(req.query.since || 0);
  store.touchConnection(auth.connection.connection_id);
  res.json({
    ok: true,
    items: store
      .paymentRequestEventsForConnection(auth.connection.connection_id, Number.isFinite(since) ? since : 0)
      .map(paymentRequestEventProjection)
  });
});

app.get("/v1/payment-requests/:id", (req, res) => {
  store.expireStale();
  const request = store.paymentRequest(req.params.id);
  if (req.query.device_id || req.query.token) {
    const auth = verifyAppQuery(req);
    if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
    if (!request || request.target_app_device_id !== req.query.device_id) {
      return sendApiError(res, 404, "payment_request_not_found", "Payment Request not found");
    }
    return res.json({ ok: true, payment_request: paymentRequestProjection(request) });
  }

  const auth = authorizeConnection(req, "payment.requests.read");
  if (!auth.ok) return sendAuthFailure(res, auth);
  if (!request) return sendApiError(res, 404, "payment_request_not_found", "Payment Request not found");
  if (request.connection_id !== auth.connection.connection_id) {
    return sendApiError(res, 403, "scope_denied", "Connection cannot read this Payment Request");
  }
  store.touchConnection(auth.connection.connection_id);
  res.json({ ok: true, payment_request: paymentRequestProjection(request) });
});

app.post("/v1/payment-requests/:id/status", (req, res) => {
  const auth = verifyAppBody(req);
  if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);

  const request = store.paymentRequest(req.params.id);
  if (!request || request.target_app_device_id !== req.body.device_id) {
    return sendApiError(res, 404, "payment_request_not_found", "Payment Request not found");
  }

  const status = String(req.body.status || "");
  if (!PAYMENT_REQUEST_STATUS_UPDATES.has(status) || !canTransition(status)) {
    return sendApiError(res, 400, "invalid_status", "Payment Request status is not supported", {
      field: "status",
      details: {
        status,
        allowed_statuses: Array.from(PAYMENT_REQUEST_STATUS_UPDATES)
      }
    });
  }

  const transition = validatePaymentRequestStatusUpdate(request, status);
  if (!transition.ok) {
    return sendApiError(res, transition.status, transition.code, transition.message, {
      details: transition.details
    });
  }

  const updated = store.updatePaymentRequestStatus(request.request_id, status, {
    tx_hash: req.body.tx_hash || null,
    error: req.body.error || null
  });
  if (shouldRecordSpent(status)) store.addDailySpent(updated.payment.asset, updated.payment.amount);

  const message = paymentRequestStatusMessage(updated, {
    tx_hash: req.body.tx_hash || null,
    error: req.body.error || null
  });
  notifyOpenClaw(updated.connection_id || updated.source?.device_id || "default", message);
  notifyApp(updated.target_app_device_id, {
    type: "payment_request",
    request_id: updated.request_id,
    status: updated.status
  });

  res.json({ ok: true, payment_request: paymentRequestProjection(updated) });
});

app.post("/v1/payment-intents", (req, res) => {
  const auth = verifyOpenClaw(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const body = req.body || {};
  const idempotencyKey = req.get("x-idempotency-key") || body.idempotency_key || "";
  if (idempotencyKey) {
    const existing = store.findByIdempotency(idempotencyKey);
    if (existing) return res.status(200).json({ ok: true, duplicate: true, intent: existing });
  }

  const target = body.target_app_device_id || process.env.DEFAULT_APP_DEVICE_ID || store.firstDeviceId();
  if (!target) return res.status(400).json({ error: "No target app device is registered" });

  const now = new Date();
  const expires = body.expires_at ? new Date(body.expires_at) : new Date(Date.now() + 5 * 60 * 1000);
  const intent = {
    protocol: "agentwallet.payment_intent.v1",
    ...body,
    intent_id: body.intent_id || id("pi"),
    status: "pending",
    created_at: body.created_at || now.toISOString(),
    expires_at: expires.toISOString(),
    idempotency_key: idempotencyKey,
    target_app_device_id: target,
    history: [{ status: "pending", at: now.toISOString() }]
  };

  const velarum = adaptVelarum(intent);
  if (!velarum.ok) return res.status(400).json({ error: velarum.error });

  const risk = evaluateIntent(intent, store);
  intent.risk = {
    ...(intent.risk || {}),
    warnings: [...(intent.risk?.warnings || []), ...(velarum.warnings || []), ...risk.warnings],
    errors: risk.errors
  };
  if (!risk.ok) return res.status(422).json({ error: "Risk policy rejected payment intent", details: risk.errors });

  store.putIntent(intent);
  notifyApp(target, { type: "payment_intent", intent_id: intent.intent_id, status: intent.status });
  res.status(201).json({ ok: true, intent });
});

app.get("/v1/payment-intents", (req, res) => {
  const auth = verifyAppQuery(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  store.expireStale();
  res.json({ ok: true, items: store.listForDevice(req.query.device_id) });
});

app.get("/v1/payment-intents/:id", (req, res) => {
  const auth = verifyAppQuery(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  store.expireStale();
  const intent = store.intent(req.params.id);
  if (!intent || intent.target_app_device_id !== req.query.device_id) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true, intent: store.intent(req.params.id) });
});

app.post("/v1/payment-intents/:id/status", (req, res) => {
  const auth = verifyAppBody(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const intent = store.intent(req.params.id);
  if (!intent || intent.target_app_device_id !== req.body.device_id) return res.status(404).json({ error: "Not found" });
  const status = req.body.status;
  if (!canTransition(status)) return res.status(400).json({ error: "Invalid status" });
  const updated = store.updateStatus(intent.intent_id, status, {
    tx_hash: req.body.tx_hash || null,
    error: req.body.error || null
  });
  if (shouldRecordSpent(status)) store.addDailySpent(intent.payment.asset, intent.payment.amount);
  notifyOpenClaw(intent.source?.device_id || "default", {
    type: "payment_status",
    intent_id: intent.intent_id,
    status,
    tx_hash: req.body.tx_hash || null,
    error: req.body.error || null
  });
  if (status === "broadcasted" && req.body.tx_hash) {
    confirmLater(updated, req.body.tx_hash);
  }
  res.json({ ok: true, intent: updated });
});

app.get("/v1/openclaw/events", (req, res) => {
  const since = Number(req.query.since || 0);
  res.json({ ok: true, items: store.eventsSince(since) });
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!["/v1/ws/app", "/v1/ws/openclaw", "/v1/ws/agent"].includes(url.pathname)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, url);
  });
});

wss.on("connection", (ws, _req, url) => {
  if (url.pathname === "/v1/ws/app") {
    const deviceId = url.searchParams.get("device_id") || "";
    const token = url.searchParams.get("token") || "";
    const device = store.device(deviceId);
    if (!device || device.token !== token) {
      ws.close(1008, "unauthorized");
      return;
    }
    addSocket(appSockets, deviceId, ws);
    ws.send(JSON.stringify({ type: "hello", role: "app", device_id: deviceId }));
    ws.on("close", () => removeSocket(appSockets, deviceId, ws));
    return;
  }

  if (url.pathname === "/v1/ws/agent") {
    const token = url.searchParams.get("connection_token") || url.searchParams.get("token") || "";
    const connection = store.connectionByToken(token);
    if (!connection || connection.status !== "active" || !connection.scopes.includes("payment.requests.read")) {
      ws.close(1008, "unauthorized");
      return;
    }
    if (connection.expires_at && Date.parse(connection.expires_at) <= Date.now()) {
      ws.close(1008, "connection expired");
      return;
    }
    addSocket(openclawSockets, connection.connection_id, ws);
    ws.send(JSON.stringify({
      type: "hello",
      role: "agent",
      connection_id: connection.connection_id
    }));
    ws.on("close", () => removeSocket(openclawSockets, connection.connection_id, ws));
    store.touchConnection(connection.connection_id);
    return;
  }

  const deviceId = url.searchParams.get("device_id") || "default";
  addSocket(openclawSockets, deviceId, ws);
  ws.send(JSON.stringify({ type: "hello", role: "openclaw", device_id: deviceId }));
  ws.on("close", () => removeSocket(openclawSockets, deviceId, ws));
});

server.listen(PORT, () => {
  console.log(`AgentWallet Relay listening on http://0.0.0.0:${PORT}`);
});

function sendApiError(res, status, code, message, options = {}) {
  const error = {
    code,
    message,
    severity: options.severity || "blocker"
  };
  if (options.field) error.field = options.field;
  if (options.details) error.details = options.details;
  return res.status(status).json({ ok: false, error });
}

function sendAuthFailure(res, auth) {
  return sendApiError(res, auth.status || 401, auth.code || "unauthorized_connection", auth.message || "Unauthorized connection");
}

function normalizeAgentIdentity(agent) {
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    return { ok: false, error: "agent identity is required", field: "agent" };
  }
  const agentId = String(agent.agent_id || agent.agentId || agent.id || "").trim();
  const agentName = String(agent.agent_name || agent.name || "").trim();
  if (!agentId) return { ok: false, error: "agent_id is required", field: "agent.agent_id" };
  if (!agentName) return { ok: false, error: "agent_name is required", field: "agent.agent_name" };
  return {
    ok: true,
    value: {
      agent_id: agentId,
      agent_name: agentName,
      runtime: String(agent.runtime || "unknown"),
      device_label: String(agent.device_label || agent.device || ""),
      source: String(agent.source || agent.channel || "")
    }
  };
}

function normalizeRequestedScopes(requestedScopes) {
  const scopes = requestedScopes === undefined || requestedScopes === null
    ? DEFAULT_PAIRING_SCOPES
    : requestedScopes;
  if (!Array.isArray(scopes)) {
    return { ok: false, code: "invalid_scope", error: "requested_scopes must be an array" };
  }
  return normalizeScopeList(scopes, "requested_scopes");
}

function normalizeApprovedScopes(approvedScopes, requestedScopes) {
  const scopes = approvedScopes === undefined || approvedScopes === null ? requestedScopes : approvedScopes;
  if (!Array.isArray(scopes)) {
    return { ok: false, code: "invalid_scope", error: "approved_scopes must be an array" };
  }
  const normalized = normalizeScopeList(scopes, "approved_scopes");
  if (!normalized.ok) return normalized;
  if (!normalized.value.length) {
    return { ok: false, status: 403, code: "scope_denied", error: "At least one scope must be approved" };
  }
  const requested = new Set(requestedScopes);
  const unexpected = normalized.value.find((scope) => !requested.has(scope));
  if (unexpected) {
    return {
      ok: false,
      status: 403,
      code: "scope_denied",
      error: `Approved scope was not requested: ${unexpected}`
    };
  }
  return normalized;
}

function normalizeScopeList(scopes, field) {
  const value = [];
  for (const raw of scopes) {
    const scope = String(raw || "").trim();
    if (!scope) return { ok: false, code: "invalid_scope", error: `${field} contains an empty scope` };
    if (isSigningScope(scope)) {
      return { ok: false, code: "unsupported_scope", error: `Signing scope is not grantable: ${scope}` };
    }
    if (!ALLOWED_PAIRING_SCOPES.has(scope)) {
      return { ok: false, code: "unsupported_scope", error: `Scope is not supported in v0.1: ${scope}` };
    }
    if (!value.includes(scope)) value.push(scope);
  }
  if (!value.length) return { ok: false, code: "invalid_scope", error: `${field} must include at least one scope` };
  return { ok: true, value, warnings: [] };
}

function isSigningScope(scope) {
  const value = scope.toLowerCase();
  return value.includes("sign") || value.includes("seed") || value.includes("private") || value.includes("keys");
}

function normalizePairingTtl(value) {
  if (value === undefined || value === null || value === "") {
    return { ok: true, seconds: DEFAULT_PAIRING_TTL_SECONDS };
  }
  const seconds = Number(value);
  if (!Number.isInteger(seconds)) return { ok: false, error: "expires_in_seconds must be an integer" };
  if (seconds < MIN_PAIRING_TTL_SECONDS || seconds > MAX_PAIRING_TTL_SECONDS) {
    return { ok: false, error: "expires_in_seconds must be between 60 and 600 seconds" };
  }
  return { ok: true, seconds };
}

function uniquePairingCode() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = pairingCodeFromRandomId();
    if (!store.pairingSessionByCode(code)) return code;
  }
  return pairingCodeFromRandomId();
}

function pairingCodeFromRandomId() {
  const randomHex = id("paircode").replace(/^paircode_/, "").slice(0, 12);
  return String(Number.parseInt(randomHex, 16) % 1000000).padStart(6, "0");
}

function resolvePairingSession(idOrCode, body = {}) {
  const session = store.pairingSession(String(idOrCode || ""));
  if (!session) return null;
  const pairingCode = body.pairing_code || body.code;
  if (pairingCode && String(pairingCode) !== session.pairing_code) return null;
  return session;
}

function pairingSessionResponse(session) {
  return {
    pairing_session_id: session.pairing_session_id,
    pairing_code: session.pairing_code,
    pairing_uri: session.pairing_uri,
    agent_identity: session.agent_identity,
    requested_scopes: session.requested_scopes,
    status: session.status,
    created_at: session.created_at,
    updated_at: session.updated_at,
    expires_at: session.expires_at
  };
}

function connectionResponse(connection) {
  return {
    connection_id: connection.connection_id,
    connection_token: connection.connection_token,
    scopes: connection.scopes,
    agent_identity: connection.agent_identity,
    status: connection.status,
    created_at: connection.created_at,
    expires_at: connection.expires_at
  };
}

function connectionPublicResponse(connection) {
  return {
    connection_id: connection.connection_id,
    pairing_session_id: connection.pairing_session_id,
    scopes: connection.scopes,
    approved_scopes: connection.approved_scopes,
    agent_identity: connection.agent_identity,
    status: connection.status,
    created_at: connection.created_at,
    updated_at: connection.updated_at,
    last_activity_at: connection.last_activity_at,
    expires_at: connection.expires_at,
    revoked_at: connection.revoked_at || null
  };
}

function authorizeConnection(req, scope, options = {}) {
  const token = connectionTokenFromRequest(req);
  if (!token) {
    if (options.allowLegacyOpenClaw && hasLegacyOpenClawCredential(req)) {
      const legacy = verifyOpenClaw(req);
      if (legacy.ok) return { ok: true, legacy: true };
      return {
        ok: false,
        status: legacy.status,
        code: legacy.status === 401 ? "unauthorized_connection" : "legacy_auth_failed",
        message: legacy.error
      };
    }
    return {
      ok: false,
      status: 401,
      code: "unauthorized_connection",
      message: "Connection token is required"
    };
  }

  const connection = store.connectionByToken(token);
  if (!connection) {
    return { ok: false, status: 401, code: "unauthorized_connection", message: "Connection token is invalid" };
  }
  if (connection.status !== "active") {
    return { ok: false, status: 401, code: "unauthorized_connection", message: "Connection is not active" };
  }
  if (connection.expires_at && Date.parse(connection.expires_at) <= Date.now()) {
    return { ok: false, status: 401, code: "unauthorized_connection", message: "Connection token expired" };
  }

  const requestedConnectionId = req.body?.connection_id || req.query?.connection_id;
  if (requestedConnectionId && requestedConnectionId !== connection.connection_id) {
    return { ok: false, status: 401, code: "unauthorized_connection", message: "Connection token does not match connection_id" };
  }

  if (!connection.scopes.includes(scope)) {
    return { ok: false, status: 403, code: "scope_denied", message: `Missing required scope: ${scope}` };
  }
  return { ok: true, connection };
}

function connectionTokenFromRequest(req) {
  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return String(req.get("x-connection-token") || req.query.connection_token || req.body?.connection_token || "").trim();
}

function hasLegacyOpenClawCredential(req) {
  return process.env.ALLOW_UNSIGNED_OPENCLAW === "true" || Boolean(req.get("x-signature"));
}

function buildTransactionContextPayload(body, connection) {
  const {
    connection_token: _connectionToken,
    token: _token,
    ...payload
  } = body || {};
  return {
    ...payload,
    connection_id: connection?.connection_id || payload.connection_id || ""
  };
}

function buildPaymentRequestPayload(body, connection, idempotencyKey) {
  const {
    connection_token: _connectionToken,
    device_id: _deviceId,
    target_app_device_id: _targetAppDeviceId,
    token: _token,
    ...payload
  } = body || {};
  const now = new Date();
  const connectionId = connection?.connection_id || payload.connection_id || "";
  return {
    ...payload,
    protocol: payload.protocol || "velarum.payment_request.v1",
    request_id: payload.request_id || id("prq"),
    connection_id: connectionId,
    created_at: payload.created_at || now.toISOString(),
    expires_at: payload.expires_at || new Date(now.getTime() + DEFAULT_PAYMENT_REQUEST_TTL_MS).toISOString(),
    idempotency_key: idempotencyKey || payload.idempotency_key || "",
    status: "pending",
    source: payload.source || sourceFromConnection(connection),
    payee: payload.payee || inferPayee(payload),
    policy: payload.policy || { requires_user_approval: true }
  };
}

function sourceFromConnection(connection) {
  const agent = connection?.agent_identity || {};
  return {
    agent_id: agent.agent_id || "legacy_openclaw",
    agent_name: agent.agent_name || "Legacy OpenClaw",
    runtime: agent.runtime || "openclaw",
    channel: agent.source || "local_connector",
    device_label: agent.device_label || ""
  };
}

function inferPayee(payload) {
  const payment = payload.payment || {};
  const metadata = payload.metadata || {};
  const display = payload.display || {};
  return {
    name: payment.payee_name || metadata.merchant?.name || metadata.restaurant?.name || display.title || "Unknown payee",
    verified: false
  };
}

function buildTransactionContextProjection(request) {
  const suppliedSnapshot = request.transaction_context_snapshot || null;
  if (!request.transaction_id) {
    return {
      ref: { status: "missing" },
      snapshot: suppliedSnapshot,
      context: null,
      warnings: [apiWarning("context_missing", "Payment Request has no transaction_id", { field: "transaction_id" })]
    };
  }

  const context = store.transactionContext(request.transaction_id);
  if (!context || context.connection_id !== request.connection_id) {
    return {
      ref: { transaction_id: request.transaction_id, status: "missing" },
      snapshot: suppliedSnapshot,
      context: null,
      warnings: [apiWarning("context_missing", "Transaction Context is not available for this connection", {
        field: "transaction_id"
      })]
    };
  }

  const snapshot = createTransactionContextSnapshot(context);
  if (!snapshot.ok) {
    return {
      ref: { transaction_id: request.transaction_id, status: "ready" },
      snapshot: suppliedSnapshot,
      context,
      warnings: snapshot.errors || [snapshot.error]
    };
  }

  return {
    ref: {
      transaction_id: request.transaction_id,
      status: "ready",
      snapshot_hash: snapshot.value.snapshot_hash
    },
    snapshot: snapshot.value,
    context,
    warnings: snapshot.warnings || []
  };
}

function apiWarning(code, message, details = {}) {
  return {
    code,
    message,
    details
  };
}

function paymentRequestProjection(request) {
  const {
    connection_token: _connectionToken,
    token: _token,
    target_app_device_id: _targetAppDeviceId,
    ...safe
  } = request || {};
  const context = paymentRequestContextSummary(safe);
  const risk = paymentRequestRiskSummary(safe, context);
  const statusProjection = paymentRequestStatusProjection(safe, risk, context);
  return {
    ...safe,
    request_id: safe.request_id || null,
    transaction_id: safe.transaction_id || null,
    status: safe.status || "pending",
    created_at: safe.created_at || null,
    updated_at: safe.updated_at || safe.created_at || null,
    expires_at: safe.expires_at || null,
    source: safe.source || {},
    payee: safe.payee || {},
    payment: safe.payment || {},
    payment_facts: safe.payment_facts || paymentFactsFromPaymentRequest(safe),
    context,
    risk,
    status_projection: statusProjection,
    status_label: statusProjection.label,
    review_state: statusProjection.review_state,
    status_group: statusProjection.group,
    inbox_group: statusProjection.inbox_group,
    is_final: statusProjection.is_final,
    requires_attention: statusProjection.requires_attention,
    history: Array.isArray(safe.history) ? safe.history : []
  };
}

function paymentRequestEventProjection(event) {
  const data = event.data || {};
  return {
    seq: event.seq,
    type: event.type,
    request_id: event.request_id || data.request_id || event.intent_id || null,
    transaction_id: data.transaction_id || null,
    connection_id: data.connection_id || null,
    status: data.status || null,
    tx_hash: data.tx_hash || null,
    error: data.error || null,
    at: event.at,
    data
  };
}

function validatePaymentRequestStatusUpdate(request, nextStatus) {
  const currentStatus = request.status || "pending";
  if (TERMINAL_PAYMENT_REQUEST_STATUSES.has(currentStatus) && currentStatus !== nextStatus) {
    return {
      ok: false,
      status: 409,
      code: "terminal_payment_request",
      message: "Terminal Payment Request status cannot be changed",
      details: {
        current_status: currentStatus,
        requested_status: nextStatus
      }
    };
  }
  return { ok: true };
}

function paymentRequestStatusMessage(request, patch = {}) {
  return {
    type: "payment_request_status",
    request_id: request.request_id,
    transaction_id: request.transaction_id || null,
    connection_id: request.connection_id || null,
    status: request.status,
    tx_hash: patch.tx_hash || request.tx_hash || null,
    error: patch.error || request.error || null
  };
}

function paymentFactsFromPaymentRequest(request) {
  const payment = request.payment || {};
  const fee = payment.estimated_fee || payment.fee || null;
  return {
    amount: payment.amount,
    token: payment.asset,
    network: payment.network,
    recipient: payment.to,
    fee,
    total: payment.total || request.payment_facts?.total || addDecimalStringsIfPossible(payment.amount, fee) || payment.amount,
    payee: request.payee || null
  };
}

function paymentRequestContextSummary(request) {
  const ref = request.transaction_context_ref || {};
  const snapshot = request.transaction_context_snapshot || null;
  const status = ref.status || (request.transaction_id ? "missing" : "missing");
  const warnings = (request.warnings || []).filter((warning) => warning?.code === "context_missing");
  return {
    status,
    transaction_id: ref.transaction_id || request.transaction_id || snapshot?.transaction_id || null,
    snapshot_hash: ref.snapshot_hash || snapshot?.snapshot_hash || null,
    has_snapshot: Boolean(snapshot),
    warnings
  };
}

function paymentRequestRiskSummary(request, context = paymentRequestContextSummary(request)) {
  const risk = request.risk || {};
  const errors = Array.isArray(risk.errors) ? risk.errors : [];
  const warnings = Array.isArray(risk.warnings) ? risk.warnings : [];
  const requestStatus = request.status || "pending";
  const contextMissing = context.status === "missing" || warnings.some((warning) => warning.code === "context_missing");
  const level = risk.level || (errors.length ? "danger" : warnings.length ? "caution" : "safe");
  const reviewStatus = risk.review_status || (errors.length
    ? "blocked"
    : contextMissing
      ? "missing_context"
      : warnings.some((warning) => warning.code === "ai_only_critical_field")
        ? "source_review_required"
        : warnings.length
          ? "needs_review"
          : "ready");
  const storedSigningAllowed = risk.signing_allowed ?? (errors.length === 0 && !contextMissing);
  return {
    ...risk,
    level,
    review_status: reviewStatus,
    signing_allowed: requestStatus === "pending" && Boolean(storedSigningAllowed) && errors.length === 0 && !contextMissing,
    errors,
    warnings
  };
}

function paymentRequestStatusProjection(request, risk, context) {
  const reviewState = paymentRequestReviewState(request, risk, context);
  const isFinal = FINAL_PAYMENT_REQUEST_REVIEW_STATES.has(reviewState);
  const requiresAttention = ATTENTION_PAYMENT_REQUEST_REVIEW_STATES.has(reviewState)
    || risk.level === "danger"
    || risk.review_status === "needs_review";
  return {
    lifecycle_status: request.status || "pending",
    review_state: reviewState,
    label: paymentRequestStatusLabel(reviewState),
    tone: paymentRequestStatusTone(reviewState, risk),
    group: isFinal ? "final" : requiresAttention ? "active_attention" : "pending",
    inbox_group: isFinal ? "final" : "pending",
    is_final: isFinal,
    requires_attention: requiresAttention,
    signing_allowed: risk.signing_allowed
  };
}

function paymentRequestReviewState(request, risk, context) {
  const status = String(request.status || "pending");
  if (status === "broadcasted") return "broadcasting";
  if (status === "signed") return "signed_locally";
  if (["confirmed", "expired", "rejected", "cancelled", "failed"].includes(status)) return status;
  if (hasRiskCode(risk, "network_disabled")) return "network_disabled";
  if (risk.errors.length) return "blocked";
  if (context.status === "missing" || risk.review_status === "missing_context") return "missing_context";
  if (risk.review_status === "source_review_required" || hasRiskCode(risk, "ai_only_critical_field")) {
    return "source_review_required";
  }
  if (risk.review_status === "needs_review") return "needs_review";
  return "pending";
}

function paymentRequestStatusLabel(reviewState) {
  const labels = {
    pending: "Awaiting signature",
    missing_context: "Missing context",
    blocked: "Risk blocked",
    needs_review: "Needs review",
    source_review_required: "Source review required",
    network_disabled: "Network disabled",
    signed_locally: "Signed locally",
    broadcasting: "Broadcasting",
    failed: "Failed",
    expired: "Expired",
    rejected: "Rejected",
    confirmed: "Confirmed",
    cancelled: "Cancelled"
  };
  return labels[reviewState] || "Awaiting signature";
}

function paymentRequestStatusTone(reviewState, risk) {
  if (["blocked", "failed", "rejected"].includes(reviewState)) return "danger";
  if (["missing_context", "needs_review", "source_review_required", "network_disabled"].includes(reviewState)) return "caution";
  if (["broadcasting", "expired", "cancelled", "signed_locally"].includes(reviewState)) return "info";
  if (reviewState === "confirmed") return "safe";
  return risk.level || "safe";
}

function hasRiskCode(risk, code) {
  return [...(risk.errors || []), ...(risk.warnings || [])].some((item) => item?.code === code);
}

function addDecimalStringsIfPossible(left, right) {
  if (!decimalString(left) || !decimalString(right)) return "";
  const [leftWhole, leftFraction = ""] = String(left).split(".");
  const [rightWhole, rightFraction = ""] = String(right).split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftUnits = BigInt(leftWhole) * 10n ** BigInt(scale) + BigInt(leftFraction.padEnd(scale, "0") || "0");
  const rightUnits = BigInt(rightWhole) * 10n ** BigInt(scale) + BigInt(rightFraction.padEnd(scale, "0") || "0");
  const sum = leftUnits + rightUnits;
  const whole = sum / (10n ** BigInt(scale));
  const fraction = String(sum % (10n ** BigInt(scale))).padStart(scale, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function decimalString(value) {
  return typeof value === "string" && /^(0|[1-9]\d*)(\.\d+)?$/.test(value);
}

function verifyOpenClaw(req) {
  if (process.env.ALLOW_UNSIGNED_OPENCLAW === "true") return { ok: true };
  const secret = process.env.OPENCLAW_DEVICE_SECRET || "";
  if (!secret) return { ok: false, status: 500, error: "OPENCLAW_DEVICE_SECRET is not configured" };
  const signature = req.get("x-signature") || "";
  if (!verifyHmac(secret, req.rawBody || "", signature)) {
    return { ok: false, status: 401, error: "Invalid OpenClaw signature" };
  }
  return { ok: true };
}

function verifyAppQuery(req) {
  const deviceId = req.query.device_id;
  const token = req.query.token;
  const device = store.device(deviceId);
  if (!device || device.token !== token) return { ok: false, status: 401, error: "Invalid app device token" };
  return { ok: true };
}

function verifyAppBody(req) {
  const deviceId = req.body.device_id;
  const token = req.body.token;
  const device = store.device(deviceId);
  if (!device || device.token !== token) return { ok: false, status: 401, error: "Invalid app device token" };
  return { ok: true };
}

function verifyContextRead(req) {
  if (req.query.device_id || req.query.token) return verifyAppQuery(req);
  if (process.env.ALLOW_UNSIGNED_OPENCLAW === "true") return { ok: true };
  return { ok: false, status: 401, error: "device_id and token are required" };
}

function addSocket(map, key, socket) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(socket);
}

function removeSocket(map, key, socket) {
  const set = map.get(key);
  if (!set) return;
  set.delete(socket);
  if (!set.size) map.delete(key);
}

function notifyApp(deviceId, message) {
  sendSet(appSockets.get(deviceId), message);
}

function notifyOpenClaw(deviceId, message) {
  sendSet(openclawSockets.get(deviceId), message);
  sendSet(openclawSockets.get("default"), message);
}

function sendSet(set, message) {
  if (!set) return;
  const text = JSON.stringify(message);
  for (const socket of set) {
    if (socket.readyState === socket.OPEN) socket.send(text);
  }
}

function liveSocketSummary(map) {
  return Array.from(map.entries())
    .map(([device_id, sockets]) => ({
      device_id,
      connections: Array.from(sockets).filter((socket) => socket.readyState === socket.OPEN).length
    }))
    .filter((item) => item.connections > 0);
}

async function confirmLater(intent, txHash) {
  try {
    const confirmed = await waitForConfirmation(intent, txHash);
    const status = confirmed.ok ? "confirmed" : "failed";
    const updated = store.updateStatus(intent.intent_id, status, {
      tx_hash: txHash,
      error: confirmed.error || null
    });
    if (status === "confirmed") store.addDailySpent(intent.payment.asset, intent.payment.amount);
    notifyOpenClaw(intent.source?.device_id || "default", {
      type: "payment_status",
      intent_id: intent.intent_id,
      status,
      tx_hash: txHash,
      error: confirmed.error || null
    });
    notifyApp(intent.target_app_device_id, {
      type: "payment_intent",
      intent_id: updated.intent_id,
      status: updated.status
    });
  } catch (error) {
    const updated = store.updateStatus(intent.intent_id, "failed", {
      tx_hash: txHash,
      error: error.message
    });
    notifyOpenClaw(intent.source?.device_id || "default", {
      type: "payment_status",
      intent_id: intent.intent_id,
      status: "failed",
      tx_hash: txHash,
      error: error.message
    });
    notifyApp(intent.target_app_device_id, {
      type: "payment_intent",
      intent_id: updated.intent_id,
      status: updated.status
    });
  }
}

async function waitForConfirmation(intent, txHash) {
  const payment = intent.payment || {};
  for (let attempt = 0; attempt < 30; attempt++) {
    if (payment.rail === "evm_erc20" || payment.rail === "base_usdc") {
      const receipt = await evmReceipt(payment.rpc_url, txHash);
      if (receipt) {
        if (receipt.status === "0x1") return { ok: true };
        return { ok: false, error: "EVM transaction reverted" };
      }
    }
    if (payment.rail === "stellar_xlm") {
      const stellar = await stellarTransaction(payment.horizon_url, txHash);
      if (stellar) return { ok: true };
    }
    await sleep(4000);
  }
  return { ok: false, error: "Confirmation timeout" };
}

async function evmReceipt(rpcUrl, txHash) {
  if (!rpcUrl) throw new Error("Missing EVM RPC URL for confirmation");
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionReceipt",
      params: [txHash]
    })
  });
  const json = await response.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result || null;
}

async function stellarTransaction(horizonUrl, txHash) {
  if (!horizonUrl) throw new Error("Missing Stellar Horizon URL for confirmation");
  const base = horizonUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/transactions/${txHash}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Horizon HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
