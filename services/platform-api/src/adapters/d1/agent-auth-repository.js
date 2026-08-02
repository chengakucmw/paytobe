export class D1AgentAuthRepository {
  constructor(db) {
    if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
      throw new TypeError("D1 database with transactional batch support is required");
    }
    this.db = db;
  }

  async issueFromAssertion(value, assertionJti) {
    const results = await this.db.batch([
      this.db.prepare("DELETE FROM agent_assertion_jtis WHERE expires_at <= ?").bind(value.issued_at),
      this.db.prepare(`INSERT INTO agent_assertion_jtis
        (merchant_id, credential_id, jti_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(merchant_id, credential_id, jti_hash) DO NOTHING`)
        .bind(assertionJti.merchant_id, assertionJti.credential_id, assertionJti.jti_hash,
          assertionJti.expires_at, assertionJti.created_at),
      this.db.prepare(`INSERT INTO agent_access_tokens
        (token_id, token_hash, merchant_id, agent_id, client_id, credential_id, scopes_json,
         agent_revocation_version, credential_revocation_version, status, issued_at, expires_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`)
        .bind(value.token_id, value.token_hash, value.merchant_id, value.agent_id, value.client_id,
          value.credential_id, JSON.stringify(value.scopes), value.agent_revocation_version,
          value.credential_revocation_version, value.status, value.issued_at, value.expires_at)
    ]);
    return Number(results[2]?.meta?.changes || 0) === 1 ? { ...value } : null;
  }

  async activeToken(tokenHash, now) {
    const row = await this.db.prepare(`SELECT t.*
      FROM agent_access_tokens t
      JOIN merchants m ON m.merchant_id = t.merchant_id
      JOIN agents a ON a.merchant_id = t.merchant_id AND a.agent_id = t.agent_id
      JOIN agent_credentials c ON c.merchant_id = t.merchant_id AND c.agent_id = t.agent_id AND c.credential_id = t.credential_id
      WHERE t.token_hash = ? AND t.status = 'active' AND t.expires_at > ?
        AND m.status = 'active' AND a.status = 'active' AND c.status IN ('active', 'expiring')
        AND c.not_before <= ? AND c.expires_at > ?
        AND t.agent_revocation_version = a.token_revocation_version
        AND t.credential_revocation_version = c.revocation_version`).bind(tokenHash, now, now, now).first();
    if (!row) return null;
    const scopes = parseScopes(row.scopes_json);
    if (!scopes) return null;
    const { token_hash: _tokenHash, scopes_json: _scopesJson, ...publicToken } = row;
    return { ...publicToken, scopes };
  }

  async pruneExpiredJtis(now) {
    const result = await this.db.prepare("DELETE FROM agent_assertion_jtis WHERE expires_at <= ?").bind(now).run();
    return Number(result.meta?.changes || 0);
  }
}

function parseScopes(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((scope) => typeof scope === "string") ? parsed : null;
  } catch { return null; }
}
