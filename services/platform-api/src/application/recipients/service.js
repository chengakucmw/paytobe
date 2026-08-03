import { validateRecipient } from "../../../../../packages/protocol/src/control-plane.js";
import { normalizeRecipientVersionV1 } from "../../../../../packages/protocol/src/recipient-validation.js";
import { createHash } from "node:crypto";
import { recipientAuditEvent, recipientOwnerNotificationEvent } from "../audit/recipient-events.js";
import { assertTenantScope } from "../../ports/tenant-repository.js";

const RECIPIENT_COOLING_MS = 24 * 60 * 60 * 1000;
const STELLAR_TESTNET_RECIPIENT_COOLING_MS = 0;

const RECIPIENT_TRANSITIONS = Object.freeze({
  draft: new Set(["pending_verification", "revoked"]),
  pending_verification: new Set(["active", "suspended", "revoked"]),
  active: new Set(["suspended", "revoked"]),
  suspended: new Set(["pending_verification", "active", "revoked"]),
  revoked: new Set()
});
const CREATE_FIELDS = new Set(["name", "rail", "network", "asset", "address", "contract", "token_contract", "issuer", "memo", "tag"]);
const UPDATE_FIELDS = new Set(["name", "status", "version"]);
const VERSION_FIELDS = new Set(["rail", "network", "asset", "address", "contract", "token_contract", "issuer", "memo", "tag", "version"]);

export class RecipientService {
  constructor({ repository, clock, random, hash = defaultHash, evidenceVerifier, normalizeFacts = normalizeRecipientFacts }) {
    for (const [name, value] of Object.entries({ repository, clock, random, hash, normalizeFacts })) {
      if (!value) throw new TypeError(`Recipient ${name} dependency is required`);
    }
    this.repository = repository;
    this.clock = clock;
    this.random = random;
    this.hash = hash;
    this.evidenceVerifier = evidenceVerifier || { verify: () => invalid("recipient_evidence_unavailable", "Recipient evidence verification is unavailable", 503) };
    this.normalizeFacts = normalizeFacts;
  }

  async create(scope, input) {
    assertTenantScope(scope);
    if (hasSelfDeclaredIdentity(input)) return notFound();
    rejectUnknownFields(input, CREATE_FIELDS);
    const now = this.clock.nowIso();
    const recipientId = this.random.id("recipient");
    const versionId = this.random.id("recipient_version");
    const recipient = {
      recipient_id: recipientId,
      merchant_id: scope.merchant_id,
      name: requiredText(input?.name, "name", 120),
      status: "draft",
      active_version_id: null,
      version: 1,
      created_at: now,
      updated_at: now
    };
    assertCanonicalRecipient(recipient);
    const recipientVersion = versionRecord(scope, recipientId, versionId, this.normalizeFacts(input), now, this.hash);
    const notification = recipientOwnerNotificationEvent(this.random.id("notification"), scope, recipientId, versionId,
      recipientVersion.cooling_until, now);
    const created = await this.repository.create(scope, recipient, recipientVersion,
      audit(scope, this.random.id("audit"), "recipient.created", recipient, now, { recipient_version_id: versionId }), notification);
    return { ok: true, recipient: created.recipient, recipient_version: created.recipient_version };
  }

  async get(scope, recipientId) {
    assertTenantScope(scope);
    const recipient = await this.repository.get(scope, recipientId);
    return recipient ? { ok: true, recipient } : notFound();
  }

  async list(scope, options = {}) {
    assertTenantScope(scope);
    return { ok: true, ...(await this.repository.list(scope, options)) };
  }

