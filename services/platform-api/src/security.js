import crypto from "crypto";
import path from "path";
import { verifyHmac, openClawCanonicalPayload } from "./crypto.js";
import { compareDecimalStrings, normalizeDecimalString } from "./decimal.js";

const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 600;
const DEFAULT_AUTH_RATE_LIMIT_MAX = 120;
// How far an OpenClaw signature's timestamp may be from the server clock before
// the request is rejected as stale (replay protection). 5 minutes each way.
const DEFAULT_SIGNATURE_MAX_SKEW_MS = 5 * 60_000;
const WEAK_SECRET_VALUES = new Set([
  "change-me",
  "change-me-openclaw-secret",
  "quickstart-smoke",
  "cross-component-smoke"
]);
const REDACTED = "[redacted]";
const SENSITIVE_KEY = /(authorization|token|secret|signature|password|seed|private|mnemonic)/i;
export const OFFICIAL_API_ORIGIN = "https://api.velarumai.com";
export const OFFICIAL_STELLAR_TESTNET_HORIZON = "https://horizon-testnet.stellar.org";

export function loadRuntimeConfig(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || "development").trim().toLowerCase();
  const runtimeEnv = String(env.RUNTIME_ENV || nodeEnv || "development").trim().toLowerCase();
  const production = runtimeEnv === "production" || nodeEnv === "production";
  const corsAllowedOrigins = parseList(env.CORS_ALLOWED_ORIGINS);

  return {
    service: "agentwallet-relay",
    node_env: nodeEnv,
    runtime_env: runtimeEnv,
    production,
    public_base_url: String(env.PUBLIC_BASE_URL || "").trim(),
    official_testnet_only: parseBool(env.OFFICIAL_TESTNET_ONLY, false),
    trust_proxy: parseBool(env.TRUST_PROXY, false),
    storage: {
      driver: String(env.RELAY_STORE_DRIVER || "sqlite").trim().toLowerCase(),
      path: String(env.RELAY_STORE_PATH || "").trim(),
      legacy_json_path: String(env.RELAY_STORE_LEGACY_JSON || "").trim()
    },
    cors: {
      allowed_origins: corsAllowedOrigins,
      allow_localhost: parseBool(env.CORS_ALLOW_LOCALHOST, !production),
      allow_credentials: parseBool(env.CORS_ALLOW_CREDENTIALS, false),
      allow_wildcard: corsAllowedOrigins.includes("*")
    },
    rate_limit: {
      enabled: parseBool(env.RATE_LIMIT_ENABLED, true),
      window_ms: positiveInt(env.RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS),
      max: positiveInt(env.RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX),
      auth_max: positiveInt(env.AUTH_RATE_LIMIT_MAX, DEFAULT_AUTH_RATE_LIMIT_MAX)
    },
    openclaw: {
      allow_unsigned: parseBool(env.ALLOW_UNSIGNED_OPENCLAW, false),
      unsigned_local_only: parseBool(env.ALLOW_UNSIGNED_OPENCLAW_LOCAL_ONLY, true),
      secrets: openClawSecrets(env),
      ws_token: String(env.OPENCLAW_WS_TOKEN || "").trim(),
      signature_max_skew_ms: positiveInt(env.OPENCLAW_SIGNATURE_MAX_SKEW_MS, DEFAULT_SIGNATURE_MAX_SKEW_MS)
    },
    audit: {
      enabled: parseBool(env.AUDIT_LOG_ENABLED, true)
    },
    observability: {
      metrics_token: String(env.METRICS_TOKEN || env.OBSERVABILITY_TOKEN || "").trim()
    },
    email: {
      provider: String(env.TRANSACTIONAL_EMAIL_PROVIDER || (production ? "" : "memory")).trim().toLowerCase(),
      account_id: String(env.CLOUDFLARE_EMAIL_ACCOUNT_ID || "").trim(),
      api_token: String(env.CLOUDFLARE_EMAIL_API_TOKEN || "").trim(),
      from: String(env.TRANSACTIONAL_EMAIL_FROM || "").trim().toLowerCase(),
      from_name: String(env.TRANSACTIONAL_EMAIL_FROM_NAME || "VelarumPay").trim(),
      reply_to: String(env.TRANSACTIONAL_EMAIL_REPLY_TO || "").trim().toLowerCase(),
      portal_base_url: String(env.MERCHANT_PORTAL_PUBLIC_URL || "").trim().replace(/\/+$/, ""),
      timeout_ms: positiveInt(env.TRANSACTIONAL_EMAIL_TIMEOUT_MS, 10_000)
    },
    stellar_public: {
      enabled: parseBool(env.STELLAR_PUBLIC_ENABLED, false),
      single_payment_max_xlm: String(env.STELLAR_PUBLIC_SINGLE_PAYMENT_MAX_XLM || "1").trim(),
      horizon_url: String(env.STELLAR_PUBLIC_HORIZON_URL || "").trim(),
      recipient_allowlist: parseList(env.ADDRESS_WHITELIST_STELLAR)
    },
    stellar_testnet: {
      horizon_url: String(env.STELLAR_TESTNET_HORIZON_URL || OFFICIAL_STELLAR_TESTNET_HORIZON).trim()
    },
    push: {
      fcm: {
        enabled: parseBool(env.FCM_ENABLED, false),
        project_id: String(env.FCM_PROJECT_ID || "").trim(),
        service_account_json: String(env.FCM_SERVICE_ACCOUNT_JSON || "").trim(),
        service_account_file: String(env.FCM_SERVICE_ACCOUNT_FILE || "").trim(),
        token_encryption_key: String(env.FCM_TOKEN_ENCRYPTION_KEY || "").trim(),
        timeout_ms: positiveInt(env.FCM_TIMEOUT_MS, 10_000)
      }
    }
  };
}

