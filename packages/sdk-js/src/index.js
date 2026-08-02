import {
  createTransactionContextSnapshot,
  normalizePaymentRequestV1,
  normalizeTransactionContextV1
} from "@velarumpay/protocol";

export {
  createTransactionContextSnapshot,
  normalizePaymentRequestV1,
  normalizeTransactionContextV1
};

export const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
export const DEFAULT_AGENT_TOKEN_AUDIENCE = "https://api-testnet.velarumpay.com/v1/agent-auth/token";
export const validatePaymentRequest = normalizePaymentRequestV1;
export const validateTransactionContext = normalizeTransactionContextV1;

/**
 * @typedef {Object} VelarumPayClientOptions
 * @property {string=} baseUrl Platform API base URL. Defaults to http://127.0.0.1:8787.
 * @property {string=} connectionToken Connection-scoped token returned by pairing approval.
 * @property {typeof fetch=} fetch Fetch implementation for Node, browsers, or tests.
 * @property {Record<string, string>=} headers Extra headers sent with every request.
 * @property {AgentAuthOptions=} agentAuth Local-signer Agent authentication configuration.
 * @property {string | (() => string)=} csrfToken In-memory merchant CSRF proof or getter. Never a session token.
 * @property {() => string=} requestIdFactory Request ID factory.
 */

/**
 * @typedef {Object} RequestOptions
 * @property {string=} connectionToken Per-call connection token override.
 * @property {string=} idempotencyKey Per-call Idempotency-Key header value.
 * @property {Record<string, string>=} headers Extra headers for one request.
 * @property {Record<string, string | number | boolean>=} query Query params for read methods.
 * @property {string=} requestId Stable request ID for this call and its bounded retry.
 * @property {"connection" | "agent" | "merchant" | "none"=} auth Authentication boundary.
 * @property {boolean=} retryUnauthorized Allow one Agent-token refresh on 401. Defaults to true.
 */

/**
 * @typedef {Object} AgentAuthOptions
 * @property {string} agentId Registered Agent ID.
 * @property {string} clientId Stable client ID.
 * @property {string} kid Active Ed25519 credential kid.
 * @property {string[]} scopes Requested short-token scopes.
 * @property {(input: AgentSignerInput) => Promise<string | Uint8Array> | string | Uint8Array} signer Local signer callback.
 * @property {unknown=} keyHandle Opaque secure-key handle passed back only to signer.
 * @property {string=} audience Assertion audience.
 * @property {() => number=} now Millisecond clock.
 * @property {() => string=} createJti Unique JTI factory.
 * @property {number=} refreshSkewSeconds Refresh before token expiry; defaults to 30 seconds.
 */

/**
 * @typedef {Object} AgentSignerInput
 * @property {string} signingInput Compact protected-header and claims input.
 * @property {Uint8Array} data UTF-8 bytes to sign.
 * @property {Record<string, unknown>} protectedHeader
 * @property {Record<string, unknown>} claims
 * @property {unknown} keyHandle
 */

/**
 * Minimal VelarumPay SDK client for pairing, Transaction Context, Payment Request,
 * and status-event polling. It never handles wallet private keys or signing.
 */
export class VelarumPayClient {
  #agentToken = null;
  #agentRefresh = null;