  async update(scope, recipientId, input) {
    assertTenantScope(scope);
    if (hasSelfDeclaredIdentity(input) || hasPaymentFacts(input)) return notFound();
    rejectUnknownFields(input, UPDATE_FIELDS);
    const current = await this.repository.get(scope, recipientId);
    if (!current) return notFound();
    const expectedVersion = positiveVersion(input?.version);
    if (current.version !== expectedVersion) return conflict();
    if (current.status === "revoked") return invalid("recipient_revoked", "Revoked Recipients cannot be changed", 409);

    const patch = {};
    if (input.name !== undefined) patch.name = requiredText(input.name, "name", 120);
    if (input.status !== undefined && input.status !== current.status) {
      const nextStatus = String(input.status || "").trim();
      if (!RECIPIENT_TRANSITIONS[current.status]?.has(nextStatus)) {
        return invalid("invalid_recipient_transition", "Recipient status transition is not allowed", 409);
      }
      patch.status = nextStatus;
      if (["suspended", "revoked"].includes(nextStatus)) patch.active_version_id = null;
    }
    if (!Object.keys(patch).length) return { ok: true, recipient: current };
    const now = this.clock.nowIso();
    const candidate = { ...current, ...patch, version: current.version + 1, updated_at: now };
    assertCanonicalRecipient(candidate);
    const updated = await this.repository.update(scope, recipientId, patch, expectedVersion, now,
      audit(scope, this.random.id("audit"), patch.status ? "recipient.status_changed" : "recipient.updated", candidate, now,
        { previous_status: current.status }));
    return updated ? { ok: true, recipient: updated } : conflict();
  }

  async createVersion(scope, recipientId, input) {
    assertTenantScope(scope);
    if (hasSelfDeclaredIdentity(input)) return notFound();
    rejectUnknownFields(input, VERSION_FIELDS);
    const current = await this.repository.get(scope, recipientId);
    if (!current) return notFound();
    if (current.status === "revoked") return invalid("recipient_revoked", "Revoked Recipients cannot receive new versions", 409);
    const expectedVersion = positiveVersion(input?.version);
    if (current.version !== expectedVersion) return conflict();
    const now = this.clock.nowIso();
    const recipientVersion = versionRecord(scope, recipientId, this.random.id("recipient_version"), this.normalizeFacts(input), now, this.hash);
    const notification = recipientOwnerNotificationEvent(this.random.id("notification"), scope, recipientId,
      recipientVersion.recipient_version_id, recipientVersion.cooling_until, now);
    const created = await this.repository.createVersion(scope, recipientId, recipientVersion, expectedVersion, now,
      audit(scope, this.random.id("audit"), "recipient.version_created", current, now,
        { recipient_version_id: recipientVersion.recipient_version_id }), notification);
    return created ? { ok: true, recipient: created.recipient, recipient_version: created.recipient_version } : conflict();
  }

  async listVersions(scope, recipientId, options = {}) {
    assertTenantScope(scope);
    if (!(await this.repository.get(scope, recipientId))) return notFound();
    return { ok: true, ...(await this.repository.listVersions(scope, recipientId, options)) };
  }

  async getVersion(scope, recipientId, versionId) {
    assertTenantScope(scope);
    const version = await this.repository.getVersion(scope, recipientId, versionId);
    return version ? { ok: true, recipient_version: version } : notFound();
  }

  async pinVersionForPayment(scope, recipientId, versionId) {
    const result = await this.getVersion(scope, recipientId, versionId);
    if (!result.ok) return result;
    return { ok: true, recipient_snapshot: immutablePaymentFacts(result.recipient_version) };
  }

