const VERIFICATION_TTL_MS = 15 * 60 * 1000;

export class MerchantAccountService {
  constructor({ repository, email, clock, random, hash }) {
    for (const [name, value] of Object.entries({ repository, email, clock, random, hash })) {
      if (!value) throw new TypeError(`Merchant account ${name} dependency is required`);
    }
    this.repository = repository;
    this.email = email;
    this.clock = clock;
    this.random = random;
    this.hash = hash;
  }

  async register(input) {
    const emailNormalized = normalizeMerchantEmail(input?.email);
    const now = this.clock.now();
    const token = this.random.opaqueToken("mverify", 32);
    const tokenHash = this.hash(token);
    const expiresAt = new Date(now.getTime() + VERIFICATION_TTL_MS).toISOString();
    const result = this.repository.register({
      account_id: this.random.id("maccount"),
      verification_id: this.random.id("mverify"),
      email_normalized: emailNormalized,
      token_hash: tokenHash,
      created_at: now.toISOString(),
      expires_at: expiresAt
    });
    if (result.deliver) {
      await this.email.sendVerification({ to: emailNormalized, token, expires_at: expiresAt });
    }
    return Object.freeze({ accepted: true });
  }

  verify(input) {
    const token = String(input?.token || "").trim();
    if (!/^mverify_[A-Za-z0-9_-]{43}$/.test(token)) return invalidToken();
    const result = this.repository.verify({ token_hash: this.hash(token), now: this.clock.nowIso() });
    if (!result.ok) return result;
    const grant = this.random.opaqueToken("msgrant", 32);
    const now = this.clock.now();
    this.repository.issueSessionGrant({
      grant_id: this.random.id("msgrant"),
      account_id: result.account.account_id,
      grant_hash: this.hash(grant),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString()
    });
    return { ...result, session_grant: grant };
  }
}

export class SqliteMerchantAccountRepository {
  constructor(db) {
    if (!db) throw new TypeError("SQLite database is required");
    this.db = db;
    this.ensureSchema();
  }

  ensureSchema() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS merchant_email_verifications (
      verification_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('active', 'used', 'superseded', 'expired')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      superseded_at TEXT,
      FOREIGN KEY (account_id) REFERENCES merchant_accounts(account_id)
    );
    CREATE INDEX IF NOT EXISTS merchant_email_verifications_account_idx
      ON merchant_email_verifications(account_id, status, created_at DESC);
    CREATE TABLE IF NOT EXISTS merchant_session_grants (
      grant_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      grant_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('active', 'used', 'expired', 'revoked')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      FOREIGN KEY (account_id) REFERENCES merchant_accounts(account_id)
    );
    CREATE INDEX IF NOT EXISTS merchant_session_grants_account_idx
      ON merchant_session_grants(account_id, status, expires_at);`);
  }

  register(value) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let account = this.db.prepare("SELECT account_id, status FROM merchant_accounts WHERE email_normalized = ?").get(value.email_normalized);
      if (!account) {
        this.db.prepare(`INSERT INTO merchant_accounts
          (account_id, email_normalized, status, version, created_at, updated_at)
          VALUES (?, ?, 'pending_verification', 1, ?, ?)`)
          .run(value.account_id, value.email_normalized, value.created_at, value.created_at);
        account = { account_id: value.account_id, status: "pending_verification" };
      }
      const deliver = account.status === "pending_verification";
      if (deliver) {
        this.db.prepare(`UPDATE merchant_email_verifications SET status = 'superseded', superseded_at = ?
          WHERE account_id = ? AND status = 'active'`).run(value.created_at, account.account_id);
        this.db.prepare(`INSERT INTO merchant_email_verifications
          (verification_id, account_id, token_hash, status, created_at, expires_at)
          VALUES (?, ?, ?, 'active', ?, ?)`)
          .run(value.verification_id, account.account_id, value.token_hash, value.created_at, value.expires_at);
      }
      this.db.exec("COMMIT");
      return { deliver };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  verify({ token_hash, now }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const verification = this.db.prepare(`SELECT verification_id, account_id, status, expires_at
        FROM merchant_email_verifications WHERE token_hash = ?`).get(token_hash);
      if (!verification || verification.status !== "active") {
        this.db.exec("ROLLBACK");
        return invalidToken();
      }
      if (verification.expires_at <= now) {
        this.db.prepare("UPDATE merchant_email_verifications SET status = 'expired' WHERE verification_id = ? AND status = 'active'")
          .run(verification.verification_id);
        this.db.exec("COMMIT");
        return invalidToken();
      }
      const used = this.db.prepare(`UPDATE merchant_email_verifications SET status = 'used', used_at = ?
        WHERE verification_id = ? AND status = 'active'`).run(now, verification.verification_id);
      if (Number(used.changes || 0) !== 1) {
        this.db.exec("ROLLBACK");
        return invalidToken();
      }
      this.db.prepare(`UPDATE merchant_accounts SET status = 'active', version = version + 1, updated_at = ?
        WHERE account_id = ? AND status = 'pending_verification'`).run(now, verification.account_id);
      const account = this.db.prepare(`SELECT account_id, email_normalized, status, version, created_at, updated_at
        FROM merchant_accounts WHERE account_id = ?`).get(verification.account_id);
      this.db.exec("COMMIT");
      return { ok: true, account: { ...account } };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  issueSessionGrant(value) {
    this.db.prepare(`INSERT INTO merchant_session_grants
      (grant_id, account_id, grant_hash, status, created_at, expires_at)
      VALUES (?, ?, ?, 'active', ?, ?)`)
      .run(value.grant_id, value.account_id, value.grant_hash, value.created_at, value.expires_at);
  }
}

export class MemoryMerchantAccountRepository {
  constructor() {
    this.accounts = new Map();
    this.verifications = new Map();
  }
  register(value) {
    let account = [...this.accounts.values()].find((candidate) => candidate.email_normalized === value.email_normalized);
    if (!account) {
      account = { account_id: value.account_id, email_normalized: value.email_normalized, status: "pending_verification", version: 1, created_at: value.created_at, updated_at: value.created_at };
      this.accounts.set(account.account_id, account);
    }
    const deliver = account.status === "pending_verification";
    if (deliver) {
      for (const verification of this.verifications.values()) {
        if (verification.account_id === account.account_id && verification.status === "active") verification.status = "superseded";
      }
      this.verifications.set(value.token_hash, { ...value, account_id: account.account_id, status: "active" });
    }
    return { deliver };
  }
  verify({ token_hash, now }) {
    const verification = this.verifications.get(token_hash);
    if (!verification || verification.status !== "active" || verification.expires_at <= now) return invalidToken();
    verification.status = "used";
    const account = this.accounts.get(verification.account_id);
    account.status = "active";
    account.version += 1;
    account.updated_at = now;
    return { ok: true, account: { ...account } };
  }
  issueSessionGrant(value) {
    this.sessionGrants ||= new Map();
    this.sessionGrants.set(value.grant_hash, { ...value, status: "active" });
  }
}

export function normalizeMerchantEmail(value) {
  const email = String(value || "").normalize("NFKC").trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || /\s/.test(email)) throw new TypeError("Email is invalid");
  const parts = email.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1] || !parts[1].includes(".")) throw new TypeError("Email is invalid");
  return email;
}

function invalidToken() {
  return { ok: false, code: "invalid_verification_token", message: "Verification token is invalid or expired" };
}
