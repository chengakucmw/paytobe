import {
  DEFAULT_BASE_URL,
  createPaytobeClient,
  normalizeError as normalizeApiError,
  validatePaymentRequest,
  validateTransactionContext
} from "@Paytobe/sdk-js";

export const HERMES_DEFAULT_SCOPES = Object.freeze([
  "payment.requests.create",
  "payment.requests.read",
  "transaction_contexts.create",
  "transaction_contexts.read"
]);

export const HERMES_STATUS_TRANSPORTS = Object.freeze([
  "polling",
  "websocket"
]);

export const DEFAULT_HERMES_AGENT = Object.freeze({
  agent_id: "agt_hermes_local",
  agent_name: "Hermes Local Agent",
  runtime: "hermes",
  device_label: "local desktop"
});

const PAYMENT_REQUEST_PROTOCOL = "Paytobe.payment_request.v1";
const TRANSACTION_CONTEXT_PROTOCOL = "Paytobe.transaction_context.v1";
const FORBIDDEN_FIELD_CODES = new Map([
  ["privatekey", "private_key_not_allowed"],
  ["walletprivatekey", "private_key_not_allowed"],
  ["serverprivatekey", "private_key_not_allowed"],
  ["secretkey", "secret_key_not_allowed"],
  ["signingkey", "signing_key_not_allowed"],
  ["seedphrase", "seed_phrase_not_allowed"],
  ["mnemonic", "seed_phrase_not_allowed"],
  ["autopay", "automatic_payment_not_allowed"],
  ["autoapprove", "automatic_payment_not_allowed"],
  ["autosign", "automatic_payment_not_allowed"],
  ["webhook", "webhook_not_allowed"],
  ["webhookurl", "webhook_not_allowed"],
  ["statuswebhookurl", "webhook_not_allowed"],
  ["callbackurl", "webhook_not_allowed"]
]);

/**
 * Local Hermes adapter for Paytobe Payment Request v1. It creates request
 * payloads and reads status only; it never signs, approves, or submits payment.
 */
export class HermesPaymentRequestAdapter {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_BASE_URL);
    this.connectionToken = options.connectionToken || "";
    this.connectionId = options.connectionId || "";
    this.agent = normalizeAgent(options.agent);
    this.now = options.now;
    this.client = options.client || createPaytobeClient({
      baseUrl: this.baseUrl,
      connectionToken: this.connectionToken,
      fetch: options.fetch || globalThis.fetch
    });
  }

  setConnectionToken(connectionToken) {
    this.connectionToken = connectionToken || "";
    if (typeof this.client.setConnectionToken === "function") {
      this.client.setConnectionToken(this.connectionToken);
    }
    return this;
  }

  createPairingSession(options = {}) {
    const scopeResult = normalizeScopes(options.requested_scopes || options.requestedScopes || HERMES_DEFAULT_SCOPES);
    if (!scopeResult.ok) return scopeResult;

    return this.client.createPairingSession({
      agent: normalizeAgent(options.agent || this.agent),
      requested_scopes: scopeResult.value,
      expires_in_seconds: normalizeExpiresInSeconds(options.expires_in_seconds ?? options.expiresInSeconds)
    }, {
      connectionToken: ""
    });
  }

  preparePaymentRequest(input = {}) {
    const safety = validateSafeHermesInput(input);
    if (!safety.ok) return safety;

    const prepared = hasStandardPayloads(input)
      ? prepareFromStandardPayloads(input, this)
      : prepareFromHermesIntent(input, this);
    if (!prepared.ok) return prepared;

    const contextValidation = normalizeValidationResult(
      validateTransactionContext(prepared.transaction_context, { now: prepared.now }),
      "transaction_context"
    );
    if (!contextValidation.ok) return contextValidation;

    const requestValidation = normalizeValidationResult(
      validatePaymentRequest(prepared.payment_request, { now: prepared.now }),
      "payment_request"
    );
    if (!requestValidation.ok) return requestValidation;

    return success({
      ok: true,
      transaction_id: prepared.transaction_context.transaction_id,
      request_id: prepared.payment_request.request_id,
      transaction_context: contextValidation.value || prepared.transaction_context,
      payment_request: requestValidation.value || prepared.payment_request,
      warnings: [
        ...contextValidation.warnings,
        ...requestValidation.warnings
      ]
    });
  }

  async createStandardPaymentRequest(input = {}, options = {}) {
    const prepared = this.preparePaymentRequest(input);
    if (!prepared.ok) return prepared;

    const contextResult = await this.client.createTransactionContext(prepared.transaction_context, {
      connectionToken: options.connectionToken,
      headers: options.headers
    });
    if (contextResult?.ok === false) {
      return apiFailure("create_transaction_context", contextResult);
    }

    const requestPayload = {
      ...prepared.payment_request
    };
    const targetAppDeviceId = options.targetAppDeviceId || options.target_app_device_id || input.target_app_device_id;
    if (targetAppDeviceId) requestPayload.target_app_device_id = targetAppDeviceId;

    const requestResult = await this.client.createPaymentRequest(requestPayload, {
      connectionToken: options.connectionToken,
      idempotencyKey: requestPayload.idempotency_key,
      headers: options.headers
    });
    if (requestResult?.ok === false) {
      return apiFailure("create_payment_request", requestResult);
    }

    return {
      ok: true,
      transaction_id: prepared.transaction_id,
      request_id: prepared.request_id,
      context: contextResult.context || contextResult.transaction_context || prepared.transaction_context,
      payment_request: requestResult.payment_request || prepared.payment_request,
      context_result: contextResult,
      payment_request_result: requestResult,
      warnings: [
        ...(prepared.warnings || []),
        ...(contextResult.warnings || []),
        ...(requestResult.warnings || [])
      ]
    };
  }

  getPaymentStatus(requestId, options = {}) {
    return this.client.getPaymentRequest(requestId, options);
  }

  pollStatusEvents(options = {}) {
    return this.client.pollEvents(options);
  }

  agentWebSocketUrl(options = {}) {
    const baseUrl = normalizeBaseUrl(options.baseUrl || this.baseUrl);
    const wsBase = baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    const token = options.connectionToken ?? this.connectionToken;
    const connectionId = options.connectionId || this.connectionId;
    const params = new URLSearchParams();
    if (token) params.set("connection_token", token);
    if (!token && connectionId) params.set("connection_id", connectionId);
    const query = params.toString();
    return `${wsBase}/v1/ws/agent${query ? `?${query}` : ""}`;
  }
}

