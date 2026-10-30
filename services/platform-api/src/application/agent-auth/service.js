import { createAuthContext } from "../../../../../packages/protocol/src/platform-api.js";

export const AGENT_TOKEN_AUDIENCE = "https://api.Paytobe.com/v1/agent-auth/token";
const MAX_ASSERTION_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 60;

export class AgentAuthService {
  constructor({ repository, clock, random, hash, verifySignature, audience = AGENT_TOKEN_AUDIENCE }) {
    for (const [name, value] of Object.entries({ repository, clock, random, hash, verifySignature, audience })) {
      if (!value) throw new TypeError(`Agent auth ${name} dependency is required`);
    }
    this.repository = repository;
    this.clock = clock;
    this.random = random;
    this.hash = hash;
    this.verifySignature = verifySignature;
    this.audience = audience;
  }

  exchange(input, requestId) {
    let assertion;
    try { assertion = parseClientAssertion(input); } catch { return unauthenticated(); }
    const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    if (!validClaims(assertion.payload, this.audience, nowSeconds)) return unauthenticated();
    const identity = this.repository.assertionIdentity(assertion.payload.iss, assertion.header.kid, this.clock.nowIso());
    if (!identity || !this.verifySignature(identity.public_key, assertion.signing_input, assertion.signature)) return unauthenticated();

    const requestedScopes = normalizeScopes(assertion.payload.scope);
    if (!requestedScopes || requestedScopes.some((scope) => !identity.allowed_scopes.includes(scope))) return unauthenticated();
    const expiresAtMs = Math.min(
      (nowSeconds + MAX_ASSERTION_SECONDS) * 1000,
      assertion.payload.exp * 1000,
      Date.parse(identity.credential_expires_at)
    );
    if (expiresAtMs <= nowSeconds * 1000) return unauthenticated();

    const accessToken = this.random.opaqueToken("vat", 32);
    const tokenValue = {
      token_id: this.random.id("vat"),
      token_hash: this.hash(accessToken),
      merchant_id: identity.merchant_id,
      agent_id: identity.agent_id,
      client_id: assertion.payload.sub,
      credential_id: identity.credential_id,
      scopes: requestedScopes,
      agent_revocation_version: identity.agent_revocation_version,
      credential_revocation_version: identity.credential_revocation_version,
      status: "active",
      issued_at: new Date(nowSeconds * 1000).toISOString(),
      expires_at: new Date(expiresAtMs).toISOString()
    };
    const token = this.repository.issueFromAssertion(tokenValue, {
      merchant_id: identity.merchant_id,
      credential_id: identity.credential_id,
      jti_hash: this.hash(assertion.payload.jti),
      expires_at: new Date(assertion.payload.exp * 1000).toISOString(),
      created_at: tokenValue.issued_at
    });
    if (!token) return unauthenticated();
    const authContext = agentAuthContext(token, requestId);
    return {
      ok: true,
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor((expiresAtMs - nowSeconds * 1000) / 1000),
      scope: [...requestedScopes],
      auth_context: authContext
    };
  }

  authenticate(accessToken, requestId, requiredScopes = []) {
    const token = String(accessToken || "").trim();
    if (!/^vat_[A-Za-z0-9_-]{43}$/.test(token)) return unauthenticated();
    const active = this.repository.activeToken(this.hash(token), this.clock.nowIso());
    if (!active) return unauthenticated();
    const missing = requiredScopes.find((scope) => !active.scopes.includes(scope));
    if (missing) return { ok: false, status: 403, code: "scope_denied", message: `Missing required scope: ${missing}` };
    return { ok: true, token: active, auth_context: agentAuthContext(active, requestId) };
  }
}

export class SqliteAgentAuthRepository {
  constructor(db) {
    if (!db) throw new TypeError("SQLite database is required");
    this.db = db;
    this.ensureSchema();
  }

  ensureSchema() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_access_tokens (
      token_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      merchant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      agent_revocation_version INTEGER NOT NULL,
      credential_revocation_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY (merchant_id, agent_id, credential_id) REFERENCES agent_credentials(merchant_id, agent_id, credential_id)
    );
    CREATE INDEX IF NOT EXISTS agent_access_tokens_tenant_idx
      ON agent_access_tokens(merchant_id, agent_id, credential_id, status, expires_at);`);
  }

  assertionIdentity(agentId, kid, now) {
    const row = this.db.prepare(`SELECT
        m.merchant_id, m.status AS merchant_status,
        a.agent_id, a.status AS agent_status, a.allowed_scopes_json,
        a.token_revocation_version AS agent_revocation_version,
        c.credential_id, c.public_key, c.status AS credential_status, c.not_before,
        c.expires_at AS credential_expires_at, c.revocation_version AS credential_revocation_version
      FROM agents a
      JOIN merchants m ON m.merchant_id = a.merchant_id
      JOIN agent_credentials c ON c.merchant_id = a.merchant_id AND c.agent_id = a.agent_id
      WHERE a.agent_id = ? AND c.kid = ?`).get(agentId, kid);
    if (!row || row.merchant_status !== "active" || row.agent_status !== "active" || !["active", "expiring"].includes(row.credential_status)
        || row.not_before > now || row.credential_expires_at <= now) return null;
    const allowedScopes = parseScopes(row.allowed_scopes_json);
    return allowedScopes ? { ...row, allowed_scopes: allowedScopes } : null;
  }

  issueFromAssertion(value, assertionJti) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM agent_assertion_jtis WHERE expires_at <= ?").run(value.issued_at);
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO agent_assertion_jtis
        (merchant_id, credential_id, jti_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(assertionJti.merchant_id, assertionJti.credential_id, assertionJti.jti_hash,
          assertionJti.expires_at, assertionJti.created_at);
      if (Number(inserted.changes || 0) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db.prepare(`INSERT INTO agent_access_tokens
        (token_id, token_hash, merchant_id, agent_id, client_id, credential_id, scopes_json,
         agent_revocation_version, credential_revocation_version, status, issued_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        value.token_id, value.token_hash, value.merchant_id, value.agent_id, value.client_id,
        value.credential_id, JSON.stringify(value.scopes), value.agent_revocation_version,
        value.credential_revocation_version, value.status, value.issued_at, value.expires_at
      );
      this.db.exec("COMMIT");
      return { ...value };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  pruneExpiredJtis(now) {
    const result = this.db.prepare("DELETE FROM agent_assertion_jtis WHERE expires_at <= ?").run(now);
    return Number(result.changes || 0);
  }

