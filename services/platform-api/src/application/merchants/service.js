const PUBLIC_TRANSITIONS = Object.freeze({
  pending_verification: new Set([]),
  active: new Set(["suspended", "closed"]),
  suspended: new Set(["active", "closed"]),
  closed: new Set()
});

export class MerchantService {
  constructor({ repository, clock, random, hash }) {
    for (const [name, value] of Object.entries({ repository, clock, random, hash })) {
      if (!value) throw new TypeError(`Merchant ${name} dependency is required`);
    }
    this.repository = repository;
    this.clock = clock;
    this.random = random;
    this.hash = hash;
  }

  create(input) {
    if (input?.owner_account_id || input?.account_id || input?.status) {
      return invalid("owner_or_status_forbidden", "Owner and status are derived by the server");
    }
    const grant = String(input?.session_grant || "").trim();
    const displayName = requiredText(input?.display_name, "display_name", 120);
    const legalName = optionalText(input?.legal_name, 200);
    if (!/^msgrant_[A-Za-z0-9_-]{43}$/.test(grant)) return unauthenticated();
    const now = this.clock.now();
    const nextGrant = this.random.opaqueToken("msgrant", 32);
    const result = this.repository.createFromGrant({
      grant_hash: this.hash(grant),
      merchant_id: this.random.id("merchant"),
      membership_id: this.random.id("membership"),
      next_grant_id: this.random.id("msgrant"),
      next_grant_hash: this.hash(nextGrant),
      display_name: displayName,
      legal_name: legalName,
      created_at: now.toISOString(),
      grant_expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString()
    });
    if (!result) return unauthenticated();
    return { ok: true, ...result, session_grant: nextGrant };
  }

  get(tenantScope, merchantId) {
    return this.repository.get(tenantScope, merchantId);
  }

  update(tenantScope, merchantId, input, options = {}) {
    const expectedVersion = Number(input?.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return invalid("concurrency_conflict", "A current positive version is required", 409);
    const current = this.repository.get(tenantScope, merchantId);
    if (!current) return notFound();
    if (current.version !== expectedVersion) return invalid("concurrency_conflict", "Merchant version does not match", 409);
    if (current.status === "closed") return invalid("merchant_closed", "Closed merchants cannot be changed", 409);

    const patch = {};
    if (input.display_name !== undefined) patch.display_name = requiredText(input.display_name, "display_name", 120);
    if (input.legal_name !== undefined) patch.legal_name = optionalText(input.legal_name, 200);
    if (input.status !== undefined && input.status !== current.status) {
      const next = String(input.status);
      if (current.status === "pending_verification" && next === "active" && !options.allowActivation) {
        return invalid("verification_required", "Merchant verification must complete before activation", 409);
      }
      const allowed = current.status === "pending_verification" && options.allowActivation && next === "active"
        ? true
        : PUBLIC_TRANSITIONS[current.status]?.has(next);
      if (!allowed) return invalid("invalid_merchant_transition", "Merchant status transition is not allowed", 409);
      if (["suspended", "closed"].includes(next) && !options.allowSensitive) {
        return invalid("step_up_required", "Recent step-up authentication is required", 403);
      }
      patch.status = next;
    }
    if (!Object.keys(patch).length) return { ok: true, merchant: current };
    const updated = this.repository.update(tenantScope, merchantId, patch, expectedVersion, this.clock.nowIso());
    return updated ? { ok: true, merchant: updated } : invalid("concurrency_conflict", "Merchant changed concurrently", 409);
  }

  activateVerified(tenantScope, merchantId, expectedVersion) {
    return this.update(tenantScope, merchantId, { status: "active", version: expectedVersion }, { allowActivation: true });
  }
}

export class SqliteMerchantRepository {
  constructor(db) {
    if (!db) throw new TypeError("SQLite database is required");
    this.db = db;
  }