export function createHermesPaymentRequestAdapter(options = {}) {
  return new HermesPaymentRequestAdapter(options);
}

export function prepareHermesPaymentRequest(input = {}, options = {}) {
  return createHermesPaymentRequestAdapter(options).preparePaymentRequest(input);
}

function prepareFromStandardPayloads(input, adapter) {
  const transactionContext = clone(input.transaction_context || input.transactionContext);
  const paymentRequest = clone(input.payment_request || input.paymentRequest);
  if (!transactionContext) return failure("invalid_hermes_payload", "transaction_context is required", "transaction_context");
  if (!paymentRequest) return failure("invalid_hermes_payload", "payment_request is required", "payment_request");

  return finalizePayloadPair(transactionContext, paymentRequest, input, adapter);
}

function prepareFromHermesIntent(input, adapter) {
  if (!isRecord(input.payment)) return failure("invalid_hermes_payload", "payment is required", "payment");

  const now = isoNow(input.created_at || adapter.now);
  const expiresAt = input.expires_at || isoFromOffset(now, input.expires_in_seconds || 300);
  const connectionId = input.connection_id || adapter.connectionId;
  if (!connectionId) return failure("connection_id_required", "connection_id is required for standard Payment Request output", "connection_id");

  const transactionId = input.transaction_id || stableId("txn_hermes", input.idempotency_key || input.request_id || now);
  const requestId = input.request_id || stableId("prq_hermes", transactionId);
  const idempotencyKey = input.idempotency_key || `${transactionId}-payment-1`;
  const source = normalizeSource(input.source, input.agent || adapter.agent);
  const title = input.title || input.display?.title || "Hermes payment request";
  const summary = input.summary || input.display?.summary || "Hermes prepared a Payment Request for wallet review.";
  const type = input.type || input.metadata?.type || "developer_test";

  const transactionContext = {
    protocol: TRANSACTION_CONTEXT_PROTOCOL,
    transaction_id: transactionId,
    connection_id: connectionId,
    created_at: now,
    type,
    status: input.context_status || input.status_context || "awaiting_payment",
    title,
    summary,
    source,
    user_intent: clone(input.user_intent || {}),
    agent_activity: clone(input.agent_activity || [
      {
        at: now,
        action: "payment_requested",
        label: "Created Payment Request",
        summary: "Hermes prepared a standard Payment Request for wallet review.",
        source_type: "payment_request_fact"
      }
    ]),
    items: clone(input.items || []),
    costs: clone(input.costs || {
      total: input.payment.amount,
      currency: input.payment.asset
    }),
    media: clone(input.media || []),
    evidence: clone(input.evidence || []),
    provenance: clone(input.provenance || { model: "truth_layer_v1" }),
    truth_fields: clone(input.truth_fields || []),
    missing_context: clone(input.missing_context || []),
    risk_findings: clone(input.risk_findings || [])
  };

  const paymentRequest = {
    protocol: PAYMENT_REQUEST_PROTOCOL,
    request_id: requestId,
    connection_id: connectionId,
    transaction_id: transactionId,
    created_at: now,
    expires_at: expiresAt,
    idempotency_key: idempotencyKey,
    status: "pending",
    source,
    payee: clone(input.payee || {
      name: "Hermes local request",
      verified: false
    }),
    payment: clone(input.payment),
    display: clone(input.display || {
      title,
      summary,
      primary_action: "Pay"
    }),
    policy: {
      ...(isRecord(input.policy) ? input.policy : {}),
      requires_user_approval: true
    },
    metadata: clone(input.metadata || {
      type
    })
  };

  return finalizePayloadPair(transactionContext, paymentRequest, input, adapter);
}

