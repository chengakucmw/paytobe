import { normalizeRequestedScopes } from "../../domain/scopes.js";

const CANONICAL_FIELDS = new Set(["connect_key", "requested_scopes"]);
const SELF_DECLARED_FIELDS = new Set([
  "merchant_id", "tenant_id", "agent_id", "client_id", "credential_id", "agent_identity", "agent"
]);

export function authenticatedConnectClaim(authContext, agent, input, token = {}) {
  if (!authContext || !Object.isFrozen(authContext) || authContext.actor_type !== "agent_client") {
    return invalid(401, "unauthenticated", "Verified Agent AuthContext is required");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalid(400, "invalid_request", "Connect claim must be an object");
  }
  const selfDeclared = Object.keys(input).find((field) => SELF_DECLARED_FIELDS.has(field));
  if (selfDeclared) return invalid(400, "self_declared_identity_forbidden", "Connect claim identity must come from Agent authentication");
  const unknown = Object.keys(input).find((field) => !CANONICAL_FIELDS.has(field));
  if (unknown) return invalid(400, "invalid_request", `Unsupported Connect claim field: ${unknown}`);
  if (!agent || agent.merchant_id !== authContext.merchant_id || agent.agent_id !== authContext.agent_id || agent.status !== "active") {
    return invalid(401, "unauthenticated", "Agent identity is not active");
  }
  const scopes = normalizeRequestedScopes(input.requested_scopes);
  if (!scopes.ok) return invalid(400, scopes.code, scopes.error, "requested_scopes");
  const authorized = new Set(authContext.scopes || []);
  const registered = new Set(agent.allowed_scopes || []);
  const escalated = scopes.value.find((scope) => !authorized.has(scope) || !registered.has(scope));
  if (escalated) return invalid(403, "scope_denied", `Requested scope is not authorized: ${escalated}`, "requested_scopes");
  return {
    ok: true,
    scopes,
    binding: Object.freeze({
      merchant_id: authContext.merchant_id,
      agent_id: authContext.agent_id,
      client_id: authContext.client_id,
      credential_id: authContext.credential_id,
      agent_revocation_version: token.agent_revocation_version,
      credential_revocation_version: token.credential_revocation_version
    }),
    agent_identity: Object.freeze({
      agent_id: authContext.agent_id,
      agent_name: agent.name,
      runtime: agent.runtime,
      source: agent.source_domain || "",
      merchant_id: authContext.merchant_id,
      client_id: authContext.client_id,
      credential_id: authContext.credential_id,
      verified: true
    })
  };
}

function invalid(status, code, message, field) {
  return { ok: false, status, code, message, ...(field ? { field } : {}) };
}