export function validateRuntimeConfig(config) {
  const errors = [];
  const warnings = [];

  if (config.openclaw.allow_unsigned && !config.openclaw.unsigned_local_only) {
    warnings.push("ALLOW_UNSIGNED_OPENCLAW is enabled without local-only protection.");
  }
  if (config.openclaw.secrets.some(isWeakSecret)) {
    warnings.push("OPENCLAW_DEVICE_SECRET contains a development placeholder.");
  }
  if (config.storage.path && !path.isAbsolute(config.storage.path)) {
    warnings.push("RELAY_STORE_PATH is relative; production deployments should use an absolute durable path.");
  }
  if (config.push.fcm.enabled) {
    if (!config.push.fcm.project_id) errors.push("FCM_PROJECT_ID must be configured when FCM_ENABLED is true.");
    if (!config.push.fcm.service_account_json && !config.push.fcm.service_account_file) {
      errors.push("FCM_SERVICE_ACCOUNT_JSON or FCM_SERVICE_ACCOUNT_FILE must be configured when FCM_ENABLED is true.");
    }
    if (config.push.fcm.service_account_file && config.production && !path.isAbsolute(config.push.fcm.service_account_file)) {
      errors.push("FCM_SERVICE_ACCOUNT_FILE must be an absolute path in production.");
    }
    if (!isAes256Key(config.push.fcm.token_encryption_key)) {
      errors.push("FCM_TOKEN_ENCRYPTION_KEY must be a base64/base64url or hex value that decodes to exactly 32 bytes.");
    }
  }
  if (config.email.provider && !["memory", "cloudflare"].includes(config.email.provider)) {
    errors.push("TRANSACTIONAL_EMAIL_PROVIDER must be memory or cloudflare.");
  }
  if (config.email.provider === "cloudflare") {
    if (!/^[a-f0-9]{32}$/i.test(config.email.account_id)) errors.push("CLOUDFLARE_EMAIL_ACCOUNT_ID must be a valid Cloudflare account ID.");
    if (config.email.api_token.length < 20) errors.push("CLOUDFLARE_EMAIL_API_TOKEN must be configured for Cloudflare Email Sending.");
    if (!isEmailAddress(config.email.from)) errors.push("TRANSACTIONAL_EMAIL_FROM must be a valid verified sender address.");
    if (config.email.reply_to && !isEmailAddress(config.email.reply_to)) errors.push("TRANSACTIONAL_EMAIL_REPLY_TO must be a valid email address.");
    if (!isHttpsOrigin(config.email.portal_base_url)) errors.push("MERCHANT_PORTAL_PUBLIC_URL must be an HTTPS origin.");
  }
  if (config.stellar_public.enabled) {
    const maxXlm = normalizeDecimalString(config.stellar_public.single_payment_max_xlm);
    if (maxXlm === null || compareDecimalStrings(maxXlm, "0") <= 0) {
      errors.push("STELLAR_PUBLIC_SINGLE_PAYMENT_MAX_XLM must be a positive decimal when Stellar mainnet is enabled.");
    }
    if (!isHttpsUrl(config.stellar_public.horizon_url)) {
      errors.push("STELLAR_PUBLIC_HORIZON_URL must be an HTTPS URL when Stellar mainnet is enabled.");
    }
    if (!config.stellar_public.recipient_allowlist.length) {
      errors.push("ADDRESS_WHITELIST_STELLAR must contain at least one verified recipient when Stellar mainnet is enabled.");
    }
  }
  if (config.official_testnet_only) {
    if (config.stellar_public.enabled) errors.push("STELLAR_PUBLIC_ENABLED must be false when OFFICIAL_TESTNET_ONLY is true.");
    if (config.stellar_public.horizon_url) errors.push("STELLAR_PUBLIC_HORIZON_URL must be absent in the official testnet environment.");
    if (config.stellar_testnet.horizon_url !== OFFICIAL_STELLAR_TESTNET_HORIZON) {
      errors.push(`STELLAR_TESTNET_HORIZON_URL must be ${OFFICIAL_STELLAR_TESTNET_HORIZON}.`);
    }
  }

  if (config.production) {
    if (config.public_base_url !== OFFICIAL_API_ORIGIN) {
      errors.push(`PUBLIC_BASE_URL must be the canonical ${OFFICIAL_API_ORIGIN} origin in production.`);
    }
    if (!config.official_testnet_only) {
      errors.push("OFFICIAL_TESTNET_ONLY must be true in production.");
    }
    if (config.email.provider !== "cloudflare") {
      errors.push("TRANSACTIONAL_EMAIL_PROVIDER must be cloudflare in production.");
    }
    if (!config.push.fcm.enabled) {
      errors.push("FCM_ENABLED must be true in production so wallet push delivery cannot be silently disabled.");
    }
    if (config.openclaw.allow_unsigned) {
      errors.push("ALLOW_UNSIGNED_OPENCLAW must be false in production.");
    }
    if (!config.openclaw.secrets.length) {
      errors.push("OPENCLAW_DEVICE_SECRET or OPENCLAW_DEVICE_SECRETS must be configured in production.");
    }
    if (config.openclaw.secrets.some(isWeakSecret)) {
      errors.push("OPENCLAW_DEVICE_SECRET must not use a development placeholder in production.");
    }
    if (!config.cors.allowed_origins.length || config.cors.allow_wildcard) {
      errors.push("CORS_ALLOWED_ORIGINS must be an explicit allowlist in production.");
    }
    if (!config.storage.path) {
      errors.push("RELAY_STORE_PATH must be configured in production.");
    } else if (!path.isAbsolute(config.storage.path)) {
      errors.push("RELAY_STORE_PATH must be an absolute durable path in production.");
    }
    if (!config.observability.metrics_token) {
      errors.push("METRICS_TOKEN or OBSERVABILITY_TOKEN must be set in production so the /metrics endpoint is not publicly readable.");
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function assertRuntimeConfig(config) {
  const validation = validateRuntimeConfig(config);
  if (!validation.ok) {
    const message = `Runtime configuration is not deployable:\n- ${validation.errors.join("\n- ")}`;
    const error = new Error(message);
    error.validation = validation;
    throw error;
  }
  return validation;
}

export function runtimeHealth(config, validation = validateRuntimeConfig(config)) {
  return {
    runtime_env: config.runtime_env,
    production: config.production,
    public_base_url: config.public_base_url,
    official_testnet_only: config.official_testnet_only,
    cors: {
      allowlist_count: config.cors.allowed_origins.length,
      allow_localhost: config.cors.allow_localhost,
      allow_wildcard: config.cors.allow_wildcard
    },
    rate_limit: {
      enabled: config.rate_limit.enabled,
      window_ms: config.rate_limit.window_ms,
      max: config.rate_limit.max,
      auth_max: config.rate_limit.auth_max
    },
    legacy_openclaw: {
      unsigned_enabled: config.openclaw.allow_unsigned,
      unsigned_local_only: config.openclaw.unsigned_local_only,
      secrets_configured: config.openclaw.secrets.length
    },
    push: {
      fcm_enabled: config.push.fcm.enabled,
      fcm_project_configured: Boolean(config.push.fcm.project_id),
      fcm_credentials_configured: Boolean(config.push.fcm.service_account_json || config.push.fcm.service_account_file),
      fcm_token_encryption_configured: isAes256Key(config.push.fcm.token_encryption_key)
    },
    email: {
      provider: config.email.provider || "unconfigured",
      provider_configured: config.email.provider === "cloudflare" && /^[a-f0-9]{32}$/i.test(config.email.account_id),
      sender_configured: isEmailAddress(config.email.from),
      portal_origin_configured: isHttpsOrigin(config.email.portal_base_url)
    },
    stellar_public: {
      enabled: config.stellar_public.enabled,
      single_payment_limit_configured: Boolean(normalizeDecimalString(config.stellar_public.single_payment_max_xlm)),
      https_horizon_configured: isHttpsUrl(config.stellar_public.horizon_url),
      recipient_allowlist_count: config.stellar_public.recipient_allowlist.length
    },
    stellar_testnet: {
      official_horizon: config.stellar_testnet.horizon_url === OFFICIAL_STELLAR_TESTNET_HORIZON
    },
    warnings: validation.warnings
  };
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value || "")).protocol === "https:";
  } catch {
    return false;
  }
}

function isHttpsOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && url.origin === url.href.replace(/\/$/, "");
  } catch {
    return false;
  }
}

function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

export function createCorsOptions(config) {
  return {
    credentials: config.cors.allow_credentials,
    optionsSuccessStatus: 204,
    origin(origin, callback) {
      const decision = isOriginAllowed(origin, config);
      callback(null, decision.ok ? true : false);
    }
  };
}

export function createTestnetOnlyMiddleware(config, options = {}) {
  return (req, res, next) => {
    if (!config.official_testnet_only) return next();
    const forbidden = findForbiddenNetwork(req.body);
    if (!forbidden) return next();
    if (typeof options.onViolation === "function") return options.onViolation(res, forbidden);
    return res.status(400).json({
      ok: false,
      error: {
        code: "validation_failed",
        message: "The official VelarumPay environment accepts Stellar testnet only.",
        severity: "blocker",
        details: { reason: "mainnet_forbidden", field: forbidden }
      }
    });
  };
}

function findForbiddenNetwork(value, pathPrefix = "body") {
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenNetwork(value[index], `${pathPrefix}[${index}]`);
      if (found) return found;
    }
    return "";
  }
  for (const [key, nested] of Object.entries(value)) {
    const field = `${pathPrefix}.${key}`;
    if (key === "network" && String(nested || "").trim() !== "stellar_testnet") return field;
    if (/mainnet|public_network|stellar_public/i.test(key) && nested !== false && nested !== "false" && nested !== "") return field;
    if (typeof nested === "string" && /horizon\.stellar\.org|\bstellar_public\b|\bbase_mainnet\b/i.test(nested)) return field;
    const found = findForbiddenNetwork(nested, field);
    if (found) return found;
  }
  return "";
}

