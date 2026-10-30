const RESOURCE_DEFINITIONS = Object.freeze({
  merchant: definition("merchants", "merchant_id", ["display_name", "legal_name", "status", "verification_state", "version", "created_at", "updated_at"]),
  membership: definition("merchant_memberships", "membership_id", ["account_id", "role", "status", "version", "created_at", "updated_at"]),
  agent: definition("agents", "agent_id", ["name", "runtime", "environment", "source_domain", "allowed_scopes_json", "token_revocation_version", "status", "version", "created_at", "updated_at"]),
  credential: definition("agent_credentials", "credential_id", ["agent_id", "kid", "alg", "public_key", "status", "not_before", "expires_at", "revoked_at", "revocation_version", "version", "created_at", "updated_at"]),
  recipient: definition("recipients", "recipient_id", ["name", "status", "active_version_id", "version", "created_at", "updated_at"]),
  recipient_version: definition("recipient_versions", "recipient_version_id", ["recipient_id", "network", "asset", "address", "memo", "verification_state", "effective_at", "created_at"]),
  webhook: definition("webhook_endpoints", "webhook_endpoint_id", ["url", "event_types_json", "status", "secret_ciphertext", "version", "created_at", "updated_at"]),
  audit: definition("audit_events", "audit_event_id", ["actor_type", "actor_id", "action", "resource_type", "resource_id", "result", "request_id", "details_json", "occurred_at"])
});

export function createTenantScope(authContext) {
  if (!authContext || typeof authContext !== "object") throw new TypeError("Trusted AuthContext is required");
  if (!Object.isFrozen(authContext)) throw new TypeError("Trusted AuthContext must be immutable");
  const merchantId = required(authContext.merchant_id, "merchant_id");
  return Object.freeze({
    merchant_id: merchantId,
    actor_id: required(authContext.actor_id, "actor_id"),
    request_id: required(authContext.request_id, "request_id")
  });
}

export function assertTenantScope(scope) {
  if (!scope || !Object.isFrozen(scope)) throw new TypeError("Immutable TenantScope is required");
  required(scope.merchant_id, "merchant_id");
  required(scope.actor_id, "actor_id");
  required(scope.request_id, "request_id");
  return scope;
}

export function tenantResourceDefinition(resource) {
  const value = RESOURCE_DEFINITIONS[resource];
  if (!value) throw new TypeError(`Unsupported tenant resource: ${resource}`);
  return value;
}

export function tenantInsert(scope, resource, value) {
  assertTenantScope(scope);
  const spec = tenantResourceDefinition(resource);
  rejectSelfDeclaredTenant(value, scope);
  const id = required(value?.[spec.id], spec.id);
  const tenantColumns = spec.id === "merchant_id" ? [spec.id] : [spec.id, "merchant_id"];
  const columns = [...tenantColumns, ...spec.fields.filter((field) => value[field] !== undefined)];
  const values = [id, ...(spec.id === "merchant_id" ? [] : [scope.merchant_id]), ...columns.slice(tenantColumns.length).map((field) => value[field])];
  return Object.freeze({ spec, columns: Object.freeze(columns), values: Object.freeze(values) });
}

export function tenantPatch(scope, resource, value) {
  assertTenantScope(scope);
  const spec = tenantResourceDefinition(resource);
  rejectSelfDeclaredTenant(value, scope);
  const fields = Object.keys(value || {}).filter((field) => spec.mutable.has(field));
  if (!fields.length) throw new TypeError("Tenant update has no supported fields");
  return Object.freeze({ spec, fields: Object.freeze(fields), values: Object.freeze(fields.map((field) => value[field])) });
}

export function createTenantJobPayload(scope, type, payload) {
  assertTenantScope(scope);
  return deepFreeze({
    version: "Paytobe.tenant_job.v1",
    merchant_id: scope.merchant_id,
    type: required(type, "type"),
    payload: structuredClone(payload || {})
  });
}

export function assertTenantJobPayload(scope, job) {
  assertTenantScope(scope);
  if (!job || !Object.isFrozen(job) || job.version !== "Paytobe.tenant_job.v1") {
    throw new TypeError("Immutable tenant job payload is required");
  }
  if (job.merchant_id !== scope.merchant_id) throw new TypeError("Tenant job merchant_id does not match TenantScope");
  return job;
}

function definition(table, id, fields) {
  return Object.freeze({ table, id, fields: Object.freeze(fields), mutable: new Set(fields.filter((field) => !["created_at", "occurred_at"].includes(field))) });
}

function rejectSelfDeclaredTenant(value, scope) {
  if (value && Object.hasOwn(value, "merchant_id") && value.merchant_id !== scope.merchant_id) {
    throw new TypeError("Self-declared merchant_id cannot override TenantScope");
  }
  if (value && Object.hasOwn(value, "tenant_id")) throw new TypeError("tenant_id is not accepted by tenant repositories");
}

function required(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
