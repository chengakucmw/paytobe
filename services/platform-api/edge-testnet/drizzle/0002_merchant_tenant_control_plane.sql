-- Canonical merchant tenant control plane. This is an append-only D1 migration;
-- 0000 and 0001 remain immutable migration history.

CREATE TABLE IF NOT EXISTS merchant_accounts (
  account_id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending_verification', 'active', 'suspended', 'closed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merchants (
  merchant_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  legal_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending_verification', 'active', 'suspended', 'closed')),
  verification_state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merchant_memberships (
  membership_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
  status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, account_id),
  FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id),
  FOREIGN KEY (account_id) REFERENCES merchant_accounts(account_id)
);
CREATE INDEX IF NOT EXISTS merchant_memberships_tenant_idx ON merchant_memberships(merchant_id, status, account_id);

CREATE TABLE IF NOT EXISTS merchant_sessions (
  session_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
  expires_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  step_up_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id),
  FOREIGN KEY (account_id) REFERENCES merchant_accounts(account_id)
);
CREATE INDEX IF NOT EXISTS merchant_sessions_tenant_idx ON merchant_sessions(merchant_id, account_id, status);

CREATE TABLE IF NOT EXISTS merchant_domains (
  domain_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('dns_txt', 'https_well_known')),
  challenge_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'reverification_required', 'failed', 'revoked')),
  verified_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, domain_id),
  FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id)
);
CREATE INDEX IF NOT EXISTS merchant_domains_tenant_idx ON merchant_domains(merchant_id, status, domain);
CREATE UNIQUE INDEX IF NOT EXISTS merchant_domains_verified_domain_uidx ON merchant_domains(domain) WHERE status = 'verified';

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  environment TEXT NOT NULL,
  source_domain TEXT,
  allowed_scopes_json TEXT NOT NULL DEFAULT '[]',
  token_revocation_version INTEGER NOT NULL DEFAULT 0 CHECK (token_revocation_version >= 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'suspended', 'revoked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, agent_id),
  FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id)
);
CREATE INDEX IF NOT EXISTS agents_tenant_idx ON agents(merchant_id, status, agent_id);

CREATE TABLE IF NOT EXISTS agent_credentials (
  credential_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  kid TEXT NOT NULL,
  alg TEXT NOT NULL CHECK (alg = 'Ed25519'),
  public_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_proof', 'active', 'expiring', 'expired', 'revoked')),
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_version INTEGER NOT NULL DEFAULT 0 CHECK (revocation_version >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, agent_id, kid),
  UNIQUE (merchant_id, agent_id, credential_id),
  FOREIGN KEY (merchant_id, agent_id) REFERENCES agents(merchant_id, agent_id)
);
CREATE INDEX IF NOT EXISTS agent_credentials_tenant_idx ON agent_credentials(merchant_id, agent_id, status, expires_at);

CREATE TABLE IF NOT EXISTS agent_assertion_jtis (
  merchant_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  jti_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, credential_id, jti_hash),
  FOREIGN KEY (credential_id) REFERENCES agent_credentials(credential_id)
);
CREATE INDEX IF NOT EXISTS agent_assertion_jtis_tenant_idx ON agent_assertion_jtis(merchant_id, expires_at);

CREATE TABLE IF NOT EXISTS recipients (
  recipient_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'pending_verification', 'active', 'suspended', 'revoked')),
  active_version_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, recipient_id),
  FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id)
);
CREATE INDEX IF NOT EXISTS recipients_tenant_idx ON recipients(merchant_id, status, recipient_id);

