import { assertTenantScope } from "../../ports/tenant-repository.js";

export class D1WebhookOutbox {
  constructor(db) {
    if (!db) throw new TypeError("D1 database is required");
    this.db = db;
  }

  async commitPaymentStatus(scope, requestId, status, patch, event) {
    assertTenantScope(scope);
    assertEvent(scope, requestId, event);
    const row = await this.db.prepare(`SELECT payload_json FROM payment_requests
      WHERE merchant_id = ? AND request_id = ?`).bind(scope.merchant_id, requestId).first();
    if (!row) return null;
    const payment = JSON.parse(row.payload_json);
    const updated = {
      ...payment,
      status,
      updated_at: event.occurred_at,
      ...(patch?.tx_hash ? { tx_hash: patch.tx_hash } : {}),
      ...(patch?.error ? { error: patch.error } : {})
    };
    await this.db.batch([
      this.db.prepare(`UPDATE payment_requests SET status = ?, payload_json = ?, updated_at = ?, version = version + 1
        WHERE merchant_id = ? AND request_id = ?`)
        .bind(status, JSON.stringify(updated), event.occurred_at, scope.merchant_id, requestId),
      this.db.prepare(`INSERT INTO webhook_events
        (event_id, merchant_id, type, aggregate_id, payload_json, occurred_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(event.event_id, scope.merchant_id, event.type, event.aggregate_id,
          new TextDecoder().decode(event.raw_body), event.occurred_at, event.created_at)
    ]);
    return { payment_request: updated, event: { ...event, raw_body: new Uint8Array(event.raw_body) } };
  }

  async event(scope, eventId) {
    assertTenantScope(scope);
    const row = await this.db.prepare(`SELECT * FROM webhook_events WHERE merchant_id = ? AND event_id = ?`)
      .bind(scope.merchant_id, eventId).first();
    return row ? { ...row, raw_body: new TextEncoder().encode(row.payload_json) } : null;
  }
}

function assertEvent(scope, requestId, event) {
  if (!event || event.merchant_id !== scope.merchant_id || event.aggregate_id !== requestId || !(event.raw_body instanceof Uint8Array)) {
    throw new TypeError("Tenant-bound Webhook outbox event is required");
  }
}
