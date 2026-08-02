import {
  assertTenantScope,
  tenantInsert,
  tenantPatch,
  tenantResourceDefinition
} from "../../ports/tenant-repository.js";

export class D1TenantRepository {
  constructor(db) {
    if (!db) throw new TypeError("D1 database is required");
    this.db = db;
  }

  async create(scope, resource, value) {
    const plan = tenantInsert(scope, resource, value);
    const placeholders = plan.columns.map(() => "?").join(", ");
    await this.db.prepare(`INSERT INTO ${plan.spec.table} (${plan.columns.join(", ")}) VALUES (${placeholders})`).bind(...plan.values).run();
    return this.get(scope, resource, value[plan.spec.id]);
  }

  async get(scope, resource, id) {
    assertTenantScope(scope);
    const spec = tenantResourceDefinition(resource);
    return this.db.prepare(`SELECT * FROM ${spec.table} WHERE merchant_id = ? AND ${spec.id} = ?`).bind(scope.merchant_id, id).first();
  }

  async list(scope, resource, { limit = 50, cursor = "" } = {}) {
    assertTenantScope(scope);
    const spec = tenantResourceDefinition(resource);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    const result = await this.db.prepare(`SELECT * FROM ${spec.table}
      WHERE merchant_id = ? AND ${spec.id} > ? ORDER BY ${spec.id} LIMIT ?`).bind(scope.merchant_id, String(cursor || ""), safeLimit + 1).all();
    const rows = result.results || [];
    const more = rows.length > safeLimit;
    const items = rows.slice(0, safeLimit);
    return { items, next_cursor: more ? String(items.at(-1)?.[spec.id] || "") : "" };
  }

  async count(scope, resource) {
    assertTenantScope(scope);
    const spec = tenantResourceDefinition(resource);
    const row = await this.db.prepare(`SELECT COUNT(*) AS count FROM ${spec.table} WHERE merchant_id = ?`).bind(scope.merchant_id).first();
    return Number(row?.count || 0);
  }

  async update(scope, resource, id, patch, { expectedVersion } = {}) {
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
    const result = await this.db.prepare(`UPDATE ${plan.spec.table} SET ${assignments.join(", ")} WHERE ${where}`).bind(...values).run();
    return Number(result.meta?.changes || 0) === 1 ? this.get(scope, resource, id) : null;
  }

  async delete(scope, resource, id) {
    assertTenantScope(scope);
    const spec = tenantResourceDefinition(resource);
    const result = await this.db.prepare(`DELETE FROM ${spec.table} WHERE merchant_id = ? AND ${spec.id} = ?`).bind(scope.merchant_id, id).run();
    return Number(result.meta?.changes || 0) === 1;
  }

  async findPaymentRequestByIdempotency(scope, key) {
    assertTenantScope(scope);
    const row = await this.db.prepare(`SELECT payload_json FROM payment_requests
      WHERE merchant_id = ? AND idempotency_key = ? LIMIT 1`).bind(scope.merchant_id, key).first();
    return row ? JSON.parse(row.payload_json) : null;
  }
}