  activeToken(tokenHash, now) {
    const row = this.db.prepare(`SELECT t.*
      FROM agent_access_tokens t
      JOIN merchants m ON m.merchant_id = t.merchant_id
      JOIN agents a ON a.merchant_id = t.merchant_id AND a.agent_id = t.agent_id
      JOIN agent_credentials c ON c.merchant_id = t.merchant_id AND c.agent_id = t.agent_id AND c.credential_id = t.credential_id
      WHERE t.token_hash = ? AND t.status = 'active' AND t.expires_at > ?
        AND m.status = 'active' AND a.status = 'active' AND c.status IN ('active', 'expiring')
        AND c.not_before <= ? AND c.expires_at > ?
        AND t.agent_revocation_version = a.token_revocation_version
        AND t.credential_revocation_version = c.revocation_version`).get(tokenHash, now, now, now);
    if (!row) return null;
    const scopes = parseScopes(row.scopes_json);
    if (!scopes) return null;
    const { token_hash: _tokenHash, scopes_json: _scopesJson, ...publicToken } = row;
    return { ...publicToken, scopes };
  }
}

export class MemoryAgentAuthRepository {
  assertionIdentity() { return null; }
  issueFromAssertion() { return null; }
  activeToken() { return null; }
  pruneExpiredJtis() { return 0; }
}

export function parseClientAssertion(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((field) => field !== "client_assertion")) {
    throw new TypeError("Client assertion request is invalid");
  }
  const compact = String(input.client_assertion || "").trim();
  const parts = compact.split(".");
  if (parts.length !== 3) throw new TypeError("Client assertion is not compact JWS");
  const [protectedPart, payloadPart, signature] = parts;
  const header = decodeJsonPart(protectedPart);
  const payload = decodeJsonPart(payloadPart);
  strictFields(header, new Set(["alg", "kid", "typ"]));
  strictFields(payload, new Set(["iss", "sub", "aud", "iat", "exp", "jti", "scope"]));
  if (header.alg !== "EdDSA" || header.typ !== "JWT" || !boundedId(header.kid, 80)) throw new TypeError("Client assertion header is invalid");
  return { header, payload, signature, signing_input: `${protectedPart}.${payloadPart}` };
}

function validClaims(payload, audience, now) {
  if (!boundedId(payload.iss, 128) || !boundedId(payload.sub, 128) || !boundedId(payload.jti, 200)) return false;
  if (payload.aud !== audience || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) return false;
  if (payload.exp <= payload.iat || payload.exp - payload.iat > MAX_ASSERTION_SECONDS) return false;
  if (payload.iat > now + CLOCK_SKEW_SECONDS || payload.exp <= now) return false;
  return Array.isArray(payload.scope);
}

function normalizeScopes(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const scopes = [...new Set(value.map((scope) => String(scope || "").trim()))].sort();
  return scopes.every((scope) => scope && scope.length <= 100) ? scopes : null;
}

function agentAuthContext(token, requestId) {
  return createAuthContext({
    actor_type: "agent_client",
    actor_id: token.client_id,
    merchant_id: token.merchant_id,
    agent_id: token.agent_id,
    client_id: token.client_id,
    credential_id: token.credential_id,
    scopes: token.scopes,
    auth_method: "agent_assertion"
  }, { requestId: String(requestId || "unknown") });
}

function decodeJsonPart(value) {
  const text = String(value || "");
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.includes("=")) throw new TypeError("JWS part is not canonical base64url");
  const decoded = Buffer.from(text, "base64url");
  if (decoded.toString("base64url") !== text) throw new TypeError("JWS part is not canonical base64url");
  const parsed = JSON.parse(decoded.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("JWS JSON object is required");
  return parsed;
}

function strictFields(value, allowed) {
  if (Object.keys(value).some((field) => !allowed.has(field))) throw new TypeError("JWS contains an unsupported field");
}

function boundedId(value, max) {
  const text = String(value || "").trim();
  return Boolean(text && text.length <= max);
}

function parseScopes(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((scope) => typeof scope === "string") ? parsed : null;
  } catch { return null; }
}

function unauthenticated() {
  return { ok: false, status: 401, code: "unauthenticated", message: "Agent assertion or access token is invalid" };
}
