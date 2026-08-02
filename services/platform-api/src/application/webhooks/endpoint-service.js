const SECRET_OVERLAP_MS = 24 * 60 * 60 * 1000;
const EVENT_TYPE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

export class WebhookEndpointService {
  constructor({ repository, verifier, vault, clock, random, hash }) {
    for (const [name, value] of Object.entries({ repository, verifier, vault, clock, random, hash })) {
      if (!value) throw new TypeError(`Webhook ${name} dependency is required`);
    }
    this.repository = repository;
    this.verifier = verifier;
    this.vault = vault;
    this.clock = clock;
    this.random = random;
    this.hash = hash;
  }

  async create(scope, input) {
    assertScope(scope);
    const inspected = await this.verifier.inspect(input?.url);
    const eventTypes = normalizeEventTypes(input?.event_types);
    const at = this.clock.nowIso();
    const endpointId = this.random.id("webhook");
    const secretId = this.random.id("webhook_secret");
    const secret = this.random.opaqueToken("whsec", 32);
    const challenge = this.random.opaqueToken("whv", 32);
    const domainVerified = this.repository.hasVerifiedDomain(scope, inspected.hostname);
    const binding = secretBinding(scope.merchant_id, endpointId, secretId);
    const ciphertext = JSON.stringify(this.vault.encrypt(secret, binding));
    const endpoint = {
      webhook_endpoint_id: endpointId,
      merchant_id: scope.merchant_id,
      url: inspected.url,
      event_types_json: JSON.stringify(eventTypes),
      status: domainVerified ? "active" : "pending_verification",
      verification_mode: domainVerified ? "merchant_domain" : "endpoint_challenge",
      challenge_hash: domainVerified ? null : this.hash(challenge),
      verified_at: domainVerified ? at : null,
      current_secret_id: secretId,
      previous_secret_id: null,
      secret_overlap_until: null,
      secret_ciphertext: ciphertext,
      version: 1,
      created_at: at,
      updated_at: at
    };
    const created = this.repository.create(scope, endpoint, {
      secret_id: secretId,
      ciphertext,
      status: "active",
      created_at: at
    }, [
      audit(scope, this.random.id("audit"), "webhook_endpoint.created", endpointId, at, { verification_mode: endpoint.verification_mode }),
      audit(scope, this.random.id("audit"), "webhook_secret.displayed", endpointId, at, { secret_id: secretId, reason: "create" })
    ]);
    if (!created) return conflict("webhook_endpoint_conflict", "Webhook Endpoint already exists");
    return {
      ok: true,
      webhook_endpoint: publicEndpoint(created),
      secret,
      ...(domainVerified ? {} : { ownership_challenge: challenge })
    };
  }

  list(scope) {
    assertScope(scope);
    return { ok: true, items: this.repository.list(scope).map(publicEndpoint) };
  }

  get(scope, endpointId) {
    assertScope(scope);
    const endpoint = this.repository.get(scope, endpointId);
    return endpoint ? { ok: true, webhook_endpoint: publicEndpoint(endpoint) } : notFound();
  }

  async verify(scope, endpointId) {
    assertScope(scope);
    const endpoint = this.repository.get(scope, endpointId);
    if (!endpoint) return notFound();
    if (endpoint.status === "active") return { ok: true, webhook_endpoint: publicEndpoint(endpoint) };
    if (endpoint.status !== "pending_verification" || !endpoint.challenge_hash) {
      return conflict("webhook_not_verifiable", "Webhook Endpoint is not awaiting verification");
    }
    let verified;
    try {
      verified = await this.verifier.verifyChallenge(endpoint.url, endpoint.challenge_hash, this.hash);
    } catch (error) {
      return failed(error.code || "webhook_verification_failed", "Webhook Endpoint verification failed");
    }
    if (!verified.ok) return verified;
    const at = this.clock.nowIso();
    const updated = this.repository.activate(scope, endpointId, endpoint.version, verified.evidence_digest, at,
      audit(scope, this.random.id("audit"), "webhook_endpoint.verified", endpointId, at, { verification_mode: endpoint.verification_mode }));
    return updated ? { ok: true, webhook_endpoint: publicEndpoint(updated) } : conflict("concurrency_conflict", "Webhook Endpoint changed concurrently");
  }