function finalizePayloadPair(transactionContext, paymentRequest, input, adapter) {
  const now = isoNow(input.created_at || transactionContext.created_at || paymentRequest.created_at || adapter.now);
  const expiresAt = paymentRequest.expires_at || input.expires_at || isoFromOffset(now, input.expires_in_seconds || 300);
  const connectionId = input.connection_id || adapter.connectionId || transactionContext.connection_id || paymentRequest.connection_id;
  if (!connectionId) return failure("connection_id_required", "connection_id is required for standard Payment Request output", "connection_id");

  const transactionId = input.transaction_id || transactionContext.transaction_id || paymentRequest.transaction_id;
  if (!transactionId) return failure("transaction_id_required", "transaction_id is required", "transaction_id");
  if (transactionContext.transaction_id && paymentRequest.transaction_id && transactionContext.transaction_id !== paymentRequest.transaction_id) {
    return failure("transaction_id_mismatch", "Transaction Context and Payment Request must use the same transaction_id", "transaction_id");
  }
  if (transactionContext.connection_id && paymentRequest.connection_id && transactionContext.connection_id !== paymentRequest.connection_id) {
    return failure("connection_id_mismatch", "Transaction Context and Payment Request must use the same connection_id", "connection_id");
  }

  const source = normalizeSource(paymentRequest.source || transactionContext.source, input.agent || adapter.agent);
  const requestId = paymentRequest.request_id || input.request_id || stableId("prq_hermes", transactionId);

  const normalizedContext = {
    ...transactionContext,
    protocol: TRANSACTION_CONTEXT_PROTOCOL,
    transaction_id: transactionId,
    connection_id: connectionId,
    created_at: transactionContext.created_at || now,
    status: transactionContext.status || "awaiting_payment",
    source,
    evidence: Array.isArray(transactionContext.evidence) ? transactionContext.evidence : [],
    truth_fields: Array.isArray(transactionContext.truth_fields) ? transactionContext.truth_fields : [],
    missing_context: Array.isArray(transactionContext.missing_context) ? transactionContext.missing_context : [],
    risk_findings: Array.isArray(transactionContext.risk_findings) ? transactionContext.risk_findings : []
  };

  const normalizedRequest = {
    ...paymentRequest,
    protocol: PAYMENT_REQUEST_PROTOCOL,
    request_id: requestId,
    connection_id: connectionId,
    transaction_id: transactionId,
    created_at: paymentRequest.created_at || now,
    expires_at: expiresAt,
    idempotency_key: paymentRequest.idempotency_key || input.idempotency_key || `${transactionId}-payment-1`,
    status: paymentRequest.status || "pending",
    source,
    policy: {
      ...(isRecord(paymentRequest.policy) ? paymentRequest.policy : {}),
      requires_user_approval: true
    }
  };

  return {
    ok: true,
    now,
    transaction_context: normalizedContext,
    payment_request: normalizedRequest
  };
}