export function isOriginAllowed(origin, config) {
  if (!origin) return { ok: true, reason: "non_browser_request" };
  if (config.cors.allow_wildcard && !config.production) return { ok: true, reason: "wildcard" };
  if (config.cors.allowed_origins.includes(origin)) return { ok: true, reason: "allowlist" };
  if (config.cors.allow_localhost && isLocalhostOrigin(origin)) return { ok: true, reason: "localhost" };
  return { ok: false, reason: "origin_not_allowed" };
}

export function createSecurityHeadersMiddleware() {
  return (_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  };
}

export class MemoryRateLimiter {
  constructor({ windowMs = DEFAULT_RATE_LIMIT_WINDOW_MS, max = DEFAULT_RATE_LIMIT_MAX } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.buckets = new Map();
  }

  consume(key, now = Date.now()) {
    const bucketKey = String(key || "unknown");
    let bucket = this.buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    if (this.buckets.size > 10_000) this.prune(now);
    const remaining = Math.max(0, this.max - bucket.count);
    return {
      allowed: bucket.count <= this.max,
      limit: this.max,
      remaining,
      reset_at: new Date(bucket.resetAt).toISOString(),
      retry_after_seconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    };
  }

  prune(now = Date.now()) {
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

// In-memory one-time-nonce cache for OpenClaw signature replay protection. A
// nonce only needs to be remembered until a signature bearing it would fail the
// freshness window anyway, so entries self-expire and the map stays bounded.
// Like MemoryRateLimiter this is per-process; a multi-instance deployment should
// back this with a shared store (see the security audit report). The signed
// timestamp window still caps replay exposure across instances in the meantime.
export class ReplayGuard {
  constructor({ ttlMs = DEFAULT_SIGNATURE_MAX_SKEW_MS, maxEntries = 100_000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.seen = new Map();
  }

  // Returns true if the nonce is fresh (and records it); false if it's a replay.
  checkAndRemember(nonce, now = Date.now(), expiresAt = now + this.ttlMs) {
    const key = String(nonce ?? "");
    const existing = this.seen.get(key);
    if (existing !== undefined && existing > now) return false;
    this.seen.set(key, expiresAt);
    if (this.seen.size > this.maxEntries) this.prune(now);
    return true;
  }

  prune(now = Date.now()) {
    for (const [key, expiresAt] of this.seen.entries()) {
      if (expiresAt <= now) this.seen.delete(key);
    }
  }
}

export function createRateLimitMiddleware(config, options = {}) {
  const limiter = new MemoryRateLimiter({
    windowMs: options.windowMs || config.rate_limit.window_ms,
    max: options.max || config.rate_limit.max
  });
  const name = options.name || "api";
  return (req, res, next) => {
    if (!config.rate_limit.enabled || req.path === "/health" || req.path === "/ready") {
      next();
      return;
    }
    const key = `${name}:${clientIp(req)}:${req.method}:${req.path}`;
    const result = limiter.consume(key);
    res.setHeader("RateLimit-Limit", String(result.limit));
    res.setHeader("RateLimit-Remaining", String(result.remaining));
    res.setHeader("RateLimit-Reset", result.reset_at);
    if (result.allowed) {
      next();
      return;
    }

    res.setHeader("Retry-After", String(result.retry_after_seconds));
    auditLog("runtime.rate_limited", req, {
      limiter: name,
      ip: clientIp(req),
      method: req.method,
      path: req.path
    }, config);
    res.status(429).json({
      ok: false,
      error: {
        code: "rate_limited",
        message: "Too many requests",
        severity: "blocker",
        retry_after_seconds: result.retry_after_seconds
      }
    });
  };
}

export function verifyOpenClawRequest(req, config, options = {}) {
  const signature = req.get?.("x-signature") || "";
  if (signature) {
    if (!config.openclaw.secrets.length) {
      return {
        ok: false,
        status: 500,
        code: "openclaw_secret_not_configured",
        error: "OPENCLAW_DEVICE_SECRET is not configured"
      };
    }

    // Replay protection: a signed request MUST also carry a timestamp and a
    // one-time nonce, both folded into the signed material below. Without them a
    // captured-and-resent request would verify forever (the original bug).
    const timestamp = req.get?.("x-timestamp") || "";
    const nonce = req.get?.("x-nonce") || "";
    if (!timestamp || !nonce) {
      return {
        ok: false,
        status: 401,
        code: "openclaw_signature_incomplete",
        error: "Signed OpenClaw requests must include x-timestamp and x-nonce"
      };
    }
    const timestampMs = parseTimestampMs(timestamp);
    if (timestampMs === null) {
      return {
        ok: false,
        status: 401,
        code: "openclaw_signature_incomplete",
        error: "x-timestamp must be epoch milliseconds"
      };
    }

    // Verify the signature FIRST (over timestamp + nonce + body). Only once the
    // request is proven authentic do we consult the freshness window / nonce
    // cache, so an unauthenticated attacker cannot poison the replay cache.
    const body = req.rawBody || "";
    const canonical = openClawCanonicalPayload(timestamp, nonce, body);
    const verified = config.openclaw.secrets.some((secret) => verifyHmac(secret, canonical, signature));
    if (!verified) {
      return { ok: false, status: 401, code: "invalid_openclaw_signature", error: "Invalid OpenClaw signature" };
    }

    const now = options.now ?? Date.now();
    const maxSkew = config.openclaw.signature_max_skew_ms ?? DEFAULT_SIGNATURE_MAX_SKEW_MS;
    if (Math.abs(now - timestampMs) > maxSkew) {
      return {
        ok: false,
        status: 401,
        code: "openclaw_signature_expired",
        error: "OpenClaw signature timestamp is outside the allowed window"
      };
    }

    const replayGuard = options.replayGuard;
    if (replayGuard && !replayGuard.checkAndRemember(nonce, now, timestampMs + maxSkew)) {
      return {
        ok: false,
        status: 401,
        code: "openclaw_replay_detected",
        error: "OpenClaw request has already been processed (replay detected)"
      };
    }
    return { ok: true, mode: "signed" };
  }

  const unsigned = legacyUnsignedDecision(req, config);
  if (unsigned.ok) return { ok: true, mode: "unsigned_local" };
  if (config.openclaw.allow_unsigned) {
    return {
      ok: false,
      status: 403,
      code: "unsigned_openclaw_not_local",
      error: unsigned.error
    };
  }
  if (!config.openclaw.secrets.length) {
    return {
      ok: false,
      status: 500,
      code: "openclaw_secret_not_configured",
      error: "OPENCLAW_DEVICE_SECRET is not configured"
    };
  }
  return {
    ok: false,
    status: 401,
    code: "openclaw_signature_required",
    error: "OpenClaw signature is required"
  };
}

export function shouldAttemptLegacyOpenClaw(req, config) {
  return Boolean(req.get?.("x-signature")) || config.openclaw.allow_unsigned;
}

export function verifyOpenClawWebSocket(req, url, config) {
  const token = url.searchParams.get("openclaw_token") || url.searchParams.get("token") || "";
  if (token && config.openclaw.ws_token && safeEqual(token, config.openclaw.ws_token)) {
    return { ok: true, mode: "ws_token" };
  }
  if (token && config.openclaw.secrets.some((secret) => safeEqual(token, secret))) {
    return { ok: true, mode: "shared_secret" };
  }
  const unsigned = legacyUnsignedDecision(req, config);
  if (unsigned.ok) return { ok: true, mode: "unsigned_local" };
  return {
    ok: false,
    status: config.openclaw.allow_unsigned ? 403 : 401,
    code: config.openclaw.allow_unsigned ? "unsigned_openclaw_not_local" : "openclaw_ws_token_required",
    error: config.openclaw.allow_unsigned
      ? unsigned.error
      : "OpenClaw WebSocket requires openclaw_token or local unsigned migration mode"
  };
}

export function legacyUnsignedDecision(req, config) {
  if (!config.openclaw.allow_unsigned) {
    return { ok: false, error: "Unsigned OpenClaw is disabled" };
  }
  if (config.openclaw.unsigned_local_only && !isLoopbackAddress(clientIp(req))) {
    return { ok: false, error: "Unsigned OpenClaw is only allowed from localhost" };
  }
  return { ok: true };
}

export function auditLog(event, req = null, details = {}, config = null) {
  if (config?.audit?.enabled === false) return;
  const payload = {
    level: details.level || "info",
    event,
    service: "agentwallet-relay",
    at: new Date().toISOString(),
    request_id: req?.requestId || null,
    method: req?.method || null,
    path: req?.path || req?.url || null,
    ip: req ? clientIp(req) : null,
    details: redact(details)
  };
  if (payload.details.level) delete payload.details.level;
  console.log(JSON.stringify(payload));
}

export function clientIp(req) {
  return normalizeIp(req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || "");
}

export function normalizeIp(value) {
  const ip = String(value || "").trim();
  if (!ip) return "";
  if (ip === "::1") return "127.0.0.1";
  if (ip.startsWith("::ffff:")) return ip.slice("::ffff:".length);
  return ip;
}

export function isLoopbackAddress(value) {
  const ip = normalizeIp(value);
  return ip === "localhost" || ip === "127.0.0.1" || ip.startsWith("127.") || ip === "::1";
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function legacyOrigin(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalhostOrigin(origin) {
  const parsed = legacyOrigin(origin);
  if (!parsed) return false;
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
}

function openClawSecrets(env) {
  return [
    ...parseList(env.OPENCLAW_DEVICE_SECRETS),
    String(env.OPENCLAW_DEVICE_SECRET || "").trim(),
    String(env.OPENCLAW_DEVICE_SECRET_PREVIOUS || "").trim()
  ].filter(Boolean).filter((secret, index, values) => values.indexOf(secret) === index);
}

function isWeakSecret(secret) {
  return WEAK_SECRET_VALUES.has(String(secret || "").trim());
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return number;
}

function isAes256Key(value) {
  const raw = String(value || "").trim();
  if (/^[a-f0-9]{64}$/i.test(raw)) return true;
  if (!raw) return false;
  try {
    const normalized = raw.replace(/^base64:/i, "").replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").length === 32;
  } catch {
    return false;
  }
}

function parseTimestampMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number;
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item);
  }
  return output;
}
