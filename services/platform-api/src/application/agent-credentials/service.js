import { validateAgentCredential } from "../../../../../packages/protocol/src/control-plane.js";
import { assertTenantScope } from "../../ports/tenant-repository.js";
import { credentialAuditEvent, credentialReminderEvent } from "../audit/credential-events.js";

const INPUT_FIELDS = new Set(["kid", "alg", "public_key", "not_before", "expires_at"]);
const MAX_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;
const EXPIRY_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;

export class AgentCredentialService {
  constructor({ repository, clock, random, hash, normalizePublicKey, verifySignature }) {
    for (const [name, value] of Object.entries({ repository, clock, random, hash, normalizePublicKey, verifySignature })) {
      if (!value) throw new TypeError(`Agent credential ${name} dependency is required`);
    }
    this.repository = repository;
    this.clock = clock;
    this.random = random;
    this.hash = hash;
    this.normalizePublicKey = normalizePublicKey;
    this.verifySignature = verifySignature;
  }

  register(scope, agentId, input) {
    assertTenantScope(scope);
    if (containsSensitiveInput(input)) return rejectedInput();
    rejectUnknownFields(input, INPUT_FIELDS);
    if (String(input.alg || "") !== "Ed25519") return invalid("unsupported_algorithm", "Only Ed25519 credentials are supported");
    const now = this.clock.now();
    const notBefore = isoInstant(input.not_before, "not_before");
    const expiresAt = isoInstant(input.expires_at, "expires_at");
    if (Date.parse(expiresAt) <= Date.parse(notBefore) || Date.parse(expiresAt) <= now.getTime()) {
      return invalid("invalid_credential_window", "Credential validity window is invalid");
    }
    let publicKey;
    try { publicKey = this.normalizePublicKey(input.public_key); } catch { return rejectedInput(); }
    const challenge = this.random.opaqueToken("acpop", 32);
    const createdAt = now.toISOString();
    const credential = {
      credential_id: this.random.id("credential"),
      merchant_id: scope.merchant_id,
      agent_id: String(agentId || "").trim(),
      kid: kid(input.kid),
      alg: "Ed25519",
      public_key: publicKey,
      status: "pending_proof",
      not_before: notBefore,
      expires_at: expiresAt,
      revoked_at: null,
      revocation_version: 0,
      version: 1,
      created_at: createdAt,
      updated_at: createdAt
    };
    assertCanonicalCredential(credential);
    const result = this.repository.register(scope, credential, {
      challenge_id: this.random.id("acpop"),
      challenge_hash: this.hash(challenge),
      status: "active",
      created_at: createdAt,
      expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString()
    }, this.audit(scope, "agent_credential.registered", credential, createdAt));
    if (result?.reason === "duplicate_kid") return invalid("credential_kid_conflict", "Credential kid already exists", 409);
    if (!result?.credential) return notFound();
    return { ok: true, credential: result.credential, proof_challenge: challenge, proof_expires_at: result.proof_expires_at };
  }

  list(scope, agentId) {
    assertTenantScope(scope);
    const result = this.repository.list(scope, agentId);
    return result ? { ok: true, items: result } : notFound();
  }

  activate(scope, agentId, credentialId, input) {
    assertTenantScope(scope);
    if (containsSensitiveInput(input)) return rejectedInput();
    const fields = new Set(["challenge", "signature"]);
    rejectUnknownFields(input, fields);
    const challenge = String(input?.challenge || "").trim();
    const signature = String(input?.signature || "").trim();
    if (!/^acpop_[A-Za-z0-9_-]{43}$/.test(challenge) || !signature) return invalidProof();
    const now = this.clock.nowIso();
    const target = this.repository.proofTarget(scope, agentId, credentialId, this.hash(challenge), now);
    if (target?.reason === "resource_not_found") return notFound();
    if (!target?.public_key || !this.verifySignature(target.public_key, challenge, signature)) return invalidProof();
    const activated = this.repository.activate(
      scope,
      agentId,
      credentialId,
      this.hash(challenge),
      this.hash(signature),
      now,
      new Date(Date.parse(now) + MAX_ROTATION_OVERLAP_MS).toISOString(),
      this.audit(scope, "agent_credential.activated", { ...target, credential_id: credentialId, agent_id: agentId, merchant_id: scope.merchant_id, status: "active", version: 2 }, now),
      this.audit(scope, "agent_credential.rotation_overlap_started", { ...target, credential_id: credentialId, agent_id: agentId, merchant_id: scope.merchant_id, status: "expiring", version: 0 }, now)
    );
    if (activated?.reason === "active_limit") return invalid("credential_active_limit", "At most two usable credentials are permitted", 409);
    return activated?.credential ? { ok: true, credential: activated.credential, rotated_credential: activated.rotated_credential || null } : invalidProof();
  }

