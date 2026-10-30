export const CONTROL_PLANE_SCHEMA_VERSION = "Paytobe.control-plane.v1";

export const CONTROL_PLANE_STATUSES = Object.freeze({
  merchant: Object.freeze(["pending_verification", "active", "suspended", "closed"]),
  membership: Object.freeze(["invited", "active", "suspended", "removed"]),
  domain: Object.freeze(["pending", "verified", "reverification_required", "failed", "revoked"]),
  agent: Object.freeze(["draft", "active", "suspended", "revoked"]),
  credential: Object.freeze(["pending_proof", "active", "expiring", "expired", "revoked"]),
  recipient: Object.freeze(["draft", "pending_verification", "active", "suspended", "revoked"]),
  webhook: Object.freeze(["draft", "active", "paused", "deleted"])
});

export const AGENT_ALLOWED_SCOPES = Object.freeze([
  "payment.requests.create",
  "payment.requests.read",
  "transaction_contexts.create",
  "transaction_contexts.read",
  "wallet.addresses.read"
]);

const PRIVATE_FIELD = /(?:^|_)(?:private_key|secret_key|seed|seed_phrase|mnemonic)(?:$|_)/i;
const AUTHORITATIVE_PAYMENT_FIELD = /^(?:network|asset|amount|recipient|recipient_id|address|to|contract|issuer|memo|tag|fee|estimated_fee)$/i;

const DEFINITIONS = Object.freeze({
  merchant: definition("merchant_id", ["display_name", "verification_state"], ["legal_name"]),
  membership: definition("membership_id", ["account_id", "role"], ["email_normalized"]),
  domain: definition("domain_id", ["domain", "method"], ["verified_at", "evidence_digest"]),
  agent: definition("agent_id", ["name", "runtime", "environment", "allowed_scopes", "token_revocation_version"], ["source_domain"]),
  credential: definition("credential_id", ["agent_id", "kid", "alg", "public_key", "not_before", "expires_at", "revocation_version"], ["revoked_at", "proof_digest"]),
  recipient: definition("recipient_id", ["name"], ["active_version_id"]),
  webhook: definition("webhook_endpoint_id", ["url", "event_types"], [])
});

export function validateMerchant(value) { return validateControlPlaneObject("merchant", value); }
export function validateMembership(value) { return validateControlPlaneObject("membership", value); }
export function validateMerchantDomain(value) { return validateControlPlaneObject("domain", value); }
export function validateAgent(value) { return validateControlPlaneObject("agent", value); }
export function validateAgentCredential(value) { return validateControlPlaneObject("credential", value); }
export function validateRecipient(value) { return validateControlPlaneObject("recipient", value); }
export function validateWebhookEndpoint(value) { return validateControlPlaneObject("webhook", value); }

export function validateControlPlaneObject(type, value) {
  const definitionValue = DEFINITIONS[type];
  if (!definitionValue) return invalid("unsupported_schema", "Unsupported control-plane schema");
  if (!isRecord(value)) return invalid("invalid_object", "Control-plane value must be an object");

  const sensitive = findSensitiveField(value);
  if (sensitive) return invalid("sensitive_field_forbidden", "Private key, seed phrase, and mnemonic fields are forbidden", sensitive);

  const allowed = new Set(definitionValue.allowed);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) return invalid("unknown_field", "Unknown control-plane field", unknown);

  const missing = definitionValue.required.find((field) => value[field] === undefined || value[field] === null || value[field] === "");
  if (missing) return invalid("required_field", "Required control-plane field is missing", missing);
  if (!Number.isInteger(value.version) || value.version < 1) return invalid("invalid_version", "version must be a positive integer", "version");
  if (!CONTROL_PLANE_STATUSES[type].includes(value.status)) return invalid("invalid_status", "Object status is not supported", "status");
  if (!isIsoInstant(value.created_at) || !isIsoInstant(value.updated_at)) return invalid("invalid_timestamp", "created_at and updated_at must be ISO instants");

  if (type === "membership" && !["owner", "admin", "developer", "viewer"].includes(value.role)) {
    return invalid("invalid_role", "Membership role is not supported", "role");
  }
  if (type === "domain" && !["dns_txt", "https_well_known"].includes(value.method)) {
    return invalid("invalid_domain_method", "Domain verification method is not supported", "method");
  }
  if (type === "agent") {
    if (!Array.isArray(value.allowed_scopes) || value.allowed_scopes.some((scope) => !AGENT_ALLOWED_SCOPES.includes(scope))) {
      return invalid("unsupported_scope", "Agent scope is not allowed", "allowed_scopes");
    }
    if (!Number.isInteger(value.token_revocation_version) || value.token_revocation_version < 0) {
      return invalid("invalid_revocation_version", "token_revocation_version must be a non-negative integer", "token_revocation_version");
    }
  }
  if (type === "credential") {
    if (value.alg !== "Ed25519") return invalid("unsupported_algorithm", "Credential algorithm must be Ed25519", "alg");
    if (!Number.isInteger(value.revocation_version) || value.revocation_version < 0) {
      return invalid("invalid_revocation_version", "revocation_version must be a non-negative integer", "revocation_version");
    }
  }
  if (type === "webhook" && (!Array.isArray(value.event_types) || !value.event_types.length)) {
    return invalid("invalid_event_types", "Webhook event_types must not be empty", "event_types");
  }
  return { ok: true, value: structuredClone(value) };
}

export function validateNonAuthoritativeMetadata(metadata) {
  if (metadata === undefined) return { ok: true, value: {} };
  if (!isRecord(metadata)) return invalid("invalid_metadata", "metadata must be an object", "metadata");
  const forbidden = Object.keys(metadata).find((field) => AUTHORITATIVE_PAYMENT_FIELD.test(field));
  if (forbidden) return invalid("authoritative_metadata_forbidden", "metadata cannot override authoritative payment or recipient facts", `metadata.${forbidden}`);
  const sensitive = findSensitiveField(metadata, "metadata");
  if (sensitive) return invalid("sensitive_field_forbidden", "Sensitive credential fields are forbidden in metadata", sensitive);
  return { ok: true, value: structuredClone(metadata) };
}

function definition(idField, fields, optional) {
  const shared = [idField, "merchant_id", "status", "version", "created_at", "updated_at"];
  return Object.freeze({ required: Object.freeze([...shared, ...fields]), allowed: Object.freeze([...shared, ...fields, ...optional]) });
}

function findSensitiveField(value, prefix = "") {
  if (!isRecord(value)) return "";
  for (const [field, nested] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${field}` : field;
    if (PRIVATE_FIELD.test(field)) return path;
    if (isRecord(nested)) {
      const found = findSensitiveField(nested, path);
      if (found) return found;
    }
  }
  return "";
}

function isIsoInstant(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function invalid(code, message, field) {
  return { ok: false, error: { code, message, ...(field ? { field } : {}) } };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
