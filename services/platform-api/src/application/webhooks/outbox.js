import { createWebhookEventEnvelope, webhookEventRecord } from "../../ports/webhook-outbox.js";

export function paymentStatusWebhookEvent(scope, request, status, patch, { eventId, occurredAt }) {
  const event = createWebhookEventEnvelope({
    event_id: eventId,
    merchant_id: scope.merchant_id,
    type: "payment_request.status_updated",
    occurred_at: occurredAt,
    data: {
      request_id: request.request_id,
      status,
      recipient_id: request.recipient_id || null,
      recipient_version_id: request.recipient_version_id || null,
      recipient_facts_hash: request.recipient_facts_hash || null,
      tx_hash: patch?.tx_hash || null,
      error_code: patch?.error?.code || (typeof patch?.error === "string" ? patch.error : null)
    }
  });
  return webhookEventRecord(scope, event);
}
