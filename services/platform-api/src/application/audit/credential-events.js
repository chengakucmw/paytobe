export function credentialAuditEvent({ audit_event_id, scope, action, credential, occurred_at, actor_type = "merchant_user", actor_id, request_id, details = {} }) {
  return {
    audit_event_id,
    merchant_id: scope?.merchant_id || credential.merchant_id,
    actor_type,
    actor_id: actor_id || scope?.actor_id || "credential_lifecycle",
    action,
    resource_type: "agent_credential",
    resource_id: credential.credential_id,
    result: "success",
    request_id: request_id || scope?.request_id || "credential_lifecycle_sweep",
    details: {
      agent_id: credential.agent_id,
      status: credential.status,
      version: credential.version,
      ...details
    },
    occurred_at
  };
}

export function credentialReminderEvent(eventId, credential, occurredAt) {
  return Object.freeze({
    version: "Paytobe.credential_event.v1",
    event_id: eventId,
    type: "agent_credential.expiring",
    merchant_id: credential.merchant_id,
    agent_id: credential.agent_id,
    credential_id: credential.credential_id,
    expires_at: credential.expires_at,
    occurred_at: occurredAt
  });
}
