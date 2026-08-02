const ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;
const IDLE_TTL_MS = 30 * 60 * 1000;
const STEP_UP_TTL_MS = 10 * 60 * 1000;
const STEP_UP_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export const SENSITIVE_MERCHANT_OPERATIONS = Object.freeze([
  "member.role_promote",
  "domain.replace",
  "credential.revoke",
  "webhook.secret_rotate",
  "merchant.suspend",
  "recipient.facts_change"
]);

export class MerchantSessionService {
  constructor({ repository, clock, random, hash, originAllowed, email }) {
    for (const [name, value] of Object.entries({ repository, clock, random, hash, originAllowed, email })) {
      if (!value) throw new TypeError(`Merchant session ${name} dependency is required`);
    }
    this.repository = repository;
    this.clock = clock;
    this.random = random;
    this.hash = hash;
    this.originAllowed = originAllowed;
    this.email = email;
  }

  create(input) {
    const grant = String(input?.session_grant || "").trim();
    const merchantId = String(input?.merchant_id || "").trim();
    if (!/^msgrant_[A-Za-z0-9_-]{43}$/.test(grant) || !merchantId) return unauthenticated();
    const now = this.clock.now();
    const sessionToken = this.random.opaqueToken("msession", 32);
    const csrfToken = this.random.opaqueToken("mcsrf", 32);
    const session = this.repository.consumeGrantAndCreate({
      grant_hash: this.hash(grant),
      merchant_id: merchantId,
      session_id: this.random.id("msession"),
      token_hash: this.hash(sessionToken),
      csrf_hash: this.hash(csrfToken),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ABSOLUTE_TTL_MS).toISOString(),
      idle_expires_at: new Date(now.getTime() + IDLE_TTL_MS).toISOString()
    });
    if (!session) return unauthenticated();
    return { ok: true, session, session_token: sessionToken, csrf_token: csrfToken };
  }

  authenticate({ session_token, csrf_token = "", origin = "", require_csrf = false }) {
    const token = String(session_token || "").trim();
    if (!/^msession_[A-Za-z0-9_-]{43}$/.test(token)) return unauthenticated();
    if (require_csrf && (!origin || !this.originAllowed(origin))) {
      return { ok: false, status: 403, code: "origin_forbidden", message: "Request origin is not allowed" };
    }
    const now = this.clock.now();
    const session = this.repository.validate({
      token_hash: this.hash(token),
      now: now.toISOString(),
      idle_expires_at: new Date(now.getTime() + IDLE_TTL_MS).toISOString()
    });
    if (!session) return unauthenticated();
    if (require_csrf && (!csrf_token || session.csrf_hash !== this.hash(csrf_token))) {
      return { ok: false, status: 403, code: "csrf_failed", message: "CSRF proof is missing or invalid" };
    }
    const authContext = Object.freeze({
      actor_type: "merchant_user",
      actor_id: session.account_id,
      merchant_id: session.merchant_id,
      role: session.role,
      scopes: Object.freeze([]),
      auth_method: "merchant_session",
      session_id: session.session_id,
      step_up_at: session.step_up_at || "",
      request_id: session.request_id || "merchant-session"
    });
    return { ok: true, session, auth_context: authContext };
  }

  revoke(sessionId) {
    return this.repository.revoke(sessionId, this.clock.nowIso());
  }

  async startStepUp(session) {
    const now = this.clock.now();
    const token = this.random.opaqueToken("mstep", 32);
    const result = this.repository.createStepUpChallenge({
      challenge_id: this.random.id("mstep"),
      session_id: session.session_id,
      challenge_hash: this.hash(token),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + STEP_UP_CHALLENGE_TTL_MS).toISOString(),
      rate_window_start: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
      rate_limit: 5
    });
    if (!result.ok) return result;
    await this.email.sendStepUp({ to: result.email_normalized, token, expires_at: result.expires_at });
    return { ok: true, accepted: true };
  }

  completeStepUp(session, input) {
    const token = String(input?.challenge_token || "").trim();
    if (!/^mstep_[A-Za-z0-9_-]{43}$/.test(token)) return invalidStepUp();
    const at = this.clock.nowIso();
    const result = this.repository.completeStepUp({ session_id: session.session_id, challenge_hash: this.hash(token), at });
    return result ? { ok: true, step_up_at: at } : invalidStepUp();
  }

  isStepUpFresh(session) {
    if (!session?.step_up_at) return false;
    const age = this.clock.now().getTime() - Date.parse(session.step_up_at);
    return Number.isFinite(age) && age >= 0 && age <= STEP_UP_TTL_MS;
  }
}

