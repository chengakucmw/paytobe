import { AGENT_ALLOWED_SCOPES, validateAgent } from "../../../../../packages/protocol/src/control-plane.js";
import { assertTenantScope } from "../../ports/tenant-repository.js";

const AGENT_ENVIRONMENTS = new Set(["sandbox", "testnet", "production"]);
const AGENT_TRANSITIONS = Object.freeze({
  draft: new Set(["active", "revoked"]),
  active: new Set(["suspended", "revoked"]),
  suspended: new Set(["active", "revoked"]),
  revoked: new Set()
});
const CREATE_FIELDS = new Set(["name", "runtime", "environment", "allowed_scopes"]);
const UPDATE_FIELDS = new Set(["name", "runtime", "environment", "allowed_scopes", "status", "version"]);

export class AgentService {
  constructor({ repository, clock, random }) {
    for (const [name, value] of Object.entries({ repository, clock, random })) {
      if (!value) throw new TypeError(`Agent ${name} dependency is required`);
    }
    this.repository = repository;
    this.clock = clock;
    this.random = random;
  }

  create(scope, input) {
    assertTenantScope(scope);
    if (hasSelfDeclaredIdentity(input)) return notFound();
    rejectUnknownFields(input, CREATE_FIELDS);
    const now = this.clock.nowIso();
    const agent = {
      agent_id: this.random.id("agent"),
      merchant_id: scope.merchant_id,
      name: requiredText(input?.name, "name", 120),
      runtime: requiredText(input?.runtime, "runtime", 80),
      environment: environment(input?.environment),
      allowed_scopes: scopes(input?.allowed_scopes),
      token_revocation_version: 0,
      status: "draft",
      version: 1,
      created_at: now,
      updated_at: now
    };
    assertCanonicalAgent(agent);
    const created = this.repository.create(scope, agent, audit(scope, this.random.id("audit"), "agent.created", agent, now));
    return { ok: true, agent: created };
  }

  get(scope, agentId) {
    assertTenantScope(scope);
    const agent = this.repository.get(scope, agentId);
    return agent ? { ok: true, agent } : notFound();
  }

  list(scope, options = {}) {
    assertTenantScope(scope);
    return { ok: true, ...this.repository.list(scope, options) };
  }

  update(scope, agentId, input) {
    assertTenantScope(scope);
    if (hasSelfDeclaredIdentity(input)) return notFound();
    rejectUnknownFields(input, UPDATE_FIELDS);
    const current = this.repository.get(scope, agentId);
    if (!current) return notFound();
    const expectedVersion = Number(input?.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1 || current.version !== expectedVersion) return conflict();
    if (current.status === "revoked") return invalid("agent_revoked", "Revoked Agents cannot be changed", 409);

    const patch = {};
    if (input.name !== undefined) patch.name = requiredText(input.name, "name", 120);
    if (input.runtime !== undefined) patch.runtime = requiredText(input.runtime, "runtime", 80);
    if (input.environment !== undefined) patch.environment = environment(input.environment);
    if (input.allowed_scopes !== undefined) patch.allowed_scopes = scopes(input.allowed_scopes);
    if (input.status !== undefined && input.status !== current.status) {
      const nextStatus = String(input.status || "").trim();
      if (!AGENT_TRANSITIONS[current.status]?.has(nextStatus)) {
        return invalid("invalid_agent_transition", "Agent status transition is not allowed", 409);
      }
      patch.status = nextStatus;
      if (["suspended", "revoked"].includes(nextStatus)) {
        patch.token_revocation_version = current.token_revocation_version + 1;
      }
    }
    if (!Object.keys(patch).length) return { ok: true, agent: current };

    const now = this.clock.nowIso();
    const candidate = { ...current, ...patch, version: current.version + 1, updated_at: now };
    assertCanonicalAgent(candidate);
    const action = patch.status ? "agent.status_changed" : "agent.updated";
    const updated = this.repository.update(scope, agentId, patch, expectedVersion, now,
      audit(scope, this.random.id("audit"), action, candidate, now, { previous_status: current.status }));
    return updated ? { ok: true, agent: updated } : conflict();
  }
}

export class SqliteAgentRepository {
  constructor(db) {
    if (!db) throw new TypeError("SQLite database is required");
    this.db = db;
  }

