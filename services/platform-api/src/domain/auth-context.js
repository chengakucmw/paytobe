const ACTOR_TYPES = new Set([
  "merchant_user",
  "agent_client",
  "wallet_device",
  "platform_operator"
]);

const FORBIDDEN_AGENT_SCOPE = /(?:^|[._:-])(approve|sign|seed|private[_-]?key)(?:$|[._:-])/i;

export class AuthorizationFailure extends Error {
  constructor(code, message, { status = 403, field = "" } = {}) {
    super(message);
    this.name = "AuthorizationFailure";
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

export function createAuthContext(verifiedIdentity) {
  if (!isRecord(verifiedIdentity)) throw new TypeError("Verified identity is required");
  const actorType = requiredString(verifiedIdentity.actor_type, "actor_type");
  if (!ACTOR_TYPES.has(actorType)) throw new TypeError("Unsupported actor_type");

  const scopes = Object.freeze([...new Set((verifiedIdentity.scopes || []).map((scope) => requiredString(scope, "scope")))].sort());
  if (actorType === "agent_client" && scopes.some((scope) => FORBIDDEN_AGENT_SCOPE.test(scope))) {
    throw new TypeError("Agent scopes cannot grant approval, signing, seed, or private-key authority");
  }

  const context = {
    actor_type: actorType,
    actor_id: requiredString(verifiedIdentity.actor_id, "actor_id"),
    merchant_id: optionalString(verifiedIdentity.merchant_id),
    role: optionalString(verifiedIdentity.role),
    agent_id: optionalString(verifiedIdentity.agent_id),
    client_id: optionalString(verifiedIdentity.client_id),
    credential_id: optionalString(verifiedIdentity.credential_id),
    device_id: optionalString(verifiedIdentity.device_id),
    connection_id: optionalString(verifiedIdentity.connection_id),
    scopes,
    auth_method: requiredString(verifiedIdentity.auth_method, "auth_method"),
    request_id: requiredString(verifiedIdentity.request_id, "request_id")
  };
  if (["merchant_user", "agent_client"].includes(actorType) && !context.merchant_id) {
    throw new TypeError("merchant_id is required for tenant actors");
  }
  if (actorType === "agent_client" && (!context.agent_id || !context.client_id || !context.credential_id)) {
    throw new TypeError("Agent AuthContext requires agent_id, client_id, and credential_id");
  }
  return Object.freeze(context);
}

export function tenantScopeFromAuthContext(authContext) {
  if (!authContext?.merchant_id) {
    throw new AuthorizationFailure("tenant_scope_violation", "A tenant-scoped identity is required", { status: 403 });
  }
  return Object.freeze({ merchant_id: authContext.merchant_id });
}

export function authorize(authContext, policy = {}) {
  if (!authContext) throw new AuthorizationFailure("unauthenticated", "Authentication is required", { status: 401 });
  if (policy.actor_types?.length && !policy.actor_types.includes(authContext.actor_type)) {
    throw new AuthorizationFailure("forbidden", "Actor type is not permitted");
  }
  if (policy.roles?.length && !policy.roles.includes(authContext.role)) {
    throw new AuthorizationFailure("forbidden", "Merchant role is not permitted");
  }
  if (policy.scopes?.length) {
    const missing = policy.scopes.find((scope) => !authContext.scopes.includes(scope));
    if (missing) throw new AuthorizationFailure("scope_denied", `Missing required scope: ${missing}`);
  }
  return authContext;
}

export function assertResourceTenant(authContext, resource) {
  const scope = tenantScopeFromAuthContext(authContext);
  if (!resource || resource.merchant_id !== scope.merchant_id) {
    throw new AuthorizationFailure("resource_not_found", "Resource not found", { status: 404 });
  }
  return resource;
}

function requiredString(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function optionalString(value) {
  return value == null ? "" : String(value).trim();
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