export class SqliteMerchantSessionRepository {
  constructor(db) {
    if (!db) throw new TypeError("SQLite database is required");
    this.db = db;
    this.ensureColumns();
  }

  ensureColumns() {
    const columns = new Set(this.db.prepare("PRAGMA table_info(merchant_sessions)").all().map((row) => row.name));
    if (!columns.has("csrf_hash")) this.db.exec("ALTER TABLE merchant_sessions ADD COLUMN csrf_hash TEXT NOT NULL DEFAULT ''");
    if (!columns.has("last_seen_at")) this.db.exec("ALTER TABLE merchant_sessions ADD COLUMN last_seen_at TEXT");
    if (!columns.has("revoked_at")) this.db.exec("ALTER TABLE merchant_sessions ADD COLUMN revoked_at TEXT");
    this.db.exec(`CREATE TABLE IF NOT EXISTS merchant_step_up_challenges (
      challenge_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      challenge_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('active', 'used', 'superseded', 'expired')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      FOREIGN KEY (session_id) REFERENCES merchant_sessions(session_id)
    );
    CREATE INDEX IF NOT EXISTS merchant_step_up_challenges_session_idx
      ON merchant_step_up_challenges(session_id, status, created_at DESC);`);
  }

  consumeGrantAndCreate(value) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const grant = this.db.prepare(`SELECT grant_id, account_id, status, expires_at FROM merchant_session_grants
        WHERE grant_hash = ?`).get(value.grant_hash);
      if (!grant || grant.status !== "active" || grant.expires_at <= value.created_at) return rollbackNull(this.db);
      const identity = this.db.prepare(`SELECT a.account_id, a.status AS account_status, m.status AS merchant_status,
          mm.membership_id, mm.role, mm.status AS membership_status
        FROM merchant_accounts a
        JOIN merchant_memberships mm ON mm.account_id = a.account_id AND mm.merchant_id = ?
        JOIN merchants m ON m.merchant_id = mm.merchant_id
        WHERE a.account_id = ?`).get(value.merchant_id, grant.account_id);
      if (!identity || identity.account_status !== "active" || identity.membership_status !== "active"
          || !["pending_verification", "active"].includes(identity.merchant_status)) return rollbackNull(this.db);
      this.db.prepare("UPDATE merchant_session_grants SET status = 'used', used_at = ? WHERE grant_id = ? AND status = 'active'")
        .run(value.created_at, grant.grant_id);
      this.db.prepare(`UPDATE merchant_sessions SET status = 'revoked', revoked_at = ?, updated_at = ?
        WHERE merchant_id = ? AND account_id = ? AND status = 'active'`)
        .run(value.created_at, value.created_at, value.merchant_id, grant.account_id);
      this.db.prepare(`INSERT INTO merchant_sessions
        (session_id, merchant_id, account_id, token_hash, csrf_hash, status, expires_at, idle_expires_at,
         last_seen_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
        .run(value.session_id, value.merchant_id, grant.account_id, value.token_hash, value.csrf_hash,
          value.expires_at, value.idle_expires_at, value.created_at, value.created_at, value.created_at);
      this.db.exec("COMMIT");
      return { session_id: value.session_id, merchant_id: value.merchant_id, account_id: grant.account_id, role: identity.role,
        status: "active", expires_at: value.expires_at, idle_expires_at: value.idle_expires_at };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  validate(value) {
    const session = this.db.prepare(`SELECT s.*, a.status AS account_status, mm.status AS membership_status,
        mm.role, m.status AS merchant_status
      FROM merchant_sessions s
      JOIN merchant_accounts a ON a.account_id = s.account_id
      JOIN merchant_memberships mm ON mm.account_id = s.account_id AND mm.merchant_id = s.merchant_id
      JOIN merchants m ON m.merchant_id = s.merchant_id
      WHERE s.token_hash = ?`).get(value.token_hash);
    if (!session || session.status !== "active" || session.account_status !== "active"
        || session.membership_status !== "active" || !["pending_verification", "active"].includes(session.merchant_status)
        || session.expires_at <= value.now || session.idle_expires_at <= value.now) {
      if (session?.session_id && session.status === "active") this.revoke(session.session_id, value.now);
      return null;
    }
    this.db.prepare("UPDATE merchant_sessions SET idle_expires_at = ?, last_seen_at = ?, updated_at = ? WHERE session_id = ? AND status = 'active'")
      .run(value.idle_expires_at, value.now, value.now, session.session_id);
    return { ...session, idle_expires_at: value.idle_expires_at };
  }

  revoke(sessionId, at) {
    const result = this.db.prepare(`UPDATE merchant_sessions SET status = 'revoked', revoked_at = ?, updated_at = ?
      WHERE session_id = ? AND status = 'active'`).run(at, at, sessionId);
    return Number(result.changes || 0) === 1;
  }

  createStepUpChallenge(value) {
    const count = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM merchant_step_up_challenges
      WHERE session_id = ? AND created_at >= ?`).get(value.session_id, value.rate_window_start).count);
    if (count >= value.rate_limit) return { ok: false, status: 429, code: "step_up_rate_limited", message: "Too many step-up challenges" };
    const session = this.db.prepare(`SELECT s.session_id, a.email_normalized FROM merchant_sessions s
      JOIN merchant_accounts a ON a.account_id = s.account_id WHERE s.session_id = ? AND s.status = 'active'`).get(value.session_id);
    if (!session) return { ok: false, status: 401, code: "merchant_session_unauthenticated", message: "Merchant session is invalid or expired" };
    this.db.prepare("UPDATE merchant_step_up_challenges SET status = 'superseded' WHERE session_id = ? AND status = 'active'")
      .run(value.session_id);
    this.db.prepare(`INSERT INTO merchant_step_up_challenges
      (challenge_id, session_id, challenge_hash, status, created_at, expires_at)
      VALUES (?, ?, ?, 'active', ?, ?)`)
      .run(value.challenge_id, value.session_id, value.challenge_hash, value.created_at, value.expires_at);
    return { ok: true, email_normalized: session.email_normalized, expires_at: value.expires_at };
  }

  completeStepUp(value) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const challenge = this.db.prepare(`SELECT challenge_id, status, expires_at FROM merchant_step_up_challenges
        WHERE session_id = ? AND challenge_hash = ?`).get(value.session_id, value.challenge_hash);
      if (!challenge || challenge.status !== "active" || challenge.expires_at <= value.at) return rollbackNull(this.db);
      const used = this.db.prepare(`UPDATE merchant_step_up_challenges SET status = 'used', used_at = ?
        WHERE challenge_id = ? AND status = 'active'`).run(value.at, challenge.challenge_id);
      if (Number(used.changes || 0) !== 1) return rollbackNull(this.db);
      const session = this.db.prepare(`UPDATE merchant_sessions SET step_up_at = ?, updated_at = ?
        WHERE session_id = ? AND status = 'active'`).run(value.at, value.at, value.session_id);
      if (Number(session.changes || 0) !== 1) return rollbackNull(this.db);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }
}

export class MemoryMerchantSessionRepository {
  consumeGrantAndCreate() { return null; }
  validate() { return null; }
  revoke() { return false; }
  createStepUpChallenge() { return { ok: false, status: 503, code: "step_up_unavailable", message: "Step-up is unavailable" }; }
  completeStepUp() { return false; }
}

function unauthenticated() {
  return { ok: false, status: 401, code: "merchant_session_unauthenticated", message: "Merchant session is invalid or expired" };
}

function rollbackNull(db) {
  db.exec("ROLLBACK");
  return null;
}

function invalidStepUp() {
  return { ok: false, status: 401, code: "step_up_challenge_invalid", message: "Step-up challenge is invalid or expired" };
}
