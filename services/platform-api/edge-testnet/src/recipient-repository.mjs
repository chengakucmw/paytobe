import { assertTenantScope } from "../../src/ports/tenant-repository.js";

export class D1RecipientRepository {
  constructor(db) {
    if (!db) throw new TypeError("D1 database is required");
    this.db = db;
  }

  async create(scope, recipient, version, auditEvent) {
    assertTenantScope(scope);
    await this.db.batch([
      this.db.prepare(`INSERT INTO recipients
        (recipient_id, merchant_id, name, status, active_version_id, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        recipient.recipient_id, scope.merchant_id, recipient.name, recipient.status, recipient.active_version_id,
        recipient.version, recipient.created_at, recipient.updated_at),
      versionInsert(this.db, scope, version),
      auditInsert(this.db, auditEvent)
    ]);
    return { recipient: await this.get(scope, recipient.recipient_id), recipient_version: await this.getVersion(scope, recipient.recipient_id, version.recipient_version_id) };
  }

  async get(scope, recipientId) {
    assertTenantScope(scope);
    return this.db.prepare("SELECT * FROM recipients WHERE merchant_id = ? AND recipient_id = ?")
      .bind(scope.merchant_id, String(recipientId || "")).first();
  }

  async list(scope, { limit = 50, cursor = "" } = {}) {
    assertTenantScope(scope);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    const result = await this.db.prepare(`SELECT * FROM recipients WHERE merchant_id = ? AND recipient_id > ?
      ORDER BY recipient_id LIMIT ?`).bind(scope.merchant_id, String(cursor || ""), safeLimit + 1).all();
    const rows = result.results || [];
    const more = rows.length > safeLimit;
    const items = rows.slice(0, safeLimit);
    return { items, next_cursor: more ? items.at(-1).recipient_id : "" };
  }

  async update(scope, recipientId, patch, expectedVersion, updatedAt, auditEvent) {
    assertTenantScope(scope);
    const fields = Object.keys(patch);
    const statement = this.db.prepare(`UPDATE recipients SET ${fields.map((field) => `${field} = ?`).join(", ")},
      version = version + 1, updated_at = ? WHERE merchant_id = ? AND recipient_id = ? AND version = ?`)
      .bind(...fields.map((field) => patch[field]), updatedAt, scope.merchant_id, recipientId, expectedVersion);
    const result = await statement.run();
    if (Number(result.meta?.changes || 0) !== 1) return null;
    await auditInsert(this.db, auditEvent).run();
    return this.get(scope, recipientId);
  }

  async createVersion(scope, recipientId, version, expectedVersion, updatedAt, auditEvent) {
    assertTenantScope(scope);
    const changed = await this.db.prepare(`UPDATE recipients SET status = 'pending_verification', version = version + 1,
      updated_at = ? WHERE merchant_id = ? AND recipient_id = ? AND version = ? AND status != 'revoked'`)
      .bind(updatedAt, scope.merchant_id, recipientId, expectedVersion).run();
    if (Number(changed.meta?.changes || 0) !== 1) return null;
    try {
      await this.db.batch([versionInsert(this.db, scope, version), auditInsert(this.db, auditEvent)]);
    } catch (error) {
      await this.db.prepare(`UPDATE recipients SET version = version - 1, updated_at = ?
        WHERE merchant_id = ? AND recipient_id = ? AND version = ?`).bind(updatedAt, scope.merchant_id, recipientId, expectedVersion + 1).run();
      throw error;
    }
    return { recipient: await this.get(scope, recipientId), recipient_version: await this.getVersion(scope, recipientId, version.recipient_version_id) };
  }

  async getVersion(scope, recipientId, versionId) {
    assertTenantScope(scope);
    return this.db.prepare(`SELECT * FROM recipient_versions
      WHERE merchant_id = ? AND recipient_id = ? AND recipient_version_id = ?`)
      .bind(scope.merchant_id, String(recipientId || ""), String(versionId || "")).first();
  }

  async listVersions(scope, recipientId, { limit = 50, cursor = "" } = {}) {
    assertTenantScope(scope);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    const result = await this.db.prepare(`SELECT * FROM recipient_versions
      WHERE merchant_id = ? AND recipient_id = ? AND recipient_version_id > ?
      ORDER BY recipient_version_id LIMIT ?`).bind(scope.merchant_id, recipientId, String(cursor || ""), safeLimit + 1).all();
    const rows = result.results || [];
    const more = rows.length > safeLimit;
    const items = rows.slice(0, safeLimit);
    return { items, next_cursor: more ? items.at(-1).recipient_version_id : "" };
  }
}

function versionInsert(db, scope, value) {
  return db.prepare(`INSERT INTO recipient_versions
    (recipient_version_id, merchant_id, recipient_id, network, asset, address, memo, verification_state, effective_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    value.recipient_version_id, scope.merchant_id, value.recipient_id, value.network, value.asset,
    value.address, value.memo, value.verification_state, value.effective_at, value.created_at
  );
}

function auditInsert(db, value) {
  return db.prepare(`INSERT INTO audit_events
    (audit_event_id, merchant_id, actor_type, actor_id, action, resource_type, resource_id,
     result, request_id, details_json, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    value.audit_event_id, value.merchant_id, value.actor_type, value.actor_id, value.action,
    value.resource_type, value.resource_id, value.result, value.request_id,
    JSON.stringify(value.details), value.occurred_at
  );
}