  rotateSecret(scope, endpointId) {
    assertScope(scope);
    const endpoint = this.repository.get(scope, endpointId);
    if (!endpoint) return notFound();
    if (endpoint.status !== "active") return conflict("webhook_not_active", "Only an active Webhook Endpoint can rotate secrets");
    const atDate = this.clock.now();
    const at = atDate.toISOString();
    const overlapUntil = new Date(atDate.getTime() + SECRET_OVERLAP_MS).toISOString();
    const secretId = this.random.id("webhook_secret");
    const secret = this.random.opaqueToken("whsec", 32);
    const ciphertext = JSON.stringify(this.vault.encrypt(secret, secretBinding(scope.merchant_id, endpointId, secretId)));
    const updated = this.repository.rotate(scope, endpoint, {
      secret_id: secretId,
      ciphertext,
      status: "active",
      created_at: at
    }, overlapUntil, at, [
      audit(scope, this.random.id("audit"), "webhook_secret.rotated", endpointId, at, {
        previous_secret_id: endpoint.current_secret_id, current_secret_id: secretId, overlap_until: overlapUntil
      }),
      audit(scope, this.random.id("audit"), "webhook_secret.displayed", endpointId, at, { secret_id: secretId, reason: "rotate" })
    ]);
    return updated ? { ok: true, webhook_endpoint: publicEndpoint(updated), secret } : conflict("concurrency_conflict", "Webhook Endpoint changed concurrently");
  }

  revoke(scope, endpointId) {
    assertScope(scope);
    const endpoint = this.repository.get(scope, endpointId);
    if (!endpoint) return notFound();
    if (endpoint.status === "revoked") return { ok: true, webhook_endpoint: publicEndpoint(endpoint) };
    const at = this.clock.nowIso();
    const updated = this.repository.revoke(scope, endpoint, at,
      audit(scope, this.random.id("audit"), "webhook_secret.revoked", endpointId, at, {
        current_secret_id: endpoint.current_secret_id, previous_secret_id: endpoint.previous_secret_id
      }));
    return updated ? { ok: true, webhook_endpoint: publicEndpoint(updated) } : conflict("concurrency_conflict", "Webhook Endpoint changed concurrently");
  }
}

export class SqliteWebhookEndpointRepository {
  constructor(db) {
    if (!db) throw new TypeError("SQLite database is required");
    this.db = db;
    this.ensureSchema();
  }