  create(scope, value, auditEvent) {
    assertTenantScope(scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO agents
        (agent_id, merchant_id, name, runtime, environment, allowed_scopes_json, token_revocation_version,
         status, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        value.agent_id, scope.merchant_id, value.name, value.runtime, value.environment,
        JSON.stringify(value.allowed_scopes), value.token_revocation_version, value.status, value.version,
        value.created_at, value.updated_at
      );
      this.insertAudit(auditEvent);
      this.db.exec("COMMIT");
      return this.get(scope, value.agent_id);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  get(scope, agentId) {
    assertTenantScope(scope);
    return publicAgent(this.db.prepare("SELECT * FROM agents WHERE merchant_id = ? AND agent_id = ?")
      .get(scope.merchant_id, String(agentId || "")));
  }

  list(scope, { limit = 50, cursor = "" } = {}) {
    assertTenantScope(scope);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    const rows = this.db.prepare(`SELECT * FROM agents WHERE merchant_id = ? AND agent_id > ?
      ORDER BY agent_id LIMIT ?`).all(scope.merchant_id, String(cursor || ""), safeLimit + 1);
    const more = rows.length > safeLimit;
    const items = rows.slice(0, safeLimit).map(publicAgent);
    return { items, next_cursor: more ? items.at(-1).agent_id : "" };
  }

  update(scope, agentId, patch, expectedVersion, updatedAt, auditEvent) {
    assertTenantScope(scope);
    const serialized = serializePatch(patch);
    const fields = Object.keys(serialized);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`UPDATE agents SET ${fields.map((field) => `${field} = ?`).join(", ")},
        version = version + 1, updated_at = ? WHERE merchant_id = ? AND agent_id = ? AND version = ?`)
        .run(...fields.map((field) => serialized[field]), updatedAt, scope.merchant_id, agentId, expectedVersion);
      if (Number(result.changes || 0) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.insertAudit(auditEvent);
      this.db.exec("COMMIT");
      return this.get(scope, agentId);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  insertAudit(value) {
    this.db.prepare(`INSERT INTO audit_events
      (audit_event_id, merchant_id, actor_type, actor_id, action, resource_type, resource_id,
       result, request_id, details_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      value.audit_event_id, value.merchant_id, value.actor_type, value.actor_id, value.action,
      value.resource_type, value.resource_id, value.result, value.request_id,
      JSON.stringify(value.details), value.occurred_at
    );
  }
}

export class MemoryAgentRepository {
  create() { return null; }
  get() { return null; }
  list() { return { items: [], next_cursor: "" }; }
  update() { return null; }
}

export function agentCanIssueToken(agent) {
  return agent?.status === "active";
}

export { AGENT_ALLOWED_SCOPES, AGENT_TRANSITIONS };

function publicAgent(row) {
  if (!row) return null;
  const { allowed_scopes_json: encodedScopes, ...rest } = row;
  let allowedScopes = [];
  try { allowedScopes = JSON.parse(encodedScopes); } catch { /* fail closed below */ }
  const value = { ...rest, allowed_scopes: Array.isArray(allowedScopes) ? allowedScopes : [] };
  assertCanonicalAgent(value);
  return value;
}

function serializePatch(patch) {
  const value = { ...patch };
  if (value.allowed_scopes !== undefined) {
    value.allowed_scopes_json = JSON.stringify(value.allowed_scopes);
    delete value.allowed_scopes;
  }
  return value;
}

function scopes(value) {
  if (!Array.isArray(value)) throw new TypeError("allowed_scopes must be an array");
  const normalized = [...new Set(value.map((scope) => String(scope || "").trim()))].sort();
  if (normalized.some((scope) => !AGENT_ALLOWED_SCOPES.includes(scope))) {
    throw new TypeError("allowed_scopes contains an unsupported or privileged scope");
  }
  return normalized;
}

function environment(value) {
  const normalized = String(value || "").trim();
  if (!AGENT_ENVIRONMENTS.has(normalized)) throw new TypeError("environment is invalid");
  return normalized;
}

function requiredText(value, field, max) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > max) throw new TypeError(`${field} is invalid`);
  return normalized;
}

function rejectUnknownFields(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Agent input must be an object");
  const unknown = Object.keys(input).find((field) => !allowed.has(field));
  if (unknown) throw new TypeError(`Unsupported Agent field: ${unknown}`);
}

function hasSelfDeclaredIdentity(input) {
  return ["merchant_id", "tenant_id", "agent_id", "agent_identity"].some((field) => Object.hasOwn(input || {}, field));
}

function assertCanonicalAgent(agent) {
  const verdict = validateAgent(agent);
  if (!verdict.ok) throw new TypeError(`Agent violates canonical control-plane contract: ${verdict.code}`);
}

function audit(scope, id, action, agent, at, extra = {}) {
  return {
    audit_event_id: id,
    merchant_id: scope.merchant_id,
    actor_type: "merchant_user",
    actor_id: scope.actor_id,
    action,
    resource_type: "agent",
    resource_id: agent.agent_id,
    result: "success",
    request_id: scope.request_id,
    details: { status: agent.status, version: agent.version, ...extra },
    occurred_at: at
  };
}

function invalid(code, message, status = 400) { return { ok: false, status, code, message }; }
function notFound() { return invalid("resource_not_found", "Resource not found", 404); }
function conflict() { return invalid("concurrency_conflict", "Agent version does not match", 409); }
