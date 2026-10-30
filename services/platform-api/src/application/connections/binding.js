export const CONNECTION_BINDING_VERSION = "Paytobe.connection_binding.v1";
export const CONNECTION_TOKEN_AUDIENCE = "Paytobe-platform-api";

const DIMENSIONS = Object.freeze([
  "merchant_id", "agent_id", "client_id", "credential_id", "approved_by_device_id", "connection_id", "audience"
]);

export function createConnectionBinding(connectionId, data = {}) {
  const source = data.auth_binding || {};
  const identity = data.agent_identity || {};
  const binding = {
    binding_version: CONNECTION_BINDING_VERSION,
    merchant_id: text(source.merchant_id || identity.merchant_id),
    agent_id: text(source.agent_id || identity.agent_id),
    client_id: text(source.client_id || identity.client_id),
    credential_id: text(source.credential_id || identity.credential_id),
    approved_by_device_id: text(data.approved_by_device_id),
    connection_id: text(connectionId),
    audience: text(data.audience || CONNECTION_TOKEN_AUDIENCE),
    agent_revocation_version: nonNegative(source.agent_revocation_version),
    credential_revocation_version: nonNegative(source.credential_revocation_version)
  };
  return DIMENSIONS.every((field) => binding[field]) ? Object.freeze(binding) : null;
}

export function validateConnectionBinding(connection, { audience = CONNECTION_TOKEN_AUDIENCE, supplied = {} } = {}) {
  if (!connection || connection.binding_version !== CONNECTION_BINDING_VERSION) return { ok: true, legacy: true };
  for (const field of DIMENSIONS) {
    if (!text(connection[field])) return invalid();
  }
  if (connection.connection_id !== supplied.connection_id && supplied.connection_id) return invalid();
  if (connection.audience !== audience) return invalid();
  for (const field of ["merchant_id", "agent_id", "client_id", "credential_id", "approved_by_device_id"]) {
    if (supplied[field] && text(supplied[field]) !== connection[field]) return invalid();
  }
  const identity = connection.agent_identity || {};
  for (const field of ["merchant_id", "agent_id", "client_id", "credential_id"]) {
    if (text(identity[field]) !== connection[field]) return invalid();
  }
  return { ok: true, legacy: false };
}

export function rejoinConnectionState(store, connection) {
  if (connection?.binding_version !== CONNECTION_BINDING_VERSION) return { ok: true, legacy: true };
  if (!store?.db || !store.device(connection.approved_by_device_id)) return invalid();
  const row = store.db.prepare(`SELECT m.status AS merchant_status,
      a.status AS agent_status, a.token_revocation_version,
      c.status AS credential_status, c.not_before, c.expires_at, c.revocation_version
    FROM merchants m
    JOIN agents a ON a.merchant_id = m.merchant_id AND a.agent_id = ?
    JOIN agent_credentials c ON c.merchant_id = m.merchant_id AND c.agent_id = a.agent_id AND c.credential_id = ?
    WHERE m.merchant_id = ?`).get(connection.agent_id, connection.credential_id, connection.merchant_id);
  const now = new Date().toISOString();
  if (!row || row.merchant_status !== "active" || row.agent_status !== "active"
      || !["active", "expiring"].includes(row.credential_status) || row.not_before > now || row.expires_at <= now
      || Number(row.token_revocation_version) !== Number(connection.agent_revocation_version)
      || Number(row.revocation_version) !== Number(connection.credential_revocation_version)) return invalid();
  return { ok: true, legacy: false };
}

/**
 * Produces the live, server-derived identity facts shown by a wallet before
 * Connect approval. Snapshot identity from a claim is never sufficient: every
 * binding dimension, lifecycle state, scope, revocation version, and credential
 * validity window is rejoined against the control-plane database.
 */
