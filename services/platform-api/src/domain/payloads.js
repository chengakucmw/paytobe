// Request-body → internal-payload builders (pure helpers).
//
// Extracted verbatim from server.js. These shape an inbound HTTP body into the
// canonical payload the store/normalizers expect; they do not touch the store.

const DEFAULT_PAYMENT_REQUEST_TTL_MS = 5 * 60 * 1000;

export function buildTransactionContextPayload(body, connection) {
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

export function buildPaymentRequestPayload(body, connection, idempotencyKey, runtime = {}) {
  const {
    connection_token: _connectionToken,
    device_id: _deviceId,
    target_app_device_id: _targetAppDeviceId,
    token: _token,
    ...payload
  } = body || {};
  const now = runtime.clock?.now?.() || new Date();
  const requestId = runtime.random?.id?.("prq");
  const connectionId = connection?.connection_id || payload.connection_id || "";
  return {
    ...payload,
    protocol: payload.protocol || "Paytobe.payment_request.v1",
    request_id: payload.request_id || requestId || requiredRuntimeId(),
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

function requiredRuntimeId() {
  throw new TypeError("A Random port is required when request_id is absent");
}

export function sourceFromConnection(connection) {
  const agent = connection?.agent_identity || {};
  return {
    agent_id: agent.agent_id || "legacy_openclaw",
    agent_name: agent.agent_name || "Legacy OpenClaw",
    runtime: agent.runtime || "openclaw",
    channel: agent.source || "local_connector",
    device_label: agent.device_label || ""
  };
}

export function inferPayee(payload) {
  const payment = payload.payment || {};
  const metadata = payload.metadata || {};
  const display = payload.display || {};
  return {
    name: payment.payee_name || metadata.merchant?.name || metadata.restaurant?.name || display.title || "Unknown payee",
    verified: false
  };
}
