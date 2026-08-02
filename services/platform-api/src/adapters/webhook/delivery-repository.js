const DELIVERY_COLUMNS = Object.freeze({
  scheduled_at: "TEXT", claimed_at: "TEXT", lease_owner: "TEXT", lease_until: "TEXT", completed_at: "TEXT",
  failure_code: "TEXT", response_status: "INTEGER", response_digest: "TEXT", duration_ms: "INTEGER",
  replay_of_delivery_id: "TEXT"
});

export class SqliteWebhookDeliveryRepository {
  constructor(db) {
    if (!db) throw new TypeError("SQLite database is required");
    this.db = db;
    const columns = new Set(db.prepare("PRAGMA table_info(webhook_deliveries)").all().map((row) => row.name));
    for (const [column, type] of Object.entries(DELIVERY_COLUMNS)) {
      if (!columns.has(column)) db.exec(`ALTER TABLE webhook_deliveries ADD COLUMN ${column} ${type}`);
    }
  }

  enqueueEvent(scope, eventId, createId, at) {
    assertScope(scope);
    const event = this.db.prepare(`SELECT * FROM webhook_events WHERE merchant_id = ? AND event_id = ?`).get(scope.merchant_id, eventId);
    if (!event) return [];
    const endpoints = this.db.prepare(`SELECT * FROM webhook_endpoints WHERE merchant_id = ? AND status = 'active'`)
      .all(scope.merchant_id).filter((endpoint) => parseJson(endpoint.event_types_json, []).includes(event.type));
    const created = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const endpoint of endpoints) {
        const existing = this.db.prepare(`SELECT 1 FROM webhook_deliveries
          WHERE merchant_id = ? AND event_id = ? AND webhook_endpoint_id = ? AND replay_of_delivery_id IS NULL`)
          .get(scope.merchant_id, eventId, endpoint.webhook_endpoint_id);
        if (existing) continue;
        const deliveryId = createId();
        this.insertDelivery({ delivery_id: deliveryId, merchant_id: scope.merchant_id, event_id: eventId,
          webhook_endpoint_id: endpoint.webhook_endpoint_id, attempt: 1, status: "pending", scheduled_at: at,
          next_attempt_at: at, created_at: at, updated_at: at, replay_of_delivery_id: null });
        created.push(deliveryId);
      }
      this.db.exec("COMMIT");
      return created;
    } catch (error) { rollback(this.db); throw error; }
  }

  claimDue(workerId, at, leaseUntil) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT delivery_id FROM webhook_deliveries
        WHERE ((status = 'pending' AND COALESCE(next_attempt_at, scheduled_at, created_at) <= ?)
          OR (status = 'in_flight' AND lease_until <= ?))
        ORDER BY COALESCE(next_attempt_at, scheduled_at, created_at), created_at, delivery_id LIMIT 1`).get(at, at);
      if (!row) return rollbackNull(this.db);
      const changed = this.db.prepare(`UPDATE webhook_deliveries SET status = 'in_flight', claimed_at = ?, lease_owner = ?,
        lease_until = ?, updated_at = ? WHERE delivery_id = ? AND ((status = 'pending' AND COALESCE(next_attempt_at, scheduled_at, created_at) <= ?)
        OR (status = 'in_flight' AND lease_until <= ?))`).run(at, workerId, leaseUntil, at, row.delivery_id, at, at);
      if (Number(changed.changes || 0) !== 1) return rollbackNull(this.db);
      const claimed = this.material(row.delivery_id);
      this.db.exec("COMMIT");
      return claimed;
    } catch (error) { rollback(this.db); throw error; }
  }

  complete(claimed, outcome, at, next = null) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const status = outcome.kind === "delivered" ? "delivered" : outcome.kind === "retry" ? "retryable_failed" : "failed";
      const changed = this.db.prepare(`UPDATE webhook_deliveries SET status = ?, response_status = ?, failure_code = ?,
        response_digest = ?, duration_ms = ?, completed_at = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE delivery_id = ? AND status = 'in_flight' AND lease_owner = ?`)
        .run(status, outcome.response_status || null, outcome.failure_code || null, outcome.response_digest || null,
          outcome.duration_ms || 0, at, at, claimed.delivery_id, claimed.lease_owner);
      if (Number(changed.changes || 0) !== 1) return rollbackNull(this.db);
      if (next) this.insertDelivery(next);
      const completed = this.getById(claimed.merchant_id, claimed.delivery_id);
      this.db.exec("COMMIT");
      return completed;
    } catch (error) { rollback(this.db); throw error; }
  }

  replay(scope, deliveryId, nextDeliveryId, at) {
    assertScope(scope);
    const original = this.getById(scope.merchant_id, deliveryId);
    if (!original) return null;
    const replay = {
      delivery_id: nextDeliveryId,
      merchant_id: scope.merchant_id,
      event_id: original.event_id,
      webhook_endpoint_id: original.webhook_endpoint_id,
      attempt: 1,
      status: "pending",
      scheduled_at: at,
      next_attempt_at: at,
      created_at: at,
      updated_at: at,
      replay_of_delivery_id: deliveryId
    };
    this.insertDelivery(replay);
    return this.getById(scope.merchant_id, nextDeliveryId);
  }

  list(scope, { limit = 100 } = {}) {
    assertScope(scope);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
    return this.db.prepare(`SELECT * FROM webhook_deliveries WHERE merchant_id = ? ORDER BY created_at DESC, delivery_id LIMIT ?`)
      .all(scope.merchant_id, safeLimit).map(publicDelivery);
  }

  get(scope, deliveryId) {
    assertScope(scope);
    const value = this.getById(scope.merchant_id, deliveryId);
    return value ? publicDelivery(value) : null;
  }

  getById(merchantId, deliveryId) {
    const row = this.db.prepare(`SELECT * FROM webhook_deliveries WHERE merchant_id = ? AND delivery_id = ?`).get(merchantId, deliveryId);
    return row ? { ...row } : null;
  }

  material(deliveryId) {
    const row = this.db.prepare(`SELECT d.*, e.type AS event_type, e.payload_json, e.occurred_at,
      w.url, w.current_secret_id, s.ciphertext AS secret_ciphertext
      FROM webhook_deliveries d
      JOIN webhook_events e ON e.event_id = d.event_id AND e.merchant_id = d.merchant_id
      JOIN webhook_endpoints w ON w.webhook_endpoint_id = d.webhook_endpoint_id AND w.merchant_id = d.merchant_id AND w.status = 'active'
      JOIN webhook_endpoint_secrets s ON s.secret_id = w.current_secret_id AND s.merchant_id = d.merchant_id
        AND s.webhook_endpoint_id = w.webhook_endpoint_id AND s.status = 'active'
      WHERE d.delivery_id = ?`).get(deliveryId);
    return row ? { ...row } : null;
  }

  insertDelivery(value) {
    this.db.prepare(`INSERT INTO webhook_deliveries
      (delivery_id, merchant_id, event_id, webhook_endpoint_id, attempt, status, next_attempt_at,
       created_at, updated_at, scheduled_at, replay_of_delivery_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(value.delivery_id, value.merchant_id, value.event_id, value.webhook_endpoint_id, value.attempt,
        value.status, value.next_attempt_at, value.created_at, value.updated_at, value.scheduled_at,
        value.replay_of_delivery_id || null);
  }
}

export class MemoryWebhookDeliveryRepository {
  enqueueEvent() { return []; }
  claimDue() { return null; }
  complete() { return null; }
  replay() { return null; }
  list() { return []; }
  get() { return null; }
}

export function publicDelivery(value) {
  return {
    delivery_id: value.delivery_id,
    event_id: value.event_id,
    webhook_endpoint_id: value.webhook_endpoint_id,
    attempt: Number(value.attempt || 0),
    status: value.status,
    response_status: value.response_status || null,
    failure_code: value.failure_code || null,
    duration_ms: value.duration_ms || 0,
    next_attempt_at: value.next_attempt_at || null,
    scheduled_at: value.scheduled_at || null,
    claimed_at: value.claimed_at || null,
    completed_at: value.completed_at || null,
    replay_of_delivery_id: value.replay_of_delivery_id || null,
    created_at: value.created_at,
    updated_at: value.updated_at
  };
}

function assertScope(scope) { if (!scope || !Object.isFrozen(scope) || !scope.merchant_id) throw new TypeError("Immutable TenantScope is required"); }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function rollback(db) { try { db.exec("ROLLBACK"); } catch { /* no active transaction */ } }
function rollbackNull(db) { db.exec("ROLLBACK"); return null; }