function validateSafeHermesInput(input) {
  if (!isRecord(input)) return failure("invalid_hermes_payload", "Hermes payload must be an object", "");
  const paymentRequest = input.payment_request || input.paymentRequest;
  if (input.policy?.requires_user_approval === false || paymentRequest?.policy?.requires_user_approval === false) {
    return failure("user_approval_required", "Hermes connector cannot bypass wallet user approval", "policy.requires_user_approval");
  }

  const forbidden = findForbiddenField(input);
  if (forbidden) {
    return failure(
      forbidden.code,
      "Hermes connector payload cannot include private keys, automatic payment authority, or webhooks",
      forbidden.path
    );
  }
  return { ok: true };
}

function findForbiddenField(value, path = "") {
  if (!isRecord(value) && !Array.isArray(value)) return null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findForbiddenField(item, `${path}.${index}`.replace(/^\./, ""));
      if (found) return found;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_FIELD_CODES.has(normalized)) {
      return {
        code: FORBIDDEN_FIELD_CODES.get(normalized),
        path: `${path}.${key}`.replace(/^\./, "")
      };
    }
    const found = findForbiddenField(child, `${path}.${key}`.replace(/^\./, ""));
    if (found) return found;
  }
  return null;
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes)) return failure("invalid_scope", "requested_scopes must be an array", "requested_scopes");
  const value = [];
  for (const rawScope of scopes) {
    const scope = String(rawScope || "").trim();
    if (!scope) return failure("invalid_scope", "requested_scopes contains an empty scope", "requested_scopes");
    if (!HERMES_DEFAULT_SCOPES.includes(scope)) {
      return failure("unsupported_scope", `Hermes connector does not request unsupported scope: ${scope}`, "requested_scopes");
    }
    if (!value.includes(scope)) value.push(scope);
  }
  if (!value.length) return failure("invalid_scope", "requested_scopes must include at least one scope", "requested_scopes");
  return { ok: true, value };
}

function normalizeValidationResult(result, prefix) {
  if (result.ok) {
    return {
      ok: true,
      value: result.value,
      warnings: (result.warnings || []).map((warning) => normalizeError(warning, prefix))
    };
  }
  return {
    ok: false,
    error: normalizeError(result.error, prefix),
    errors: (result.errors || [result.error]).map((error) => normalizeError(error, prefix)),
    warnings: (result.warnings || []).map((warning) => normalizeError(warning, prefix))
  };
}

function apiFailure(step, result) {
  return {
    ok: false,
    step,
    status: result.status,
    error: normalizeError(result.error),
    errors: (result.errors || [result.error]).map((error) => normalizeError(error)),
    warnings: (result.warnings || []).map((warning) => normalizeError(warning))
  };
}

function normalizeError(error, prefix = "") {
  return normalizeApiError(error, {
    code: "hermes_connector_error",
    message: "Hermes connector request failed",
    prefix
  });
}

function normalizeAgent(agent = {}) {
  return {
    ...DEFAULT_HERMES_AGENT,
    ...(isRecord(agent) ? agent : {}),
    runtime: "hermes"
  };
}

function normalizeSource(source, agent) {
  if (isRecord(source)) return { ...source, runtime: source.runtime || "hermes" };
  const normalizedAgent = normalizeAgent(agent);
  return {
    agent_id: normalizedAgent.agent_id,
    agent_name: normalizedAgent.agent_name,
    runtime: "hermes",
    channel: "local_desktop"
  };
}

function normalizeExpiresInSeconds(value) {
  if (value === undefined || value === null || value === "") return 300;
  const number = Number(value);
  if (!Number.isFinite(number)) return 300;
  return Math.min(600, Math.max(60, Math.trunc(number)));
}

function hasStandardPayloads(input) {
  return Boolean(input.transaction_context || input.transactionContext || input.payment_request || input.paymentRequest);
}

function stableId(prefix, seed) {
  return `${prefix}_${String(seed).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "request"}`;
}

function isoNow(now) {
  if (now instanceof Date) return now.toISOString();
  if (now) return new Date(now).toISOString();
  return new Date().toISOString();
}

function isoFromOffset(startIso, seconds) {
  const expiresIn = normalizeExpiresInSeconds(seconds);
  return new Date(Date.parse(startIso) + expiresIn * 1000).toISOString();
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function success(data) {
  return data;
}

function failure(code, message, field = "", details = {}) {
  const error = normalizeError({
    code,
    message,
    field,
    severity: "blocker",
    details
  });
  return {
    ok: false,
    error,
    errors: [error],
    warnings: []
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