  async verify(scope, recipientId, input) {
    assertTenantScope(scope);
    rejectUnknownFields(input, new Set(["recipient_version_id", "type", "source_id", "evidence_digest", "version"]));
    const recipient = await this.repository.get(scope, recipientId);
    if (!recipient) return notFound();
    if (["suspended", "revoked"].includes(recipient.status)) {
      return invalid("recipient_not_verifiable", "Suspended or revoked Recipients cannot be verified", 409);
    }
    const expectedVersion = positiveVersion(input.version);
    if (recipient.version !== expectedVersion) return conflict();
    const recipientVersion = await this.repository.getVersion(scope, recipientId, input.recipient_version_id);
    if (!recipientVersion) return notFound();
    const now = this.clock.nowIso();
    if (now < recipientVersion.created_at || now < recipientVersion.cooling_started_at) {
      return invalid("clock_rollback_detected", "Trusted Clock moved before Recipient version creation", 409);
    }
    const verified = await this.evidenceVerifier.verify(scope, recipientVersion, input, now);
    if (!verified.ok) return verified;
    const factsDigest = digestFacts(this.hash, recipientVersion);
    if (verified.source.facts_digest !== factsDigest) {
      return invalid("recipient_evidence_facts_mismatch", "Evidence does not bind the current Recipient facts", 409);
    }
    if (input.evidence_digest && input.evidence_digest !== verified.source.evidence_digest) {
      return invalid("recipient_evidence_digest_mismatch", "Evidence digest does not match the trusted source", 409);
    }
    const evidence = {
      evidence_id: this.random.id("recipient_evidence"),
      merchant_id: scope.merchant_id,
      recipient_id: recipientId,
      recipient_version_id: recipientVersion.recipient_version_id,
      type: verified.source.type,
      source_id: verified.source.source_id,
      evidence_digest: verified.source.evidence_digest,
      facts_digest: verified.source.facts_digest,
      status: "valid",
      verified_at: verified.source.verified_at,
      expires_at: verified.source.expires_at || null,
      created_at: now
    };
    const updated = await this.repository.attachEvidence(scope, recipient, recipientVersion, evidence, expectedVersion, now,
      audit(scope, this.random.id("audit"), "recipient.verified", recipient, now, {
        recipient_version_id: recipientVersion.recipient_version_id,
        evidence_id: evidence.evidence_id,
        evidence_type: evidence.type
      }));
    return updated ? { ok: true, ...updated } : conflict();
  }

  async activate(scope, recipientId, input) {
    assertTenantScope(scope);
    rejectUnknownFields(input, new Set(["recipient_version_id", "evidence_id", "evidence_digest", "version"]));
    const recipient = await this.repository.get(scope, recipientId);
    if (!recipient) return notFound();
    if (["suspended", "revoked"].includes(recipient.status)) return invalid("recipient_not_usable", "Recipient cannot be activated", 409);
    const expectedVersion = positiveVersion(input.version);
    if (recipient.version !== expectedVersion) return conflict();
    const recipientVersion = await this.repository.getVersion(scope, recipientId, input.recipient_version_id);
    if (!recipientVersion) return notFound();
    const now = this.clock.nowIso();
    if (!(await this.repository.advanceClock(scope, recipientId, recipientVersion.recipient_version_id, now))) {
      return invalid("clock_rollback_detected", "Trusted Clock moved backwards during Recipient activation", 409);
    }
    if (now < recipientVersion.cooling_until) {
      return invalid("recipient_cooling_active", "Recipient version is still in the mandatory cooling period", 409);
    }
    const evidence = await this.repository.getEvidence(scope, recipientId, recipientVersion.recipient_version_id, input.evidence_id);
    if (!evidence) return notFound();
    if (evidence.status !== "valid" || (evidence.expires_at && evidence.expires_at <= now)) {
      return invalid("recipient_evidence_expired", "Recipient evidence is no longer valid", 409);
    }
    const factsDigest = digestFacts(this.hash, recipientVersion);
    if (!input.evidence_digest || input.evidence_digest !== evidence.evidence_digest || evidence.facts_digest !== factsDigest
        || recipientVersion.facts_digest !== factsDigest) {
      return invalid("recipient_evidence_digest_mismatch", "Recipient evidence does not match the version facts", 409);
    }
    const activated = await this.repository.activate(scope, recipient, recipientVersion, evidence, expectedVersion, now,
      audit(scope, this.random.id("audit"), "recipient.activated", recipient, now, {
        recipient_version_id: recipientVersion.recipient_version_id,
        evidence_id: evidence.evidence_id
      }));
    return activated ? { ok: true, ...activated } : conflict();
  }

