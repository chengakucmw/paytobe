export const WEBHOOK_EVENT_VERSION = "Paytobe.webhook_event.v1";

export function createWebhookEventEnvelope({ event_id, merchant_id, type, occurred_at, data }) {
  const envelope = {
    version: WEBHOOK_EVENT_VERSION,
    event_id: required(event_id, "event_id"),
    merchant_id: required(merchant_id, "merchant_id"),
    type: required(type, "type"),
    occurred_at: required(occurred_at, "occurred_at"),
    data: data && typeof data === "object" && !Array.isArray(data) ? structuredClone(data) : {}
  };
  return Object.freeze({
    envelope: deepFreeze(envelope),
    raw_body: new TextEncoder().encode(JSON.stringify(envelope))
  });
}

export function webhookEventRecord(scope, event) {
  assertScope(scope);
  if (!event?.envelope || !(event.raw_body instanceof Uint8Array)) throw new TypeError("Webhook event envelope and raw bytes are required");
  if (event.envelope.merchant_id !== scope.merchant_id) throw new TypeError("Webhook event merchant does not match TenantScope");
  return Object.freeze({
    event_id: event.envelope.event_id,
    merchant_id: scope.merchant_id,
    type: event.envelope.type,
    aggregate_id: required(event.envelope.data?.request_id || event.envelope.data?.aggregate_id, "aggregate_id"),
    raw_body: new Uint8Array(event.raw_body),
    occurred_at: event.envelope.occurred_at,
    created_at: event.envelope.occurred_at
  });
}

export function createWebhookDeliveryAttempt({ random, event_id, webhook_endpoint_id, attempt, created_at }) {
  const number = Number(attempt);
  if (!random?.id || !Number.isInteger(number) || number < 1) throw new TypeError("Delivery attempt requires Random and a positive attempt");
  return Object.freeze({
    delivery_id: random.id("delivery"),
    event_id: required(event_id, "event_id"),
    webhook_endpoint_id: required(webhook_endpoint_id, "webhook_endpoint_id"),
    attempt: number,
    status: "pending",
    created_at: required(created_at, "created_at"),
    updated_at: created_at
  });
}

function assertScope(scope) { if (!scope || !Object.isFrozen(scope) || !scope.merchant_id) throw new TypeError("Immutable TenantScope is required"); }
function required(value, field) { const text = String(value || "").trim(); if (!text) throw new TypeError(`${field} is required`); return text; }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const nested of Object.values(value)) deepFreeze(nested); return Object.freeze(value); }