  revoke(scope, agentId, credentialId, input) {
    assertTenantScope(scope);
    const expectedVersion = Number(input?.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return invalid("concurrency_conflict", "Credential version does not match", 409);
    const current = this.repository.get(scope, agentId, credentialId);
    if (!current) return notFound();
    if (current.version !== expectedVersion) return invalid("concurrency_conflict", "Credential version does not match", 409);
    if (["revoked", "expired"].includes(current.status)) return invalid("invalid_credential_transition", "Credential cannot be revoked from its current state", 409);
    const now = this.clock.nowIso();
    const revoked = this.repository.revoke(scope, agentId, credentialId, expectedVersion, now,
      this.audit(scope, "agent_credential.revoked", { ...current, status: "revoked", version: current.version + 1 }, now));
    return revoked ? { ok: true, credential: revoked } : invalid("concurrency_conflict", "Credential changed concurrently", 409);
  }

  sweep() {
    const now = this.clock.now();
    const at = now.toISOString();
    return this.repository.sweepLifecycle(
      at,
      new Date(now.getTime() + EXPIRY_REMINDER_MS).toISOString(),
      (action, credential) => this.audit(null, action, credential, at, { actor_type: "platform_operator" }),
      (credential) => credentialReminderEvent(this.random.id("event"), credential, at)
    );
  }

  audit(scope, action, credential, occurredAt, options = {}) {
    return credentialAuditEvent({
      audit_event_id: this.random.id("audit"),
      scope,
      action,
      credential,
      occurred_at: occurredAt,
      actor_type: options.actor_type || "merchant_user"
    });
  }
}

export class SqliteAgentCredentialRepository {
  constructor(db) {
    if (!db) throw new TypeError("SQLite database is required");
    this.db = db;
    this.ensureSchema();
  }

