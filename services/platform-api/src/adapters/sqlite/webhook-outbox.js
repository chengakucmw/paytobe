import { assertTenantScope } from "../../ports/tenant-repository.js";

export class SqliteWebhookOutbox {
  constructor(db) {
    if (!db) throw new TypeError("SQLite database is required");
    this.db = db;
  }

  commitPaymentStatus(scope, requestId, status, patch, event) {
    assertTenantScope(scope);
    assertEvent(scope, requestId, event);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT json FROM payment_requests
        WHERE json_extract(json, '$.merchant_id') = ? AND k = ?`).get(scope.merchant_id, requestId);
      if (!row) return rollbackNull(this.db);
      const payment = JSON.parse(row.json);
      const updated = {
        ...payment,
        status,
        updated_at: event.occurred_at,
        history: [
          ...(Array.isArray(payment.history) ? payment.history : []),
          {
            status,
            tx_hash: patch?.tx_hash || null,
            error: patch?.error || null,
            at: event.occurred_at
          }
        ],
        ...(patch?.tx_hash ? { tx_hash: patch.tx_hash } : {}),
        ...(patch?.error ? { error: patch.error } : {})
      };
      const changed = this.db.prepare(`UPDATE payment_requests SET json = ?, version = version + 1
        WHERE json_extract(json, '$.merchant_id') = ? AND k = ?`).run(JSON.stringify(updated), scope.merchant_id, requestId);
      if (Number(changed.changes || 0) !== 1) return rollbackNull(this.db);
      this.db.prepare(`INSERT INTO webhook_events
        (event_id, merchant_id, type, aggregate_id, payload_json, occurred_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(event.event_id, scope.merchant_id, event.type, event.aggregate_id,
          new TextDecoder().decode(event.raw_body), event.occurred_at, event.created_at);
      this.db.exec("COMMIT");
      return { payment_request: updated, event: storedEvent(event) };
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  event(scope, eventId) {
    assertTenantScope(scope);
    const row = this.db.prepare(`SELECT * FROM webhook_events WHERE merchant_id = ? AND event_id = ?`)
      .get(scope.merchant_id, eventId);
    return row ? { ...row, raw_body: new TextEncoder().encode(row.payload_json) } : null;
  }
}

function assertEvent(scope, requestId, event) {
  if (!event || event.merchant_id !== scope.merchant_id || event.aggregate_id !== requestId || !(event.raw_body instanceof Uint8Array)) {
    throw new TypeError("Tenant-bound Webhook outbox event is required");
  }
}
function storedEvent(event) { return { ...event, raw_body: new Uint8Array(event.raw_body) }; }
function rollback(db) { try { db.exec("ROLLBACK"); } catch { /* no active transaction */ } }
function rollbackNull(db) { db.exec("ROLLBACK"); return null; }