CREATE TABLE IF NOT EXISTS recipient_versions (
  recipient_version_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  network TEXT NOT NULL,
  asset TEXT NOT NULL,
  address TEXT NOT NULL,
  memo TEXT,
  verification_state TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (merchant_id, recipient_id, recipient_version_id),
  FOREIGN KEY (merchant_id, recipient_id) REFERENCES recipients(merchant_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS recipient_versions_tenant_idx ON recipient_versions(merchant_id, recipient_id, effective_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS recipient_versions_facts_uidx ON recipient_versions(merchant_id, network, asset, address, COALESCE(memo, ''));

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  webhook_endpoint_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  url TEXT NOT NULL,
  event_types_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'deleted')),
  secret_ciphertext TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, webhook_endpoint_id),
  FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id)
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_tenant_idx ON webhook_endpoints(merchant_id, status, webhook_endpoint_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id)
);
CREATE INDEX IF NOT EXISTS webhook_events_tenant_idx ON webhook_events(merchant_id, occurred_at, event_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  webhook_endpoint_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES webhook_events(event_id),
  FOREIGN KEY (webhook_endpoint_id) REFERENCES webhook_endpoints(webhook_endpoint_id)
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_tenant_idx ON webhook_deliveries(merchant_id, status, next_attempt_at);

CREATE TABLE IF NOT EXISTS audit_events (
  audit_event_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  result TEXT NOT NULL,
  request_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_tenant_idx ON audit_events(merchant_id, occurred_at DESC, audit_event_id);

-- Compatibility columns are non-null immediately. Existing rows without an
-- explicit legacy tenant stay in the reserved quarantine scope.
ALTER TABLE app_devices ADD COLUMN merchant_id TEXT NOT NULL DEFAULT '__quarantine__';
ALTER TABLE app_devices ADD COLUMN tenant_attribution TEXT NOT NULL DEFAULT 'quarantined';
ALTER TABLE app_devices ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS app_devices_merchant_idx ON app_devices(merchant_id, device_id);

ALTER TABLE agent_clients ADD COLUMN merchant_id TEXT NOT NULL DEFAULT '__quarantine__';
ALTER TABLE agent_clients ADD COLUMN tenant_attribution TEXT NOT NULL DEFAULT 'quarantined';
ALTER TABLE agent_clients ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
UPDATE agent_clients SET merchant_id = tenant_id, tenant_attribution = 'legacy_tenant_id'
  WHERE tenant_id IS NOT NULL AND trim(tenant_id) <> '';
DROP INDEX IF EXISTS agent_clients_tenant_idx;
CREATE INDEX IF NOT EXISTS agent_clients_tenant_idx ON agent_clients(merchant_id, status, client_id);

ALTER TABLE connect_invitations ADD COLUMN merchant_id TEXT NOT NULL DEFAULT '__quarantine__';
ALTER TABLE connect_invitations ADD COLUMN tenant_attribution TEXT NOT NULL DEFAULT 'quarantined';
ALTER TABLE connect_invitations ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
UPDATE connect_invitations SET merchant_id = tenant_id, tenant_attribution = 'legacy_tenant_id'
  WHERE tenant_id IS NOT NULL AND trim(tenant_id) <> '';
DROP INDEX IF EXISTS connect_invitations_tenant_idx;
CREATE INDEX IF NOT EXISTS connect_invitations_tenant_idx ON connect_invitations(merchant_id, client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS connect_invitations_merchant_idx ON connect_invitations(merchant_id, status, created_at DESC);

ALTER TABLE connections ADD COLUMN merchant_id TEXT NOT NULL DEFAULT '__quarantine__';
ALTER TABLE connections ADD COLUMN tenant_attribution TEXT NOT NULL DEFAULT 'quarantined';
ALTER TABLE connections ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
UPDATE connections SET merchant_id = tenant_id, tenant_attribution = 'legacy_tenant_id'
  WHERE tenant_id IS NOT NULL AND trim(tenant_id) <> '';
DROP INDEX IF EXISTS connections_tenant_idx;
CREATE INDEX IF NOT EXISTS connections_tenant_idx ON connections(merchant_id, client_id, status);
CREATE INDEX IF NOT EXISTS connections_merchant_idx ON connections(merchant_id, status, created_at DESC);

ALTER TABLE transaction_contexts ADD COLUMN merchant_id TEXT NOT NULL DEFAULT '__quarantine__';
ALTER TABLE transaction_contexts ADD COLUMN tenant_attribution TEXT NOT NULL DEFAULT 'quarantined';
ALTER TABLE transaction_contexts ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
UPDATE transaction_contexts SET merchant_id = tenant_id, tenant_attribution = 'legacy_tenant_id'
  WHERE tenant_id IS NOT NULL AND trim(tenant_id) <> '';
CREATE INDEX IF NOT EXISTS transaction_contexts_merchant_idx ON transaction_contexts(merchant_id, created_at DESC);

ALTER TABLE payment_requests ADD COLUMN merchant_id TEXT NOT NULL DEFAULT '__quarantine__';
ALTER TABLE payment_requests ADD COLUMN tenant_attribution TEXT NOT NULL DEFAULT 'quarantined';
ALTER TABLE payment_requests ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
UPDATE payment_requests SET merchant_id = tenant_id, tenant_attribution = 'legacy_tenant_id'
  WHERE tenant_id IS NOT NULL AND trim(tenant_id) <> '';
DROP INDEX IF EXISTS payment_requests_tenant_idx;
CREATE INDEX IF NOT EXISTS payment_requests_tenant_idx ON payment_requests(merchant_id, client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_requests_merchant_idx ON payment_requests(merchant_id, status, created_at DESC);

-- Existing D1 tenants and registered clients are explicit compatibility data,
-- so their one-to-one merchant/Agent identity can be preserved without guessing.
INSERT OR IGNORE INTO merchants (
  merchant_id, display_name, status, verification_state, version, created_at, updated_at
) SELECT tenant_id, display_name,
    CASE status WHEN 'active' THEN 'active' ELSE 'suspended' END,
    'legacy_registered', 1, created_at, updated_at
  FROM tenants;

INSERT OR IGNORE INTO agents (
  agent_id, merchant_id, name, runtime, environment, source_domain,
  allowed_scopes_json, token_revocation_version, status, version, created_at, updated_at
) SELECT client_id, tenant_id, display_name, runtime, 'testnet', source_domain,
    '["payment.requests.create","payment.requests.read"]', 0,
    CASE status WHEN 'active' THEN 'active' ELSE 'suspended' END,
    1, created_at, updated_at
  FROM agent_clients;