  ensureSchema() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_credential_proof_challenges (
      challenge_id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      challenge_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'expired')),
      proof_digest TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      FOREIGN KEY (merchant_id, agent_id, credential_id) REFERENCES agent_credentials(merchant_id, agent_id, credential_id)
    );
    CREATE INDEX IF NOT EXISTS agent_credential_proof_tenant_idx
      ON agent_credential_proof_challenges(merchant_id, agent_id, credential_id, status);`);
  }

  register(scope, credential, challenge, auditEvent) {
    assertTenantScope(scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const agent = this.db.prepare("SELECT status FROM agents WHERE merchant_id = ? AND agent_id = ?")
        .get(scope.merchant_id, credential.agent_id);
      if (!agent || agent.status === "revoked") return rollback(this.db, null);
      const duplicate = this.db.prepare("SELECT 1 FROM agent_credentials WHERE merchant_id = ? AND agent_id = ? AND kid = ?")
        .get(scope.merchant_id, credential.agent_id, credential.kid);
      if (duplicate) return rollback(this.db, { reason: "duplicate_kid" });
      this.db.prepare(`INSERT INTO agent_credentials
        (credential_id, merchant_id, agent_id, kid, alg, public_key, status, not_before, expires_at,
         revoked_at, revocation_version, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        credential.credential_id, scope.merchant_id, credential.agent_id, credential.kid, credential.alg,
        credential.public_key, credential.status, credential.not_before, credential.expires_at,
        credential.revoked_at, credential.revocation_version, credential.version, credential.created_at, credential.updated_at
      );
      this.db.prepare(`INSERT INTO agent_credential_proof_challenges
        (challenge_id, merchant_id, agent_id, credential_id, challenge_hash, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        challenge.challenge_id, scope.merchant_id, credential.agent_id, credential.credential_id,
        challenge.challenge_hash, challenge.status, challenge.created_at, challenge.expires_at
      );
      this.insertAudit(auditEvent);
      this.db.exec("COMMIT");
      return { credential: this.get(scope, credential.agent_id, credential.credential_id), proof_expires_at: challenge.expires_at };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  get(scope, agentId, credentialId) {
    assertTenantScope(scope);
    return publicCredential(this.db.prepare(`SELECT * FROM agent_credentials
      WHERE merchant_id = ? AND agent_id = ? AND credential_id = ?`).get(scope.merchant_id, agentId, credentialId));
  }

  list(scope, agentId) {
    assertTenantScope(scope);
    const agent = this.db.prepare("SELECT 1 FROM agents WHERE merchant_id = ? AND agent_id = ?").get(scope.merchant_id, agentId);
    if (!agent) return null;
    return this.db.prepare(`SELECT * FROM agent_credentials WHERE merchant_id = ? AND agent_id = ?
      ORDER BY credential_id`).all(scope.merchant_id, agentId).map(publicCredential);
  }

  proofTarget(scope, agentId, credentialId, challengeHash, now) {
    assertTenantScope(scope);
    const exact = this.db.prepare(`SELECT 1 FROM agent_credentials
      WHERE merchant_id = ? AND agent_id = ? AND credential_id = ?`).get(scope.merchant_id, agentId, credentialId);
    if (!exact) return { reason: "resource_not_found" };
    const credential = this.db.prepare(`SELECT c.public_key, c.status, c.expires_at, p.status AS proof_status, p.expires_at AS proof_expires_at
      FROM agent_credentials c JOIN agent_credential_proof_challenges p ON p.credential_id = c.credential_id
      WHERE c.merchant_id = ? AND c.agent_id = ? AND c.credential_id = ? AND p.challenge_hash = ?`)
      .get(scope.merchant_id, agentId, credentialId, challengeHash);
    if (!credential) return null;
    if (credential.status !== "pending_proof" || credential.proof_status !== "active"
        || credential.proof_expires_at <= now || credential.expires_at <= now) return null;
    return { public_key: credential.public_key };
  }

  activate(scope, agentId, credentialId, challengeHash, proofDigest, at, overlapUntil, activationAudit, rotationAudit) {
    assertTenantScope(scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const usable = this.db.prepare(`SELECT * FROM agent_credentials
        WHERE merchant_id = ? AND agent_id = ? AND credential_id <> ?
          AND status IN ('active', 'expiring') AND expires_at > ? ORDER BY created_at`)
        .all(scope.merchant_id, agentId, credentialId, at);
      if (usable.length >= 2) return rollback(this.db, { reason: "active_limit" });
      const consumed = this.db.prepare(`UPDATE agent_credential_proof_challenges
        SET status = 'consumed', proof_digest = ?, consumed_at = ?
        WHERE merchant_id = ? AND agent_id = ? AND credential_id = ? AND challenge_hash = ?
          AND status = 'active' AND expires_at > ?`)
        .run(proofDigest, at, scope.merchant_id, agentId, credentialId, challengeHash, at);
      if (Number(consumed.changes || 0) !== 1) return rollback(this.db, null);
      const updated = this.db.prepare(`UPDATE agent_credentials SET status = 'active', version = version + 1, updated_at = ?
        WHERE merchant_id = ? AND agent_id = ? AND credential_id = ? AND status = 'pending_proof' AND expires_at > ?`)
        .run(at, scope.merchant_id, agentId, credentialId, at);
      if (Number(updated.changes || 0) !== 1) return rollback(this.db, null);
      let rotatedCredential = null;
      if (usable.length === 1) {
        const previous = usable[0];
        const boundedExpiry = previous.expires_at < overlapUntil ? previous.expires_at : overlapUntil;
        this.db.prepare(`UPDATE agent_credentials SET status = 'expiring', expires_at = ?, version = version + 1, updated_at = ?
          WHERE merchant_id = ? AND agent_id = ? AND credential_id = ? AND version = ?`)
          .run(boundedExpiry, at, scope.merchant_id, agentId, previous.credential_id, previous.version);
        rotatedCredential = publicCredential(this.db.prepare("SELECT * FROM agent_credentials WHERE credential_id = ?")
          .get(previous.credential_id));
        this.insertAudit({
          ...rotationAudit,
          resource_id: previous.credential_id,
          details: {
            ...rotationAudit.details,
            status: "expiring",
            version: rotatedCredential.version,
            overlap_expires_at: boundedExpiry,
            successor_credential_id: credentialId
          }
        });
      }
      this.insertAudit(activationAudit);
      this.db.exec("COMMIT");
      return { credential: this.get(scope, agentId, credentialId), rotated_credential: rotatedCredential };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  revoke(scope, agentId, credentialId, expectedVersion, at, auditEvent) {
    assertTenantScope(scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`UPDATE agent_credentials
        SET status = 'revoked', revoked_at = ?, revocation_version = revocation_version + 1,
          version = version + 1, updated_at = ?
        WHERE merchant_id = ? AND agent_id = ? AND credential_id = ? AND version = ?
          AND status NOT IN ('revoked', 'expired')`)
        .run(at, at, scope.merchant_id, agentId, credentialId, expectedVersion);
      if (Number(result.changes || 0) !== 1) return rollback(this.db, null);
      this.revokeAccessTokens(scope.merchant_id, credentialId, at);
      this.insertAudit(auditEvent);
      this.db.exec("COMMIT");
      return this.get(scope, agentId, credentialId);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  sweepLifecycle(at, reminderBefore, auditFactory, reminderFactory) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const events = [];
      const expired = this.db.prepare(`SELECT * FROM agent_credentials
        WHERE status IN ('active', 'expiring') AND expires_at <= ?`).all(at);
      for (const row of expired) {
        this.db.prepare(`UPDATE agent_credentials SET status = 'expired', revocation_version = revocation_version + 1,
          version = version + 1, updated_at = ? WHERE credential_id = ? AND version = ?`)
          .run(at, row.credential_id, row.version);
        this.revokeAccessTokens(row.merchant_id, row.credential_id, at);
        const credential = publicCredential(this.db.prepare("SELECT * FROM agent_credentials WHERE credential_id = ?").get(row.credential_id));
        this.insertAudit(auditFactory("agent_credential.expired", credential));
      }
      const expiring = this.db.prepare(`SELECT * FROM agent_credentials
        WHERE status = 'active' AND expires_at > ? AND expires_at <= ?`).all(at, reminderBefore);
      for (const row of expiring) {
        this.db.prepare(`UPDATE agent_credentials SET status = 'expiring', version = version + 1, updated_at = ?
          WHERE credential_id = ? AND version = ?`).run(at, row.credential_id, row.version);
        const credential = publicCredential(this.db.prepare("SELECT * FROM agent_credentials WHERE credential_id = ?").get(row.credential_id));
        const event = reminderFactory(credential);
        events.push(event);
        this.insertAudit(auditFactory("agent_credential.expiring", credential));
      }
      this.db.exec("COMMIT");
      return { expired: expired.length, expiring: expiring.length, events };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  revokeAccessTokens(merchantId, credentialId, at) {
    const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_access_tokens'").get();
    if (table) this.db.prepare(`UPDATE agent_access_tokens SET status = 'revoked', revoked_at = ?
      WHERE merchant_id = ? AND credential_id = ? AND status = 'active'`).run(at, merchantId, credentialId);
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

export class MemoryAgentCredentialRepository {
  register() { return null; }
  list() { return null; }
  proofTarget() { return null; }
  activate() { return null; }
  revoke() { return null; }
  sweepLifecycle() { return { expired: 0, expiring: 0, events: [] }; }
}

function publicCredential(row) {
  if (!row) return null;
  const value = { ...row };
  assertCanonicalCredential(value);
  return value;
}

function assertCanonicalCredential(value) {
  const verdict = validateAgentCredential(value);
  if (!verdict.ok) throw new TypeError(`Credential violates canonical control-plane contract: ${verdict.code}`);
}

function containsSensitiveInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  for (const [field, nested] of Object.entries(value)) {
    if (/(?:private|secret|seed|mnemonic)/i.test(field)) return true;
    if (typeof nested === "string" && /PRIVATE KEY|SEED PHRASE|MNEMONIC/i.test(nested)) return true;
  }
  return false;
}

function rejectUnknownFields(input, allowed) {
  const unknown = Object.keys(input || {}).find((field) => !allowed.has(field));
  if (unknown) throw new TypeError("Credential input contains an unsupported field");
}

function kid(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(normalized)) throw new TypeError("kid is invalid");
  return normalized;
}

function isoInstant(value, field) {
  const text = String(value || "").trim();
  if (!text || !Number.isFinite(Date.parse(text))) throw new TypeError(`${field} is invalid`);
  return new Date(text).toISOString();
}

function rollback(db, value) { db.exec("ROLLBACK"); return value; }
function invalid(code, message, status = 400) { return { ok: false, status, code, message }; }
function rejectedInput() { return invalid("credential_input_rejected", "Credential input is not accepted"); }
function invalidProof() { return invalid("credential_proof_invalid", "Credential proof is invalid or expired", 401); }
function notFound() { return invalid("resource_not_found", "Resource not found", 404); }
