CREATE TABLE IF NOT EXISTS tenants (
  tenant_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_clients (
  client_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
);
CREATE INDEX IF NOT EXISTS agent_clients_tenant_idx ON agent_clients(tenant_id, status);

CREATE TABLE IF NOT EXISTS app_devices (
  device_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connect_invitations (
  connect_invitation_id TEXT PRIMARY KEY,
  connect_key_hash TEXT NOT NULL UNIQUE,
  claim_token_hash TEXT UNIQUE,
  target_app_device_id TEXT NOT NULL,
  tenant_id TEXT,
  client_id TEXT,
  status TEXT NOT NULL,
  agent_identity_json TEXT,
  identity_assurance TEXT,
  requested_scopes_json TEXT NOT NULL DEFAULT '[]',
  pairing_session_id TEXT UNIQUE,
  connection_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  claimed_at TEXT,
  approved_at TEXT,
  connected_at TEXT,
  rejected_at TEXT,
  cancelled_at TEXT,
  expired_at TEXT,
  expires_at TEXT NOT NULL,
  exchange_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (target_app_device_id) REFERENCES app_devices(device_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
  FOREIGN KEY (client_id) REFERENCES agent_clients(client_id)
);
CREATE INDEX IF NOT EXISTS connect_invitations_device_idx ON connect_invitations(target_app_device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS connect_invitations_tenant_idx ON connect_invitations(tenant_id, client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS connections (
  connection_id TEXT PRIMARY KEY,
  connection_token_hash TEXT UNIQUE,
  target_app_device_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  pairing_session_id TEXT NOT NULL,
  agent_identity_json TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (target_app_device_id) REFERENCES app_devices(device_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
  FOREIGN KEY (client_id) REFERENCES agent_clients(client_id)
);
CREATE INDEX IF NOT EXISTS connections_device_idx ON connections(target_app_device_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS connections_tenant_idx ON connections(tenant_id, client_id, status);

CREATE TABLE IF NOT EXISTS transaction_contexts (
  transaction_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES connections(connection_id)
);

CREATE TABLE IF NOT EXISTS payment_requests (
  request_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  target_app_device_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES connections(connection_id),
  FOREIGN KEY (target_app_device_id) REFERENCES app_devices(device_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_requests_idempotency_idx ON payment_requests(connection_id, idempotency_key);
CREATE INDEX IF NOT EXISTS payment_requests_device_idx ON payment_requests(target_app_device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_requests_tenant_idx ON payment_requests(tenant_id, client_id, created_at DESC);
