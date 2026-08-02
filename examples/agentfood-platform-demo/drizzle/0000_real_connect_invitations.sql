CREATE TABLE IF NOT EXISTS agentfood_app_devices (
  device_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agentfood_connect_invitations (
  connect_invitation_id TEXT PRIMARY KEY,
  connect_key_hash TEXT NOT NULL UNIQUE,
  claim_token_hash TEXT UNIQUE,
  target_app_device_id TEXT NOT NULL,
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
  exchange_count INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agentfood_connect_invitations_device_idx
  ON agentfood_connect_invitations(target_app_device_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agentfood_connections (
  connection_id TEXT PRIMARY KEY,
  connection_token_hash TEXT UNIQUE,
  target_app_device_id TEXT NOT NULL,
  pairing_session_id TEXT NOT NULL,
  agent_identity_json TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agentfood_transaction_contexts (
  transaction_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agentfood_payment_requests (
  request_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  target_app_device_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agentfood_payment_requests_device_idx
  ON agentfood_payment_requests(target_app_device_id, created_at DESC);
