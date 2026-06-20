// Pairing scope & agent-identity normalization (pure helpers).
//
// Extracted verbatim from server.js as part of the server decomposition. No
// behavior change: these functions still take their inputs as arguments and
// return the same `{ ok, ... }` result objects the routes already expect.

const DEFAULT_PAIRING_TTL_SECONDS = 5 * 60;
const MIN_PAIRING_TTL_SECONDS = 60;
const MAX_PAIRING_TTL_SECONDS = 10 * 60;

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

export function normalizeAgentIdentity(agent) {
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

export function normalizeRequestedScopes(requestedScopes) {
  const scopes = requestedScopes === undefined || requestedScopes === null
    ? DEFAULT_PAIRING_SCOPES
    : requestedScopes;
  if (!Array.isArray(scopes)) {
    return { ok: false, code: "invalid_scope", error: "requested_scopes must be an array" };
  }
  return normalizeScopeList(scopes, "requested_scopes");
}

export function normalizeApprovedScopes(approvedScopes, requestedScopes) {
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

export function normalizeScopeList(scopes, field) {
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

export function isSigningScope(scope) {
  const value = scope.toLowerCase();
  return value.includes("sign") || value.includes("seed") || value.includes("private") || value.includes("keys");
}

export function normalizePairingTtl(value) {
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
