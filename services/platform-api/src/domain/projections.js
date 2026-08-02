// Entity → public API response serializers (pure helpers).
//
// Extracted verbatim from server.js. Each function maps a stored entity to the
// exact shape the HTTP API returns; keeping them in one place makes the API
// contract easy to read and test.

export function pairingSessionResponse(session) {
  return {
    pairing_session_id: session.pairing_session_id,
    pairing_code: session.pairing_code,
    pairing_uri: session.pairing_uri,
    agent_identity: session.agent_identity,
    identity_assurance: session.identity_assurance || "unverified",
    requested_scopes: session.requested_scopes,
    connect_invitation_id: session.connect_invitation_id || null,
    status: session.status,
    created_at: session.created_at,
    updated_at: session.updated_at,
    expires_at: session.expires_at
  };
}

export function connectInvitationResponse(invitation, identityReview = null) {
  return {
    connect_invitation_id: invitation.connect_invitation_id,
    status: invitation.status,
    agent_identity: invitation.agent_identity || null,
    identity_assurance: invitation.identity_assurance || null,
    requested_scopes: invitation.requested_scopes || [],
    pairing_session_id: invitation.pairing_session_id || null,
    connection_id: invitation.connection_id || null,
    created_at: invitation.created_at,
    updated_at: invitation.updated_at,
    claimed_at: invitation.claimed_at || null,
    approved_at: invitation.approved_at || null,
    connected_at: invitation.connected_at || null,
    rejected_at: invitation.rejected_at || null,
    cancelled_at: invitation.cancelled_at || null,
    expired_at: invitation.expired_at || null,
    expires_at: invitation.expires_at,
    identity_review: identityReview
  };
}

export function deviceResponse(device) {
  return {
    device_id: device.device_id,
    registered_at: device.registered_at,
    last_seen_at: device.last_seen_at,
    token_rotated_at: device.token_rotated_at || null,
    push: device.push ? {
      provider: device.push.provider || null,
      status: device.push.status || "inactive",
      updated_at: device.push.updated_at || null
    } : null
  };
}

export function connectionResponse(connection) {
  return {
    connection_id: connection.connection_id,
    connection_token: connection.connection_token,
    scopes: connection.scopes,
    agent_identity: connection.agent_identity,
    status: connection.status,
    created_at: connection.created_at,
    updated_at: connection.updated_at,
    token_rotated_at: connection.token_rotated_at || null,
    expires_at: connection.expires_at
  };
}

export function connectionPublicResponse(connection) {
  return {
    connection_id: connection.connection_id,
    pairing_session_id: connection.pairing_session_id,
    scopes: connection.scopes,
    approved_scopes: connection.approved_scopes,
    agent_identity: connection.agent_identity,
    status: connection.status,
    created_at: connection.created_at,
    updated_at: connection.updated_at,
    last_activity_at: connection.last_activity_at,
    expires_at: connection.expires_at,
    revoked_at: connection.revoked_at || null
  };
}

export function paymentTenantEventProjection(event, projectEvent) {
  const projected = projectEvent(event, event.request || null);
  return {
    ...projected,
    event_id: event.event_id,
    merchant_id: event.merchant_id,
    cursor_seq: event.seq
  };
}
