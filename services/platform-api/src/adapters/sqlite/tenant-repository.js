import {
  assertTenantScope,
  tenantInsert,
  tenantPatch,
  tenantResourceDefinition
} from "../../ports/tenant-repository.js";

export class SqliteTenantRepository {
  constructor(db) {
    if (!db) throw new TypeError("SQLite database is required");
    this.db = db;
  }

  create(scope, resource, value) {
    const plan = tenantInsert(scope, resource, value);
    const placeholders = plan.columns.map(() => "?").join(", ");
    this.db.prepare(`INSERT INTO ${plan.spec.table} (${plan.columns.join(", ")}) VALUES (${placeholders})`).run(...plan.values);
    return this.get(scope, resource, value[plan.spec.id]);
  }

  get(scope, resource, id) {
    assertTenantScope(scope);
    const spec = tenantResourceDefinition(resource);
    return plain(this.db.prepare(`SELECT * FROM ${spec.table} WHERE merchant_id = ? AND ${spec.id} = ?`).get(scope.merchant_id, id));
  }

  list(scope, resource, { limit = 50, cursor = "" } = {}) {
    assertTenantScope(scope);
    const spec = tenantResourceDefinition(resource);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    const rows = this.db.prepare(`SELECT * FROM ${spec.table}
      WHERE merchant_id = ? AND ${spec.id} > ? ORDER BY ${spec.id} LIMIT ?`).all(scope.merchant_id, String(cursor || ""), safeLimit + 1);
    const more = rows.length > safeLimit;
    const items = rows.slice(0, safeLimit).map(plain);
    return { items, next_cursor: more ? String(items.at(-1)?.[spec.id] || "") : "" };
  }

  count(scope, resource) {
    assertTenantScope(scope);
    const spec = tenantResourceDefinition(resource);
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${spec.table} WHERE merchant_id = ?`).get(scope.merchant_id).count);
  }

  update(scope, resource, id, patch, { expectedVersion } = {}) {
    const plan = tenantPatch(scope, resource, patch);
    const assignments = plan.fields.map((field) => `${field} = ?`);
    const values = [...plan.values];
    if (plan.spec.mutable.has("version") && !plan.fields.includes("version")) assignments.push("version = version + 1");
    values.push(scope.merchant_id, id);
    let where = `merchant_id = ? AND ${plan.spec.id} = ?`;
    if (expectedVersion !== undefined) {
      where += " AND version = ?";
      values.push(expectedVersion);
    }
    const result = this.db.prepare(`UPDATE ${plan.spec.table} SET ${assignments.join(", ")} WHERE ${where}`).run(...values);
    return Number(result.changes || 0) === 1 ? this.get(scope, resource, id) : null;
  }

  delete(scope, resource, id) {
    assertTenantScope(scope);
    const spec = tenantResourceDefinition(resource);
    const result = this.db.prepare(`DELETE FROM ${spec.table} WHERE merchant_id = ? AND ${spec.id} = ?`).run(scope.merchant_id, id);
    return Number(result.changes || 0) === 1;
  }

  findPaymentRequestByIdempotency(scope, key) {
    assertTenantScope(scope);
    const row = this.db.prepare(`SELECT json FROM payment_requests
      WHERE merchant_id = ? AND json_extract(json, '$.idempotency_key') = ? LIMIT 1`).get(scope.merchant_id, key);
    return row ? JSON.parse(row.json) : null;
  }
}

function plain(value) {
  return value ? { ...value } : null;
}