  ensureSchema() {
    const columns = new Set(this.db.prepare("PRAGMA table_info(webhook_endpoints)").all().map((row) => row.name));
    const additions = {
      verification_mode: "TEXT", challenge_hash: "TEXT", verification_evidence_digest: "TEXT", verified_at: "TEXT",
      current_secret_id: "TEXT", previous_secret_id: "TEXT", secret_overlap_until: "TEXT", revoked_at: "TEXT"
    };
    for (const [column, type] of Object.entries(additions)) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE webhook_endpoints ADD COLUMN ${column} ${type}`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS webhook_endpoint_secrets (
      secret_id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      webhook_endpoint_id TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'overlap', 'revoked', 'expired')),
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      UNIQUE (merchant_id, webhook_endpoint_id, secret_id),
      FOREIGN KEY (webhook_endpoint_id) REFERENCES webhook_endpoints(webhook_endpoint_id)
    );
    CREATE INDEX IF NOT EXISTS webhook_endpoint_secrets_tenant_idx
      ON webhook_endpoint_secrets(merchant_id, webhook_endpoint_id, status, created_at DESC);`);
  }

  hasVerifiedDomain(scope, hostname) {
    assertScope(scope);
    const domains = this.db.prepare(`SELECT domain FROM merchant_domains WHERE merchant_id = ? AND status = 'verified'`).all(scope.merchant_id);
    return domains.some((row) => hostname === row.domain || hostname.endsWith(`.${row.domain}`));
  }

  create(scope, endpoint, secret, audits) {
    assertScope(scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare(`SELECT 1 FROM webhook_endpoints WHERE merchant_id = ? AND url = ? AND status != 'revoked'`).get(scope.merchant_id, endpoint.url)) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db.prepare(`INSERT INTO webhook_endpoints
        (webhook_endpoint_id, merchant_id, url, event_types_json, status, secret_ciphertext, version, created_at, updated_at,
         verification_mode, challenge_hash, verified_at, current_secret_id, previous_secret_id, secret_overlap_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(endpoint.webhook_endpoint_id, scope.merchant_id, endpoint.url, endpoint.event_types_json, endpoint.status,
          endpoint.secret_ciphertext, endpoint.version, endpoint.created_at, endpoint.updated_at, endpoint.verification_mode,
          endpoint.challenge_hash, endpoint.verified_at, endpoint.current_secret_id, null, null);
      this.insertSecret(scope, endpoint.webhook_endpoint_id, secret);
      for (const value of audits) this.insertAudit(value);
      const created = this.get(scope, endpoint.webhook_endpoint_id);
      this.db.exec("COMMIT");
      return created;
    } catch (error) { rollback(this.db); throw error; }
  }

  get(scope, endpointId) {
    assertScope(scope);
    const row = this.db.prepare(`SELECT * FROM webhook_endpoints WHERE merchant_id = ? AND webhook_endpoint_id = ?`)
      .get(scope.merchant_id, endpointId);
    return row ? { ...row } : null;
  }

  list(scope) {
    assertScope(scope);
    return this.db.prepare(`SELECT * FROM webhook_endpoints WHERE merchant_id = ? ORDER BY created_at DESC, webhook_endpoint_id`)
      .all(scope.merchant_id).map((row) => ({ ...row }));
  }

  activate(scope, endpointId, version, evidenceDigest, at, auditValue) {
    assertScope(scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`UPDATE webhook_endpoints SET status = 'active', challenge_hash = NULL,
        verification_evidence_digest = ?, verified_at = ?, version = version + 1, updated_at = ?
        WHERE merchant_id = ? AND webhook_endpoint_id = ? AND version = ? AND status = 'pending_verification'`)
        .run(evidenceDigest, at, at, scope.merchant_id, endpointId, version);
      if (Number(result.changes || 0) !== 1) return rollbackNull(this.db);
      this.insertAudit(auditValue);
      const updated = this.get(scope, endpointId);
      this.db.exec("COMMIT");
      return updated;
    } catch (error) { rollback(this.db); throw error; }
  }

  rotate(scope, endpoint, secret, overlapUntil, at, audits) {
    assertScope(scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare(`UPDATE webhook_endpoint_secrets SET status = 'overlap', expires_at = ?
        WHERE merchant_id = ? AND webhook_endpoint_id = ? AND secret_id = ? AND status = 'active'`)
        .run(overlapUntil, scope.merchant_id, endpoint.webhook_endpoint_id, endpoint.current_secret_id);
      if (Number(previous.changes || 0) !== 1) return rollbackNull(this.db);
      this.insertSecret(scope, endpoint.webhook_endpoint_id, secret);
      const result = this.db.prepare(`UPDATE webhook_endpoints SET secret_ciphertext = ?, current_secret_id = ?,
        previous_secret_id = ?, secret_overlap_until = ?, version = version + 1, updated_at = ?
        WHERE merchant_id = ? AND webhook_endpoint_id = ? AND version = ? AND status = 'active'`)
        .run(secret.ciphertext, secret.secret_id, endpoint.current_secret_id, overlapUntil, at,
          scope.merchant_id, endpoint.webhook_endpoint_id, endpoint.version);
      if (Number(result.changes || 0) !== 1) return rollbackNull(this.db);
      for (const value of audits) this.insertAudit(value);
      const updated = this.get(scope, endpoint.webhook_endpoint_id);
      this.db.exec("COMMIT");
      return updated;
    } catch (error) { rollback(this.db); throw error; }
  }

  revoke(scope, endpoint, at, auditValue) {
    assertScope(scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`UPDATE webhook_endpoint_secrets SET status = 'revoked', revoked_at = ?
        WHERE merchant_id = ? AND webhook_endpoint_id = ? AND status IN ('active', 'overlap')`)
        .run(at, scope.merchant_id, endpoint.webhook_endpoint_id);
      const result = this.db.prepare(`UPDATE webhook_endpoints SET status = 'revoked', secret_ciphertext = '{}',
        current_secret_id = NULL, previous_secret_id = NULL, secret_overlap_until = NULL, revoked_at = ?,
        version = version + 1, updated_at = ? WHERE merchant_id = ? AND webhook_endpoint_id = ? AND version = ?`)
        .run(at, at, scope.merchant_id, endpoint.webhook_endpoint_id, endpoint.version);
      if (Number(result.changes || 0) !== 1) return rollbackNull(this.db);
      this.insertAudit(auditValue);
      const updated = this.get(scope, endpoint.webhook_endpoint_id);
      this.db.exec("COMMIT");
      return updated;
    } catch (error) { rollback(this.db); throw error; }
  }

  insertSecret(scope, endpointId, secret) {
    this.db.prepare(`INSERT INTO webhook_endpoint_secrets
      (secret_id, merchant_id, webhook_endpoint_id, ciphertext, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(secret.secret_id, scope.merchant_id, endpointId, secret.ciphertext, secret.status, secret.created_at);
  }

  insertAudit(value) {
    this.db.prepare(`INSERT INTO audit_events
      (audit_event_id, merchant_id, actor_type, actor_id, action, resource_type, resource_id,
       result, request_id, details_json, occurred_at) VALUES (?, ?, ?, ?, ?, 'webhook_endpoint', ?, 'success', ?, ?, ?)`)
      .run(value.audit_event_id, value.merchant_id, value.actor_type, value.actor_id, value.action,
        value.resource_id, value.request_id, JSON.stringify(value.details), value.occurred_at);
  }
}

export class MemoryWebhookEndpointRepository {
  hasVerifiedDomain() { return false; }
  create() { return null; }
  get() { return null; }
  list() { return []; }
  activate() { return null; }
  rotate() { return null; }
  revoke() { return null; }
}

export function publicEndpoint(value) {
  return {
    webhook_endpoint_id: value.webhook_endpoint_id,
    merchant_id: value.merchant_id,
    url: value.url,
    event_types: parseJson(value.event_types_json, []),
    status: value.status,
    verification_mode: value.verification_mode || null,
    verified_at: value.verified_at || null,
    secret_overlap_until: value.secret_overlap_until || null,
    version: Number(value.version || 0),
    created_at: value.created_at,
    updated_at: value.updated_at,
    revoked_at: value.revoked_at || null
  };
}

function normalizeEventTypes(value) {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new TypeError("event_types must be a non-empty array");
  const result = [...new Set(value.map((item) => String(item || "").trim()))].sort();
  if (result.some((item) => !EVENT_TYPE.test(item))) throw new TypeError("event_types contains an invalid event type");
  return result;
}
function audit(scope, id, action, resourceId, occurredAt, details) {
  return { audit_event_id: id, merchant_id: scope.merchant_id, actor_type: "merchant_account", actor_id: scope.actor_id,
    action, resource_id: resourceId, request_id: scope.request_id, details, occurred_at: occurredAt };
}
function secretBinding(merchantId, endpointId, secretId) { return `${merchantId}:${endpointId}:${secretId}`; }
function assertScope(scope) { if (!scope || !Object.isFrozen(scope) || !scope.merchant_id) throw new TypeError("Immutable TenantScope is required"); }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function failed(code, message) { return { ok: false, status: 422, code, message }; }
function conflict(code, message) { return { ok: false, status: 409, code, message }; }
function notFound() { return { ok: false, status: 404, code: "resource_not_found", message: "Resource not found" }; }
function rollback(db) { try { db.exec("ROLLBACK"); } catch { /* no active transaction */ } }
function rollbackNull(db) { db.exec("ROLLBACK"); return null; }

export { SECRET_OVERLAP_MS };
