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
    requested_scopes: session.requested_scopes,
    status: session.status,
    created_at: session.created_at,
    updated_at: session.updated_at,
    expires_at: session.expires_at
  };
}

export function deviceResponse(device) {
  return {
    device_id: device.device_id,
    registered_at: device.registered_at,
    last_seen_at: device.last_seen_at,
    token_rotated_at: device.token_rotated_at || null
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