  /**
   * @param {VelarumPayClientOptions=} options
   */
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_BASE_URL);
    this.connectionToken = options.connectionToken || "";
    this.fetchFn = options.fetch || globalThis.fetch;
    this.headers = { ...(options.headers || {}) };
    this.agentAuth = normalizeAgentAuth(options.agentAuth);
    this.csrfToken = options.csrfToken || "";
    this.requestIdFactory = options.requestIdFactory || createOpaqueRequestId;

    if (typeof this.fetchFn !== "function") {
      throw new TypeError("A fetch implementation is required");
    }
  }

  /**
   * @param {string} connectionToken
   * @returns {VelarumPayClient}
   */
  setConnectionToken(connectionToken) {
    this.connectionToken = connectionToken || "";
    return this;
  }

  /**
   * @param {string} connectionToken
   * @returns {VelarumPayClient}
   */
  withConnectionToken(connectionToken) {
    return new VelarumPayClient({
      baseUrl: this.baseUrl,
      connectionToken,
      fetch: this.fetchFn,
      headers: this.headers,
      agentAuth: this.agentAuth,
      csrfToken: this.csrfToken,
      requestIdFactory: this.requestIdFactory
    });
  }

  /**
   * Create a short-lived pairing session for a local agent or connector.
   *
   * @param {Record<string, unknown>} payload
   * @param {RequestOptions=} options
   * @returns {Promise<Record<string, unknown>>}
   */
  createPairingSession(payload, options = {}) {
    return this.requestJson("POST", "/v1/pairing/sessions", payload, options);
  }

  /**
   * Create or update a Transaction Context for a scoped connection.
   *
   * @param {Record<string, unknown>} payload
   * @param {RequestOptions=} options
   * @returns {Promise<Record<string, unknown>>}
   */
  createTransactionContext(payload, options = {}) {
    return this.requestJson("POST", "/v1/transaction-contexts", payload, options);
  }

  /**
   * Create a Payment Request for wallet review.
   *
   * @param {Record<string, unknown>} payload
   * @param {RequestOptions=} options
   * @returns {Promise<Record<string, unknown>>}
   */
  createPaymentRequest(payload, options = {}) {
    return this.requestJson("POST", "/v1/payment-requests", payload, {
      ...options,
      idempotencyKey: options.idempotencyKey || payload?.idempotency_key
    });
  }

  /**
   * Read a Payment Request projection owned by the active connection.
   *
   * @param {string} requestId
   * @param {RequestOptions=} options
   * @returns {Promise<Record<string, unknown>>}
   */
  getPaymentRequest(requestId, options = {}) {
    return this.requestJson("GET", appendQuery(`/v1/payment-requests/${encodeURIComponent(requestId)}`, options.query), null, options);
  }

  /**
   * Poll Payment Request status events for the active connection.
   *
   * @param {({ since?: number } & RequestOptions) | number=} options
   * @returns {Promise<Record<string, unknown>>}
   */
  pollEvents(options = {}) {
    const requestOptions = typeof options === "number" ? { since: options } : options;
    const since = Number.isFinite(Number(requestOptions.since)) ? Number(requestOptions.since) : 0;
    return this.requestJson("GET", `/v1/payment-requests/events?since=${encodeURIComponent(String(since))}`, null, requestOptions);
  }

  exchangeAgentToken() {
    return this.#refreshAgentToken(true);
  }

  clearAgentToken() {
    this.#agentToken = null;
  }

  claimConnectInvitation(connectKey, requestedScopes, options = {}) {
    return this.requestJson("POST", "/v1/connect-invitations/claim", {
      connect_key: connectKey,
      requested_scopes: requestedScopes
    }, { ...options, auth: "agent" });
  }

  getConnectInvitation(invitationId, claimToken, options = {}) {
    return this.requestJson("GET", `/v1/connect-invitations/${encodeURIComponent(invitationId)}`, null, {
      ...options, auth: "none", headers: { ...(options.headers || {}), authorization: `Bearer ${claimToken}` }
    });
  }

  async exchangeConnectInvitation(invitationId, claimToken, options = {}) {
    const result = await this.requestJson("POST", `/v1/connect-invitations/${encodeURIComponent(invitationId)}/exchange`, {}, {
      ...options, auth: "none", headers: { ...(options.headers || {}), authorization: `Bearer ${claimToken}` }
    });
    const token = result?.connection?.connection_token;
    if (result?.ok !== false && token && options.setConnectionToken !== false) this.setConnectionToken(token);
    return result;
  }

  listAgents(options = {}) { return this.#merchant("GET", "/v1/agents", null, options); }
  getAgent(agentId, options = {}) { return this.#merchant("GET", `/v1/agents/${encodeURIComponent(agentId)}`, null, options); }
  createAgent(payload, options = {}) { return this.#merchant("POST", "/v1/agents", payload, options); }
  updateAgent(agentId, payload, options = {}) { return this.#merchant("PATCH", `/v1/agents/${encodeURIComponent(agentId)}`, payload, options); }
  listAgentCredentials(agentId, options = {}) { return this.#merchant("GET", `/v1/agents/${encodeURIComponent(agentId)}/credentials`, null, options); }
  registerAgentCredential(agentId, payload, options = {}) { return this.#merchant("POST", `/v1/agents/${encodeURIComponent(agentId)}/credentials`, payload, options); }
  activateAgentCredential(agentId, credentialId, payload, options = {}) { return this.#merchant("POST", `/v1/agents/${encodeURIComponent(agentId)}/credentials/${encodeURIComponent(credentialId)}/activate`, payload, options); }
  revokeAgentCredential(agentId, credentialId, payload, options = {}) { return this.#merchant("DELETE", `/v1/agents/${encodeURIComponent(agentId)}/credentials/${encodeURIComponent(credentialId)}`, payload, options); }

  listRecipients(options = {}) { return this.#merchant("GET", "/v1/recipients", null, options); }
  getRecipient(recipientId, options = {}) { return this.#merchant("GET", `/v1/recipients/${encodeURIComponent(recipientId)}`, null, options); }
  createRecipient(payload, options = {}) { return this.#merchant("POST", "/v1/recipients", payload, options); }
  createRecipientVersion(recipientId, payload, options = {}) { return this.#merchant("POST", `/v1/recipients/${encodeURIComponent(recipientId)}/versions`, payload, options); }
  verifyRecipient(recipientId, payload, options = {}) { return this.#merchant("POST", `/v1/recipients/${encodeURIComponent(recipientId)}/verify`, payload, options); }
  activateRecipientVersion(recipientId, versionId, payload, options = {}) { return this.#merchant("POST", `/v1/recipients/${encodeURIComponent(recipientId)}/versions/${encodeURIComponent(versionId)}/activate`, payload, options); }

  listWebhookEndpoints(options = {}) { return this.#merchant("GET", "/v1/webhook-endpoints", null, options); }
  createWebhookEndpoint(payload, options = {}) { return this.#merchant("POST", "/v1/webhook-endpoints", payload, options); }
  verifyWebhookEndpoint(endpointId, options = {}) { return this.#merchant("POST", `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}/verify`, {}, options); }
  rotateWebhookSecret(endpointId, options = {}) { return this.#merchant("POST", `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}/rotate-secret`, {}, options); }
  revokeWebhookEndpoint(endpointId, options = {}) { return this.#merchant("DELETE", `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}`, {}, options); }
  listWebhookDeliveries(options = {}) { return this.#merchant("GET", "/v1/webhook-deliveries", null, options); }
  replayWebhookDelivery(deliveryId, options = {}) { return this.#merchant("POST", `/v1/webhook-deliveries/${encodeURIComponent(deliveryId)}/replay`, {}, options); }

  #merchant(method, path, body, options) {
    return this.requestJson(method, appendQuery(path, options.query), body, { ...options, auth: "merchant" });
  }

  async requestJson(method, path, body = null, options = {}) {
    const requestId = String(options.requestId || this.requestIdFactory());
    const auth = options.auth || "connection";
    let agentToken = "";
    if (auth === "agent") {
      const tokenResult = await this.#agentAccessToken(false);
      if (!tokenResult.ok) return tokenResult.failure;
      agentToken = tokenResult.token;
    }
    const execute = async (token) => {
      const response = await this.fetchFn(joinUrl(this.baseUrl, path), {
        method,
        headers: this.requestHeaders(body, { ...options, requestId, auth, agentToken: token }),
        body: body === null || body === undefined ? undefined : JSON.stringify(body),
        ...(auth === "merchant" ? { credentials: "include" } : {})
      });
      const data = await readJson(response);
      return { response, data };
    };
    let result = await execute(agentToken);
    if (auth === "agent" && result.response.status === 401 && options.retryUnauthorized !== false) {
      this.#agentToken = null;
      const refreshed = await this.#agentAccessToken(true);
      if (!refreshed.ok) return refreshed.failure;
      result = await execute(refreshed.token);
    }
    if (!result.response.ok || result.data?.ok === false) {
      return normalizeFailure(result.data, result.response.status, result.response.statusText);
    }
    return redactSensitive(result.data, { preserveSuccessTokens: true });
  }

  requestHeaders(body, options = {}) {
    const headers = {
      accept: "application/json",
      ...this.headers,
      ...(options.headers || {})
    };
    if (body !== null && body !== undefined && !hasHeader(headers, "content-type")) {
      headers["content-type"] = "application/json";
    }

    const token = options.auth === "agent" ? options.agentToken : (options.connectionToken ?? this.connectionToken);
    if (["agent", "connection"].includes(options.auth || "connection") && token && !hasHeader(headers, "authorization") && !hasHeader(headers, "x-connection-token")) {
      headers.authorization = `Bearer ${token}`;
    }
    if (options.auth === "merchant" && body !== null && body !== undefined && !hasHeader(headers, "x-csrf-token")) {
      const csrf = typeof this.csrfToken === "function" ? this.csrfToken() : this.csrfToken;
      if (csrf) headers["x-csrf-token"] = String(csrf);
    }
    if (options.idempotencyKey && !hasHeader(headers, "x-idempotency-key")) {
      headers["x-idempotency-key"] = String(options.idempotencyKey);
    }
    if (options.requestId && !hasHeader(headers, "x-request-id")) headers["x-request-id"] = options.requestId;
    return headers;
  }

  async #agentAccessToken(forceRefresh) {
    if (!this.agentAuth) return { ok: false, failure: authConfigurationFailure() };
    const now = this.agentAuth.now();
    if (!forceRefresh && this.#agentToken && this.#agentToken.expiresAt - this.agentAuth.refreshSkewMs > now) {
      return { ok: true, token: this.#agentToken.value };
    }
    const result = await this.#refreshAgentToken(forceRefresh);
    return result.ok === false ? { ok: false, failure: result } : { ok: true, token: this.#agentToken.value };
  }

  async #refreshAgentToken(forceRefresh) {
    if (!this.agentAuth) return authConfigurationFailure();
    if (!forceRefresh && this.#agentRefresh) return this.#agentRefresh;
    if (this.#agentRefresh) return this.#agentRefresh;
    this.#agentRefresh = this.#performAgentTokenExchange();
    try { return await this.#agentRefresh; }
    finally { this.#agentRefresh = null; }
  }

  async #performAgentTokenExchange() {
    let assertion;
    try { assertion = await createAgentAssertion(this.agentAuth); }
    catch { return authConfigurationFailure("Agent signer could not create an assertion"); }
    const response = await this.fetchFn(joinUrl(this.baseUrl, "/v1/agent-auth/token"), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "x-request-id": String(this.requestIdFactory()) },
      body: JSON.stringify({ client_assertion: assertion })
    });
    const data = await readJson(response);
    if (!response.ok || data?.ok === false) return normalizeFailure(data, response.status, response.statusText);
    const token = String(data?.access_token || "");
    const expiresIn = Number(data?.expires_in || 0);
    if (!/^vat_[A-Za-z0-9_-]{43}$/.test(token) || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      return normalizeFailure({ ok: false, error: { code: "invalid_agent_token_response", message: "Platform API returned an invalid Agent token response" } }, 502, "Bad Gateway");
    }
    this.#agentToken = { value: token, expiresAt: this.agentAuth.now() + expiresIn * 1000 };
    return redactSensitive(data, { preserveSuccessTokens: true });
  }
}

/**
 * @param {VelarumPayClientOptions=} options
 * @returns {VelarumPayClient}
 */
export function createVelarumPayClient(options = {}) {
  return new VelarumPayClient(options);
}

export function createPairingSession(payload, options = {}) {
  return createVelarumPayClient(options).createPairingSession(payload, options);
}

export function createTransactionContext(payload, options = {}) {
  return createVelarumPayClient(options).createTransactionContext(payload, options);
}

export function createPaymentRequest(payload, options = {}) {
  return createVelarumPayClient(options).createPaymentRequest(payload, options);
}

export function getPaymentRequest(requestId, options = {}) {
  return createVelarumPayClient(options).getPaymentRequest(requestId, options);
}

export function pollEvents(options = {}) {
  return createVelarumPayClient(options).pollEvents(options);
}

/**
 * Verify the standard VelarumPay webhook signature over the exact raw bytes.
 * The caller must verify before parsing JSON so whitespace and UTF-8 bytes
 * cannot be changed without detection.
 */
export async function verifyWebhookSignature(secret, rawBody, signatureHeader, options = {}) {
  const parts = Object.fromEntries(String(signatureHeader || "").split(",").map((part) => {
    const [key, ...value] = part.trim().split("=");
    return [key, value.join("=")];
  }));
  if (!/^\d{10,16}$/.test(parts.t || "") || !/^[0-9a-f]{64}$/i.test(parts.v1 || "")) {
    return webhookFailure("invalid_webhook_signature", "Webhook signature is invalid");
  }
  const toleranceSeconds = Math.max(0, Number(options.toleranceSeconds ?? 300));
  const nowSeconds = Math.floor(Number(options.now?.() ?? Date.now()) / 1000);
  const signedAt = Number(parts.t);
  if (!Number.isSafeInteger(signedAt) || Math.abs(nowSeconds - signedAt) > toleranceSeconds) {
    return webhookFailure("stale_webhook_signature", "Webhook signature timestamp is outside the accepted window");
  }
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) return webhookFailure("webhook_crypto_unavailable", "Webhook signature verification is unavailable");
  const body = typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : new Uint8Array(rawBody || []);
  const prefix = new TextEncoder().encode(`${parts.t}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  let digest;
  try {
    const key = await cryptoApi.subtle.importKey("raw", new TextEncoder().encode(String(secret || "")),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    digest = new Uint8Array(await cryptoApi.subtle.sign("HMAC", key, signed));
  } catch {
    return webhookFailure("invalid_webhook_secret", "Webhook signature could not be verified");
  }
  const supplied = hexBytes(parts.v1);
  let difference = digest.length ^ supplied.length;
  for (let index = 0; index < Math.max(digest.length, supplied.length); index += 1) {
    difference |= (digest[index] || 0) ^ (supplied[index] || 0);
  }
  return difference === 0
    ? { ok: true, timestamp: signedAt }
    : webhookFailure("invalid_webhook_signature", "Webhook signature is invalid");
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function hexBytes(value) {
  const text = String(value || "");
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function webhookFailure(code, message) { return { ok: false, code, message }; }

function joinUrl(baseUrl, path) {
  const normalizedPath = String(path || "/");
  return `${normalizeBaseUrl(baseUrl)}${normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`}`;
}

function appendQuery(path, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const suffix = params.toString();
  if (!suffix) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${suffix}`;
}

function hasHeader(headers, name) {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid_json_response",
        message: "Platform API returned a non-JSON response",
        severity: "blocker"
      }
    };
  }
}

function normalizeFailure(data, status, statusText) {
  const safeData = redactSensitive(data);
  const error = normalizeError(safeData?.error || {
    code: "http_error",
    message: statusText || `HTTP ${status}`,
    severity: "blocker"
  });
  const errors = Array.isArray(safeData?.errors) ? safeData.errors.map(normalizeError) : [error];
  return {
    ...(isRecord(safeData) ? safeData : {}),
    ok: false,
    status,
    error,
    errors,
    warnings: Array.isArray(safeData?.warnings) ? safeData.warnings : []
  };
}

async function createAgentAssertion(config) {
  const nowSeconds = Math.floor(config.now() / 1000);
  const protectedHeader = Object.freeze({ alg: "EdDSA", kid: config.kid, typ: "JWT" });
  const claims = Object.freeze({
    iss: config.agentId,
    sub: config.clientId,
    aud: config.audience,
    iat: nowSeconds,
    exp: nowSeconds + 300,
    jti: config.createJti(),
    scope: [...config.scopes]
  });
  const signingInput = `${encodeJsonPart(protectedHeader)}.${encodeJsonPart(claims)}`;
  const signed = await config.signer({
    signingInput,
    data: new TextEncoder().encode(signingInput),
    protectedHeader,
    claims,
    keyHandle: config.keyHandle
  });
  const signature = normalizeSignature(signed);
  if (!signature) throw new TypeError("Agent signer returned an invalid signature");
  return `${signingInput}.${signature}`;
}

function normalizeAgentAuth(value) {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || typeof value.signer !== "function") throw new TypeError("agentAuth signer callback is required");
  const agentId = boundedText(value.agentId, "agentAuth.agentId", 128);
  const clientId = boundedText(value.clientId, "agentAuth.clientId", 128);
  const kid = boundedText(value.kid, "agentAuth.kid", 80);
  const scopes = Array.isArray(value.scopes) ? [...new Set(value.scopes.map(String).map((scope) => scope.trim()).filter(Boolean))].sort() : [];
  if (!scopes.length || scopes.some((scope) => scope.length > 100)) throw new TypeError("agentAuth.scopes is invalid");
  const now = typeof value.now === "function" ? value.now : Date.now;
  const createJti = typeof value.createJti === "function" ? value.createJti : createOpaqueRequestId;
  const refreshSkewMs = Number.isFinite(Number(value.refreshSkewMs))
    ? Math.max(0, Number(value.refreshSkewMs))
    : Math.max(0, Number(value.refreshSkewSeconds ?? 30) * 1000);
  return Object.freeze({
    agentId,
    clientId,
    kid,
    scopes: Object.freeze(scopes),
    signer: value.signer,
    keyHandle: value.keyHandle,
    audience: String(value.audience || DEFAULT_AGENT_TOKEN_AUDIENCE),
    now,
    createJti,
    refreshSkewMs
  });
}

function boundedText(value, field, max) {
  const text = String(value || "").trim();
  if (!text || text.length > max) throw new TypeError(`${field} is invalid`);
  return text;
}

function encodeJsonPart(value) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function normalizeSignature(value) {
  if (typeof value === "string") {
    const signature = value.trim().replace(/=+$/, "");
    return /^[A-Za-z0-9_-]+$/.test(signature) ? signature : "";
  }
  if (value instanceof Uint8Array) return base64Url(value);
  return "";
}

function base64Url(bytes) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  if (typeof btoa === "function") return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64url");
  throw new TypeError("A base64url encoder is required");
}

function createOpaqueRequestId() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return `req_${base64Url(bytes)}`;
  }
  throw new TypeError("A cryptographically secure request ID source is required");
}

function authConfigurationFailure(message = "Agent authentication is not configured") {
  return normalizeFailure({ ok: false, error: { code: "agent_auth_not_configured", message } }, 0, "");
}

const SENSITIVE_KEY = /(?:^|_)(?:authorization|assertion|access_token|connection_token|claim_token|secret|signature|private_key|seed|mnemonic)(?:$|_)/i;
const SENSITIVE_VALUE = /(?:Bearer\s+[A-Za-z0-9._-]+|(?:vat|whsec|claim_tok|conn_tok|msession|mcsrf)_[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

function redactSensitive(value, options = {}, depth = 0, key = "") {
  if (options.preserveSuccessTokens) return value;
  if (depth > 8) return "[TRUNCATED]";
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return SENSITIVE_VALUE.test(value) ? "[REDACTED]" : value.slice(0, 2_000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactSensitive(item, options, depth + 1, key));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactSensitive(child, options, depth + 1, childKey)]));
}

// Shared error normalizer for the SDK and its connectors (MCP, Hermes).
// Options let each caller keep its exact prior output:
//   code/message  — connector-specific defaults
//   emptyField    — true to always emit field:"" (MCP/Hermes) instead of omitting it (SDK)
//   prefix        — Hermes namespaces nested field paths as `${prefix}.${field}`
export function normalizeError(error, options = {}) {
  const {
    code = "api_error",
    message = "Platform API request failed",
    prefix,
    emptyField = false
  } = options;

  if (!isRecord(error)) {
    const normalizedMessage = String(error || message);
    if (prefix !== undefined) return { code, message: normalizedMessage, field: prefix, severity: "blocker" };
    if (emptyField) return { code, message: normalizedMessage, field: "", severity: "blocker" };
    return { code, message: normalizedMessage, severity: "blocker" };
  }

  const details = isRecord(error.details) ? error.details : {};
  const baseField = error.field || details.field;
  let field;
  if (prefix !== undefined) {
    const inner = baseField || "";
    field = prefix && inner ? `${prefix}.${inner}` : inner || prefix;
  } else if (emptyField) {
    field = baseField || "";
  } else {
    field = baseField;
  }
  return {
    ...error,
    code: error.code || code,
    message: error.message || error.code || message,
    field,
    severity: error.severity || details.severity || "blocker"
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