  createFromGrant(value) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const grant = this.db.prepare(`SELECT g.grant_id, g.account_id, g.status, g.expires_at, a.status AS account_status
        FROM merchant_session_grants g JOIN merchant_accounts a ON a.account_id = g.account_id
        WHERE g.grant_hash = ?`).get(value.grant_hash);
      if (!grant || grant.status !== "active" || grant.account_status !== "active" || grant.expires_at <= value.created_at) return rollbackNull(this.db);
      const consumed = this.db.prepare("UPDATE merchant_session_grants SET status = 'used', used_at = ? WHERE grant_id = ? AND status = 'active'")
        .run(value.created_at, grant.grant_id);
      if (Number(consumed.changes || 0) !== 1) return rollbackNull(this.db);
      this.db.prepare(`INSERT INTO merchants
        (merchant_id, display_name, legal_name, status, verification_state, version, created_at, updated_at)
        VALUES (?, ?, ?, 'pending_verification', 'email_verified', 1, ?, ?)`)
        .run(value.merchant_id, value.display_name, value.legal_name || null, value.created_at, value.created_at);
      this.db.prepare(`INSERT INTO merchant_memberships
        (membership_id, merchant_id, account_id, role, status, version, created_at, updated_at)
        VALUES (?, ?, ?, 'owner', 'active', 1, ?, ?)`)
        .run(value.membership_id, value.merchant_id, grant.account_id, value.created_at, value.created_at);
      this.db.prepare(`INSERT INTO merchant_session_grants
        (grant_id, account_id, grant_hash, status, created_at, expires_at)
        VALUES (?, ?, ?, 'active', ?, ?)`)
        .run(value.next_grant_id, grant.account_id, value.next_grant_hash, value.created_at, value.grant_expires_at);
      this.db.exec("COMMIT");
      return {
        merchant: this.db.prepare("SELECT * FROM merchants WHERE merchant_id = ?").get(value.merchant_id),
        membership: this.db.prepare("SELECT * FROM merchant_memberships WHERE membership_id = ?").get(value.membership_id)
      };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  get(scope, merchantId) {
    assertScope(scope);
    const row = this.db.prepare("SELECT * FROM merchants WHERE merchant_id = ? AND merchant_id = ?").get(scope.merchant_id, merchantId);
    return row ? { ...row } : null;
  }

  update(scope, merchantId, patch, expectedVersion, at) {
    assertScope(scope);
    const fields = Object.keys(patch);
    const result = this.db.prepare(`UPDATE merchants SET ${fields.map((field) => `${field} = ?`).join(", ")},
      version = version + 1, updated_at = ? WHERE merchant_id = ? AND merchant_id = ? AND version = ?`)
      .run(...fields.map((field) => patch[field]), at, scope.merchant_id, merchantId, expectedVersion);
    return Number(result.changes || 0) === 1 ? this.get(scope, merchantId) : null;
  }
}

export class MemoryMerchantRepository {
  createFromGrant() { return null; }
  get() { return null; }
  update() { return null; }
}

export function merchantCapabilityAllowed(merchant, _capability) {
  return merchant?.status === "active";
}

function assertScope(scope) {
  if (!scope || !Object.isFrozen(scope) || !scope.merchant_id) throw new TypeError("Immutable TenantScope is required");
}
function requiredText(value, field, max) {
  const text = String(value || "").trim();
  if (!text || text.length > max) throw new TypeError(`${field} is invalid`);
  return text;
}
function optionalText(value, max) {
  const text = String(value || "").trim();
  if (text.length > max) throw new TypeError("legal_name is invalid");
  return text;
}
function invalid(code, message, status = 400) { return { ok: false, status, code, message }; }
function unauthenticated() { return invalid("onboarding_grant_invalid", "Onboarding grant is invalid or expired", 401); }
function notFound() { return invalid("resource_not_found", "Resource not found", 404); }
function rollbackNull(db) { db.exec("ROLLBACK"); return null; }
