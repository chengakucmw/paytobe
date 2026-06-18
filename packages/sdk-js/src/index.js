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
export const validatePaymentRequest = normalizePaymentRequestV1;
export const validateTransactionContext = normalizeTransactionContextV1;

/**
 * @typedef {Object} VelarumPayClientOptions
 * @property {string=} baseUrl Platform API base URL. Defaults to http://127.0.0.1:8787.
 * @property {string=} connectionToken Connection-scoped token returned by pairing approval.
 * @property {typeof fetch=} fetch Fetch implementation for Node, browsers, or tests.
 * @property {Record<string, string>=} headers Extra headers sent with every request.
 */

/**
 * @typedef {Object} RequestOptions
 * @property {string=} connectionToken Per-call connection token override.
 * @property {string=} idempotencyKey Per-call Idempotency-Key header value.
 * @property {Record<string, string>=} headers Extra headers for one request.
 * @property {Record<string, string | number | boolean>=} query Query params for read methods.
 */

/**
 * Minimal VelarumPay SDK client for pairing, Transaction Context, Payment Request,
 * and status-event polling. It never handles wallet private keys or signing.
 */
export class VelarumPayClient {
  /**
   * @param {VelarumPayClientOptions=} options
   */
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_BASE_URL);
    this.connectionToken = options.connectionToken || "";
    this.fetchFn = options.fetch || globalThis.fetch;
    this.headers = { ...(options.headers || {}) };

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
      headers: this.headers
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

  async requestJson(method, path, body = null, options = {}) {
    const response = await this.fetchFn(joinUrl(this.baseUrl, path), {
      method,
      headers: this.requestHeaders(body, options),
      body: body === null || body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await readJson(response);

    if (!response.ok || data?.ok === false) {
      return normalizeFailure(data, response.status, response.statusText);
    }
    return data;
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

    const token = options.connectionToken ?? this.connectionToken;
    if (token && !hasHeader(headers, "authorization") && !hasHeader(headers, "x-connection-token")) {
      headers.authorization = `Bearer ${token}`;
    }
    if (options.idempotencyKey && !hasHeader(headers, "x-idempotency-key")) {
      headers["x-idempotency-key"] = String(options.idempotencyKey);
    }
    return headers;
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

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

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
  const error = normalizeError(data?.error || {
    code: "http_error",
    message: statusText || `HTTP ${status}`,
    severity: "blocker"
  });
  const errors = Array.isArray(data?.errors) ? data.errors.map(normalizeError) : [error];
  return {
    ...(isRecord(data) ? data : {}),
    ok: false,
    status,
    error,
    errors,
    warnings: Array.isArray(data?.warnings) ? data.warnings : []
  };
}

function normalizeError(error) {
  if (!isRecord(error)) {
    return {
      code: "api_error",
      message: String(error || "Platform API request failed"),
      severity: "blocker"
    };
  }

  const details = isRecord(error.details) ? error.details : {};
  return {
    ...error,
    code: error.code || "api_error",
    message: error.message || error.code || "Platform API request failed",
    field: error.field || details.field,
    severity: error.severity || details.severity || "blocker"
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