  async usableForNewRequest(scope, recipientId, versionId = "") {
    assertTenantScope(scope);
    const recipient = await this.repository.get(scope, recipientId);
    if (!recipient || recipient.status !== "active" || !recipient.active_version_id) return notFound();
    const selected = versionId || recipient.active_version_id;
    if (selected !== recipient.active_version_id) return notFound();
    const version = await this.repository.getVersion(scope, recipientId, selected);
    if (!version || version.verification_state !== "active") return notFound();
    return { ok: true, recipient, recipient_version: version };
  }
}

export class SqliteRecipientRepository {
  constructor(db) {
    if (!db) throw new TypeError("SQLite database is required");
    this.db = db;
    this.ensureVerificationSchema();
  }

  ensureVerificationSchema() {
    const columns = new Set(this.db.prepare("PRAGMA table_info(recipient_versions)").all().map((row) => row.name));
    const additions = {
      facts_digest: "TEXT",
      cooling_started_at: "TEXT",
      cooling_until: "TEXT",
      last_evaluated_at: "TEXT",
      activated_at: "TEXT"
    };
    for (const [column, type] of Object.entries(additions)) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE recipient_versions ADD COLUMN ${column} ${type}`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS recipient_verification_sources (
      source_id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('domain_proof', 'address_control', 'reviewed_operational')),
      status TEXT NOT NULL CHECK (status IN ('verified', 'revoked', 'expired')),
      evidence_digest TEXT NOT NULL,
      facts_digest TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (merchant_id, source_id),
      FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id)
    );
    CREATE INDEX IF NOT EXISTS recipient_verification_sources_tenant_idx
      ON recipient_verification_sources(merchant_id, type, status, source_id);
    CREATE TABLE IF NOT EXISTS recipient_verification_evidence (
      evidence_id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      recipient_version_id TEXT NOT NULL,
      type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,
      facts_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('valid', 'revoked', 'expired')),
      verified_at TEXT NOT NULL,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (merchant_id, recipient_id, recipient_version_id, evidence_id),
      FOREIGN KEY (merchant_id, recipient_id) REFERENCES recipients(merchant_id, recipient_id),
      FOREIGN KEY (recipient_version_id) REFERENCES recipient_versions(recipient_version_id)
    );
    CREATE INDEX IF NOT EXISTS recipient_verification_evidence_tenant_idx
      ON recipient_verification_evidence(merchant_id, recipient_id, recipient_version_id, status);
    CREATE TABLE IF NOT EXISTS recipient_owner_notifications (
      notification_id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      audience_role TEXT NOT NULL CHECK (audience_role = 'owner'),
      type TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      recipient_version_id TEXT NOT NULL,
      cooling_until TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
      created_at TEXT NOT NULL,
      FOREIGN KEY (merchant_id, recipient_id) REFERENCES recipients(merchant_id, recipient_id)
    );
    CREATE INDEX IF NOT EXISTS recipient_owner_notifications_tenant_idx
      ON recipient_owner_notifications(merchant_id, status, created_at);`);
  }

  create(scope, recipient, recipientVersion, auditEvent, notification) {
    assertTenantScope(scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO recipients
        (recipient_id, merchant_id, name, status, active_version_id, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        recipient.recipient_id, scope.merchant_id, recipient.name, recipient.status, recipient.active_version_id,
        recipient.version, recipient.created_at, recipient.updated_at
      );
      this.insertVersion(scope, recipientVersion);
      this.insertAudit(auditEvent);
      this.insertNotification(notification);
      this.db.exec("COMMIT");
      return { recipient: this.get(scope, recipient.recipient_id), recipient_version: this.getVersion(scope, recipient.recipient_id, recipientVersion.recipient_version_id) };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  get(scope, recipientId) {
    assertTenantScope(scope);
    return plain(this.db.prepare("SELECT * FROM recipients WHERE merchant_id = ? AND recipient_id = ?")
      .get(scope.merchant_id, String(recipientId || "")));
  }

  list(scope, { limit = 50, cursor = "" } = {}) {
    assertTenantScope(scope);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    const rows = this.db.prepare(`SELECT * FROM recipients WHERE merchant_id = ? AND recipient_id > ?
      ORDER BY recipient_id LIMIT ?`).all(scope.merchant_id, String(cursor || ""), safeLimit + 1);
    const more = rows.length > safeLimit;
    const items = rows.slice(0, safeLimit).map(plain);
    return { items, next_cursor: more ? items.at(-1).recipient_id : "" };
  }

  update(scope, recipientId, patch, expectedVersion, updatedAt, auditEvent) {
    assertTenantScope(scope);
    const fields = Object.keys(patch);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`UPDATE recipients SET ${fields.map((field) => `${field} = ?`).join(", ")},
        version = version + 1, updated_at = ? WHERE merchant_id = ? AND recipient_id = ? AND version = ?`)
        .run(...fields.map((field) => patch[field]), updatedAt, scope.merchant_id, recipientId, expectedVersion);
      if (Number(result.changes || 0) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.insertAudit(auditEvent);
      this.db.exec("COMMIT");
      return this.get(scope, recipientId);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  createVersion(scope, recipientId, recipientVersion, expectedVersion, updatedAt, auditEvent, notification) {
    assertTenantScope(scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db.prepare(`UPDATE recipients SET status = 'pending_verification', version = version + 1,
        updated_at = ? WHERE merchant_id = ? AND recipient_id = ? AND version = ? AND status != 'revoked'`)
        .run(updatedAt, scope.merchant_id, recipientId, expectedVersion);
      if (Number(changed.changes || 0) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.insertVersion(scope, recipientVersion);
      this.insertAudit(auditEvent);
      this.insertNotification(notification);
      this.db.exec("COMMIT");
      return { recipient: this.get(scope, recipientId), recipient_version: this.getVersion(scope, recipientId, recipientVersion.recipient_version_id) };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  getVersion(scope, recipientId, versionId) {
    assertTenantScope(scope);
    return plain(this.db.prepare(`SELECT * FROM recipient_versions
      WHERE merchant_id = ? AND recipient_id = ? AND recipient_version_id = ?`)
      .get(scope.merchant_id, String(recipientId || ""), String(versionId || "")));
  }

  listVersions(scope, recipientId, { limit = 50, cursor = "" } = {}) {
    assertTenantScope(scope);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    const rows = this.db.prepare(`SELECT * FROM recipient_versions
      WHERE merchant_id = ? AND recipient_id = ? AND recipient_version_id > ?
      ORDER BY recipient_version_id LIMIT ?`).all(scope.merchant_id, recipientId, String(cursor || ""), safeLimit + 1);
    const more = rows.length > safeLimit;
    const items = rows.slice(0, safeLimit).map(plain);
    return { items, next_cursor: more ? items.at(-1).recipient_version_id : "" };
  }

  attachEvidence(scope, recipient, version, evidence, expectedVersion, now, auditEvent) {
    assertTenantScope(scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const parent = this.db.prepare(`UPDATE recipients SET status = 'pending_verification', version = version + 1,
        updated_at = ? WHERE merchant_id = ? AND recipient_id = ? AND version = ? AND status NOT IN ('suspended', 'revoked')`)
        .run(now, scope.merchant_id, recipient.recipient_id, expectedVersion);
      if (Number(parent.changes || 0) !== 1) return rollbackNull(this.db);
      const changed = this.db.prepare(`UPDATE recipient_versions SET verification_state = 'verified_cooling',
        last_evaluated_at = ? WHERE merchant_id = ? AND recipient_id = ? AND recipient_version_id = ?
        AND verification_state IN ('unverified', 'pending_verification')`).run(
        now, scope.merchant_id, recipient.recipient_id, version.recipient_version_id
      );
      if (Number(changed.changes || 0) !== 1) return rollbackNull(this.db);
      this.db.prepare(`INSERT INTO recipient_verification_evidence
        (evidence_id, merchant_id, recipient_id, recipient_version_id, type, source_id, evidence_digest,
         facts_digest, status, verified_at, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        evidence.evidence_id, scope.merchant_id, evidence.recipient_id, evidence.recipient_version_id,
        evidence.type, evidence.source_id, evidence.evidence_digest, evidence.facts_digest, evidence.status,
        evidence.verified_at, evidence.expires_at, evidence.created_at
      );
      this.insertAudit(auditEvent);
      this.db.exec("COMMIT");
      return {
        recipient: this.get(scope, recipient.recipient_id),
        recipient_version: this.getVersion(scope, recipient.recipient_id, version.recipient_version_id),
        evidence: this.getEvidence(scope, recipient.recipient_id, version.recipient_version_id, evidence.evidence_id)
      };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  getEvidence(scope, recipientId, versionId, evidenceId) {
    assertTenantScope(scope);
    return plain(this.db.prepare(`SELECT * FROM recipient_verification_evidence
      WHERE merchant_id = ? AND recipient_id = ? AND recipient_version_id = ? AND evidence_id = ?`)
      .get(scope.merchant_id, recipientId, versionId, String(evidenceId || "")));
  }

  advanceClock(scope, recipientId, versionId, now) {
    assertTenantScope(scope);
    const result = this.db.prepare(`UPDATE recipient_versions SET last_evaluated_at = ?
      WHERE merchant_id = ? AND recipient_id = ? AND recipient_version_id = ?
      AND (last_evaluated_at IS NULL OR last_evaluated_at <= ?)`).run(now, scope.merchant_id, recipientId, versionId, now);
    return Number(result.changes || 0) === 1;
  }

  activate(scope, recipient, version, evidence, expectedVersion, now, auditEvent) {
    assertTenantScope(scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const parent = this.db.prepare(`UPDATE recipients SET status = 'active', active_version_id = ?,
        version = version + 1, updated_at = ? WHERE merchant_id = ? AND recipient_id = ? AND version = ?
        AND status NOT IN ('suspended', 'revoked')`).run(
        version.recipient_version_id, now, scope.merchant_id, recipient.recipient_id, expectedVersion
      );
      if (Number(parent.changes || 0) !== 1) return rollbackNull(this.db);
      this.db.prepare(`UPDATE recipient_versions SET verification_state = 'superseded'
        WHERE merchant_id = ? AND recipient_id = ? AND verification_state = 'active'
        AND recipient_version_id != ?`).run(scope.merchant_id, recipient.recipient_id, version.recipient_version_id);
      const changed = this.db.prepare(`UPDATE recipient_versions SET verification_state = 'active', activated_at = ?,
        last_evaluated_at = ? WHERE merchant_id = ? AND recipient_id = ? AND recipient_version_id = ?
        AND verification_state = 'verified_cooling' AND facts_digest = ?`).run(
        now, now, scope.merchant_id, recipient.recipient_id, version.recipient_version_id, evidence.facts_digest
      );
      if (Number(changed.changes || 0) !== 1) return rollbackNull(this.db);
      this.insertAudit(auditEvent);
      this.db.exec("COMMIT");
      return {
        recipient: this.get(scope, recipient.recipient_id),
        recipient_version: this.getVersion(scope, recipient.recipient_id, version.recipient_version_id)
      };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  insertVersion(scope, value) {
    this.db.prepare(`INSERT INTO recipient_versions
      (recipient_version_id, merchant_id, recipient_id, network, asset, address, memo, verification_state, effective_at,
       created_at, facts_digest, cooling_started_at, cooling_until, last_evaluated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      value.recipient_version_id, scope.merchant_id, value.recipient_id, value.network, value.asset,
      value.address, value.memo, value.verification_state, value.effective_at, value.created_at,
      value.facts_digest, value.cooling_started_at, value.cooling_until, value.last_evaluated_at
    );
  }

  insertNotification(value) {
    this.db.prepare(`INSERT INTO recipient_owner_notifications
      (notification_id, merchant_id, audience_role, type, recipient_id, recipient_version_id,
       cooling_until, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      value.notification_id, value.merchant_id, value.audience_role, value.type, value.recipient_id,
      value.recipient_version_id, value.cooling_until, value.status, value.created_at
    );
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

export class MemoryRecipientRepository {
  create() { return { recipient: null, recipient_version: null }; }
  get() { return null; }
  list() { return { items: [], next_cursor: "" }; }
  update() { return null; }
  createVersion() { return null; }
  getVersion() { return null; }
  listVersions() { return { items: [], next_cursor: "" }; }
  attachEvidence() { return null; }
  getEvidence() { return null; }
  advanceClock() { return false; }
  activate() { return null; }
}

export { RECIPIENT_TRANSITIONS };

export function normalizeRecipientFacts(input) {
  const result = normalizeRecipientVersionV1(input);
  if (!result.ok) throw Object.assign(new TypeError(result.error.message), { code: result.error.code, field: result.error.field });
  return Object.freeze({
    network: result.value.network,
    asset: result.value.asset,
    address: result.value.address,
    memo: result.value.memo
  });
}

function versionRecord(scope, recipientId, versionId, facts, now, hash) {
  const coolingUntil = new Date(Date.parse(now) + recipientCoolingMs(facts)).toISOString();
  return {
    recipient_version_id: versionId,
    merchant_id: scope.merchant_id,
    recipient_id: recipientId,
    ...facts,
    verification_state: "unverified",
    effective_at: coolingUntil,
    created_at: now,
    facts_digest: digestFacts(hash, facts),
    cooling_started_at: now,
    cooling_until: coolingUntil,
    last_evaluated_at: now
  };
}

function recipientCoolingMs(facts) {
  return facts.network === "stellar_testnet" ? STELLAR_TESTNET_RECIPIENT_COOLING_MS : RECIPIENT_COOLING_MS;
}

function immutablePaymentFacts(value) {
  return deepFreeze({
    recipient_id: value.recipient_id,
    recipient_version_id: value.recipient_version_id,
    network: value.network,
    asset: value.asset,
    address: value.address,
    memo: value.memo
  });
}

function assertCanonicalRecipient(value) {
  const verdict = validateRecipient(value);
  if (!verdict.ok) throw new TypeError(`Recipient violates canonical control-plane contract: ${verdict.error.code}`);
}

function audit(scope, id, action, recipient, at, extra = {}) {
  return recipientAuditEvent({ audit_event_id: id, scope, action, recipient, occurred_at: at, details: extra });
}

function hasSelfDeclaredIdentity(input) {
  return ["merchant_id", "tenant_id", "recipient_id", "recipient_version_id"].some((field) => Object.hasOwn(input || {}, field));
}
function hasPaymentFacts(input) {
  return ["network", "asset", "address", "memo", "tag", "contract", "issuer"].some((field) => Object.hasOwn(input || {}, field));
}
function rejectUnknownFields(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Recipient input must be an object");
  const unknown = Object.keys(input).find((field) => !allowed.has(field));
  if (unknown) throw new TypeError(`Unsupported Recipient field: ${unknown}`);
}
function positiveVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw new TypeError("version must be a positive integer");
  return version;
}
function requiredText(value, field, max) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > max) throw new TypeError(`${field} is invalid`);
  return normalized;
}
function plain(value) { return value ? { ...value } : null; }
function digestFacts(hash, value) {
  return hash(JSON.stringify([value.network, value.asset, value.address, value.memo ?? null]));
}
function defaultHash(value) { return createHash("sha256").update(String(value)).digest("hex"); }
function rollbackNull(db) { db.exec("ROLLBACK"); return null; }
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
function invalid(code, message, status = 400) { return { ok: false, status, code, message }; }
function notFound() { return invalid("resource_not_found", "Resource not found", 404); }
function conflict() { return invalid("concurrency_conflict", "Recipient version does not match", 409); }

export { RECIPIENT_COOLING_MS };
