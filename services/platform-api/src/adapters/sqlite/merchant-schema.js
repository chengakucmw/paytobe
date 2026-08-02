export const SQLITE_MERCHANT_SCHEMA_VERSION = 3;
export const QUARANTINE_MERCHANT_ID = "__quarantine__";

const LEGACY_TENANT_TABLES = Object.freeze([
  "devices",
  "pairing_sessions",
  "connect_invitations",
  "connections",
  "transaction_contexts",
  "payment_requests"
]);

export function applySqliteMerchantSchema(db, { now = () => new Date().toISOString(), failAfterSchema = false } = {}) {
  if (!db) throw new TypeError("SQLite database is required");
  const current = schemaVersion(db);
  if (current >= SQLITE_MERCHANT_SCHEMA_VERSION) return latestReport(db);

  const before = collectionCounts(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(CORE_SCHEMA_SQL);
    for (const table of LEGACY_TENANT_TABLES) addTenantColumns(db, table);
    backfillLegacyTenantColumns(db);
    createLegacyTenantIndexes(db);
    if (failAfterSchema) throw new Error("Injected merchant migration failure");

    const after = collectionCounts(db);
    const attribution = attributionCounts(db);
    const appliedAt = now();
    const report = {
      version: SQLITE_MERCHANT_SCHEMA_VERSION,
      applied_at: appliedAt,
      before,
      after,
      attribution
    };
    db.prepare(`INSERT INTO platform_migration_reports
      (version, applied_at, before_counts_json, after_counts_json, attribution_counts_json)
      VALUES (?, ?, ?, ?, ?)`)
      .run(SQLITE_MERCHANT_SCHEMA_VERSION, appliedAt, JSON.stringify(before), JSON.stringify(after), JSON.stringify(attribution));
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(SQLITE_MERCHANT_SCHEMA_VERSION, appliedAt);
    db.exec("COMMIT");
    return report;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* no active transaction */ }
    throw error;
  }
}

export function sqliteMerchantMigrationReport(db) {
  return latestReport(db);
}

function addTenantColumns(db, table) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (!columns.has("merchant_id")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN merchant_id TEXT NOT NULL DEFAULT '${QUARANTINE_MERCHANT_ID}'`);
  }
  if (!columns.has("tenant_attribution")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_attribution TEXT NOT NULL DEFAULT 'quarantined'`);
  }
  if (!columns.has("version")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
  }
}

function backfillLegacyTenantColumns(db) {
  for (const table of LEGACY_TENANT_TABLES) {
    db.exec(`UPDATE ${table}
      SET merchant_id = trim(CAST(json_extract(json, '$.merchant_id') AS TEXT)),
          tenant_attribution = 'explicit_merchant_id'
      WHERE json_valid(json)
        AND typeof(json_extract(json, '$.merchant_id')) = 'text'
        AND trim(CAST(json_extract(json, '$.merchant_id') AS TEXT)) <> ''`);
    db.exec(`UPDATE ${table}
      SET merchant_id = trim(CAST(json_extract(json, '$.tenant_id') AS TEXT)),
          tenant_attribution = 'legacy_tenant_id'
      WHERE tenant_attribution = 'quarantined'
        AND json_valid(json)
        AND typeof(json_extract(json, '$.tenant_id')) = 'text'
        AND trim(CAST(json_extract(json, '$.tenant_id') AS TEXT)) <> ''`);
  }
}

function createLegacyTenantIndexes(db) {
  for (const table of LEGACY_TENANT_TABLES) {
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_merchant_idx ON ${table}(merchant_id, k)`);
  }
}

function collectionCounts(db) {
  const counts = {};
  for (const table of LEGACY_TENANT_TABLES) {
    counts[table] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  }
  return counts;
}

function attributionCounts(db) {
  const counts = {};
  for (const table of LEGACY_TENANT_TABLES) {
    const rows = db.prepare(`SELECT tenant_attribution, COUNT(*) AS count FROM ${table} GROUP BY tenant_attribution`).all();
    counts[table] = Object.fromEntries(rows.map((row) => [row.tenant_attribution, Number(row.count)]));
  }
  return counts;
}

function schemaVersion(db) {
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
  return Number(row?.version) || 0;
}

function latestReport(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  if (!tables.has("platform_migration_reports")) return null;
  const row = db.prepare(`SELECT version, applied_at, before_counts_json, after_counts_json, attribution_counts_json
    FROM platform_migration_reports ORDER BY version DESC LIMIT 1`).get();
  if (!row) return null;
  return {
    version: Number(row.version),
    applied_at: row.applied_at,
    before: JSON.parse(row.before_counts_json),
    after: JSON.parse(row.after_counts_json),
    attribution: JSON.parse(row.attribution_counts_json)
  };
}

const CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS merchant_accounts (
  account_id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS merchants (
  merchant_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  legal_name TEXT,
  status TEXT NOT NULL,
  verification_state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS merchant_memberships (
  membership_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
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
  status TEXT NOT NULL,
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
  method TEXT NOT NULL,
  challenge_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  verified_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, domain_id),
  FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id)
);
CREATE INDEX IF NOT EXISTS merchant_domains_tenant_idx ON merchant_domains(merchant_id, status, domain);
CREATE UNIQUE INDEX IF NOT EXISTS merchant_domains_active_domain_uidx ON merchant_domains(domain) WHERE status IN ('active', 'verified');
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  environment TEXT NOT NULL,
  allowed_scopes_json TEXT NOT NULL,
  token_revocation_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
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
  alg TEXT NOT NULL,
  public_key TEXT NOT NULL,
  status TEXT NOT NULL,
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_version INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
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
  status TEXT NOT NULL,
  active_version_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
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
  status TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
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
  attempt INTEGER NOT NULL,
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
CREATE TABLE IF NOT EXISTS platform_migration_reports (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  before_counts_json TEXT NOT NULL,
  after_counts_json TEXT NOT NULL,
  attribution_counts_json TEXT NOT NULL
);`;