export function connectIdentityReview(store, subject, now = new Date().toISOString()) {
  const binding = subject?.auth_binding || {};
  const identity = subject?.agent_identity || {};
  const base = {
    state: "unverifiable",
    approval_allowed: false,
    reason_code: "identity_unverifiable",
    observed_at: now,
    merchant: null,
    agent: null,
    credential: null
  };
  if (subject?.identity_assurance !== "registered" || !store?.db) {
    return { ...base, reason_code: subject?.identity_assurance === "registered"
      ? "control_plane_unavailable" : "identity_not_registered" };
  }
  const required = ["merchant_id", "agent_id", "client_id", "credential_id"];
  if (required.some((field) => !text(binding[field]) || text(binding[field]) !== text(identity[field]))) {
    return { ...base, reason_code: "identity_binding_mismatch" };
  }

  let row;
  try {
    row = store.db.prepare(`SELECT m.merchant_id, m.display_name, m.status AS merchant_status,
        m.verification_state AS merchant_verification_state,
        a.agent_id, a.name AS agent_name, a.runtime, a.status AS agent_status,
        a.allowed_scopes_json, a.token_revocation_version,
        c.credential_id, c.status AS credential_status, c.not_before,
        c.expires_at AS credential_expires_at, c.revocation_version
      FROM merchants m
      JOIN agents a ON a.merchant_id = m.merchant_id AND a.agent_id = ?
      JOIN agent_credentials c ON c.merchant_id = m.merchant_id AND c.agent_id = a.agent_id AND c.credential_id = ?
      WHERE m.merchant_id = ?`).get(binding.agent_id, binding.credential_id, binding.merchant_id);
  } catch {
    return { ...base, reason_code: "control_plane_unavailable" };
  }
  if (!row) return { ...base, reason_code: "identity_record_missing" };

  let verifiedDomain = "";
  try {
    verifiedDomain = store.db.prepare(`SELECT domain FROM merchant_domains
      WHERE merchant_id = ? AND status = 'verified' ORDER BY verified_at DESC, domain LIMIT 1`)
      .get(row.merchant_id)?.domain || "";
  } catch { /* a verified merchant record remains useful without a domain table */ }

  const merchant = Object.freeze({
    merchant_id: row.merchant_id,
    display_name: row.display_name,
    status: row.merchant_status,
    verification_state: row.merchant_verification_state,
    verified_domain: verifiedDomain || null
  });
  const agent = Object.freeze({ agent_id: row.agent_id, name: row.agent_name, runtime: row.runtime, status: row.agent_status });
  const credential = Object.freeze({
    credential_id: row.credential_id,
    status: row.credential_status,
    not_before: row.not_before,
    expires_at: row.credential_expires_at
  });
  const result = { ...base, merchant, agent, credential };

  if (text(identity.agent_name) !== text(row.agent_name) || text(identity.runtime) !== text(row.runtime)) {
    return { ...result, reason_code: "identity_facts_changed" };
  }
  let allowedScopes;
  try { allowedScopes = JSON.parse(row.allowed_scopes_json); } catch { return { ...result, reason_code: "agent_scopes_unverifiable" }; }
  const requested = Array.isArray(subject.requested_scopes) ? subject.requested_scopes : [];
  if (!Array.isArray(allowedScopes) || requested.some((scope) => !allowedScopes.includes(scope))) {
    return { ...result, reason_code: "requested_scopes_changed" };
  }
  if (Number(binding.agent_revocation_version) !== Number(row.token_revocation_version)
      || Number(binding.credential_revocation_version) !== Number(row.revocation_version)) {
    return { ...result, state: "suspended", reason_code: "identity_revoked" };
  }

  const pending = row.merchant_status === "pending_verification" || row.agent_status === "draft"
    || ["pending", "pending_verification"].includes(row.credential_status)
    || (row.merchant_verification_state !== "verified" && !verifiedDomain);
  if (pending) return { ...result, state: "pending", reason_code: "identity_pending_verification" };
  const active = row.merchant_status === "active" && row.agent_status === "active"
    && ["active", "expiring"].includes(row.credential_status)
    && row.not_before <= now && row.credential_expires_at > now;
  if (!active) return { ...result, state: "suspended", reason_code: "identity_not_active" };
  return { ...result, state: "verified", approval_allowed: true, reason_code: "verified" };
}

function text(value) { return String(value || "").trim(); }
function nonNegative(value) { const number = Number(value); return Number.isInteger(number) && number >= 0 ? number : 0; }
function invalid() { return { ok: false, status: 401, code: "unauthorized_connection", message: "Connection token binding is invalid" }; }
