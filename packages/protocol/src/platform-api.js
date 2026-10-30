import { createHash } from "node:crypto";

export const PLATFORM_API_CONTRACT_VERSION = "Paytobe.platform-api.v1";
export const AUTH_CONTEXT_VERSION = "Paytobe.auth_context.v1";
export const IDEMPOTENCY_SCOPE_VERSION = "Paytobe.idempotency_scope.v1";

export const AUTH_CONTEXT_ACTOR_TYPES = Object.freeze([
  "merchant_user",
  "agent_client",
  "wallet_device",
  "platform_operator"
]);

export const AUTH_METHODS = Object.freeze([
  "merchant_session",
  "agent_assertion",
  "device_token",
  "platform_operator"
]);

export const MERCHANT_ROLES = Object.freeze(["owner", "admin", "developer", "viewer", "operator"]);

export const PLATFORM_API_ERROR_CODES = Object.freeze([
  "resource_not_found",
  "invalid_request",
  "validation_failed",
  "unauthenticated",
  "forbidden",
  "scope_denied",
  "tenant_scope_violation",
  "idempotency_conflict",
  "concurrency_conflict",
  "rate_limited",
  "internal_error"
]);

export const CROSS_TENANT_SAFE_ERROR = Object.freeze({
  status: 404,
  code: "resource_not_found",
  message: "Resource not found"
});

const AUTHORIZATION_BODY_FIELDS = Object.freeze(["merchant_id", "tenant_id", "agent_identity"]);
const FORBIDDEN_AGENT_SCOPES = /(?:^|[._:-])(approve|sign|seed|private[_-]?key)(?:$|[._:-])/i;

export function selfDeclaredAuthorizationFields(value) {
  if (!isRecord(value)) return [];
  return AUTHORIZATION_BODY_FIELDS.filter((field) => Object.hasOwn(value, field));
}

export function createAuthContext(verifiedIdentity, options = {}) {
  if (!isRecord(verifiedIdentity)) throw new TypeError("Verified identity is required");
  const actorType = requiredString(verifiedIdentity.actor_type, "actor_type");
  const actorId = requiredString(verifiedIdentity.actor_id, "actor_id");
  const authMethod = requiredString(verifiedIdentity.auth_method, "auth_method");
  const requestId = requiredString(options.requestId || verifiedIdentity.request_id, "request_id");
  if (!AUTH_CONTEXT_ACTOR_TYPES.includes(actorType)) throw new TypeError("Unsupported actor_type");
  if (!AUTH_METHODS.includes(authMethod)) throw new TypeError("Unsupported auth_method");

  const scopes = [...new Set((Array.isArray(verifiedIdentity.scopes) ? verifiedIdentity.scopes : [])
    .map((scope) => requiredString(scope, "scope")))].sort();
  if (actorType === "agent_client" && scopes.some((scope) => FORBIDDEN_AGENT_SCOPES.test(scope))) {
    throw new TypeError("Agent scopes cannot grant approval, signing, seed, or private-key authority");
  }

  const context = {
    version: AUTH_CONTEXT_VERSION,
    actor_type: actorType,
    actor_id: actorId,
    ...optionalString(verifiedIdentity, "merchant_id"),
    ...optionalString(verifiedIdentity, "role"),
    ...optionalString(verifiedIdentity, "agent_id"),
    ...optionalString(verifiedIdentity, "client_id"),
    ...optionalString(verifiedIdentity, "credential_id"),
    ...optionalString(verifiedIdentity, "device_id"),
    ...optionalString(verifiedIdentity, "connection_id"),
    scopes: Object.freeze(scopes),
    auth_method: authMethod,
    ...optionalString(verifiedIdentity, "session_id"),
    ...optionalString(verifiedIdentity, "step_up_at"),
    request_id: requestId
  };

  if (["merchant_user", "agent_client"].includes(actorType) && !context.merchant_id) {
    throw new TypeError("merchant_id is required for tenant actors");
  }
  if (actorType === "agent_client" && (!context.agent_id || !context.client_id || !context.credential_id)) {
    throw new TypeError("Agent AuthContext requires agent_id, client_id, and credential_id");
  }
  if (actorType === "wallet_device" && !context.device_id) {
    throw new TypeError("Wallet AuthContext requires device_id");
  }
  if (context.role && !MERCHANT_ROLES.includes(context.role)) throw new TypeError("Unsupported merchant role");
  return Object.freeze(context);
}

export function createPlatformApiError(code, message, options = {}) {
  if (!PLATFORM_API_ERROR_CODES.includes(code)) throw new TypeError("Unstable Platform API error code");
  const requestId = requiredString(options.requestId, "request_id");
  const error = {
    code,
    message: requiredString(message, "message"),
    request_id: requestId,
    ...(options.severity ? { severity: String(options.severity) } : {}),
    ...(options.field ? { field: String(options.field) } : {}),
    ...(isRecord(options.details) ? { details: structuredClone(options.details) } : {})
  };
  return { ok: false, error };
}

export function validatePlatformApiErrorEnvelope(value) {
  const error = value?.error;
  if (value?.ok !== false || !isRecord(error)) return { ok: false, code: "invalid_error_envelope" };
  if (!PLATFORM_API_ERROR_CODES.includes(error.code)) return { ok: false, code: "unstable_error_code" };
  if (!nonEmpty(error.message) || !nonEmpty(error.request_id)) return { ok: false, code: "invalid_error_envelope" };
  if (Object.keys(value).some((key) => !["ok", "error"].includes(key))) return { ok: false, code: "invalid_error_envelope" };
  return { ok: true, value };
}

export function createIdempotencyScope({ merchant_id, actor_id, route, key, request }) {
  return Object.freeze({
    version: IDEMPOTENCY_SCOPE_VERSION,
    merchant_id: requiredString(merchant_id, "merchant_id"),
    actor_id: requiredString(actor_id, "actor_id"),
    route: requiredString(route, "route"),
    key: requiredString(key, "key"),
    request_fingerprint: `sha256:${createHash("sha256").update(canonicalJson(request)).digest("hex")}`
  });
}

export function compareIdempotencyScope(existing, incoming) {
  const scopeFields = ["merchant_id", "actor_id", "route", "key"];
  if (!scopeFields.every((field) => existing?.[field] === incoming?.[field])) {
    return { ok: false, code: "resource_not_found", status: 404 };
  }
  if (existing.request_fingerprint !== incoming.request_fingerprint) {
    return { ok: false, code: "idempotency_conflict", status: 409 };
  }
  return { ok: true, duplicate: true };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function optionalString(value, field) {
  return value[field] == null || value[field] === "" ? {} : { [field]: requiredString(value[field], field) };
}

function requiredString(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
