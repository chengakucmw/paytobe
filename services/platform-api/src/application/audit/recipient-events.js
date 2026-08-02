export function recipientAuditEvent({ audit_event_id, scope, action, recipient, occurred_at, details = {} }) {
  return {
    audit_event_id,
    merchant_id: scope.merchant_id,
    actor_type: "merchant_user",
    actor_id: scope.actor_id,
    action,
    resource_type: "recipient",
    resource_id: recipient.recipient_id,
    result: "success",
    request_id: scope.request_id,
    details: { status: recipient.status, version: recipient.version, ...details },
    occurred_at
  };
}

export function recipientOwnerNotificationEvent(eventId, scope, recipientId, versionId, coolingUntil, occurredAt) {
  return Object.freeze({
    notification_id: eventId,
    merchant_id: scope.merchant_id,
    audience_role: "owner",
    type: "recipient.cooling_started",
    recipient_id: recipientId,
    recipient_version_id: versionId,
    cooling_until: coolingUntil,
    status: "pending",
    created_at: occurredAt
  });
}
