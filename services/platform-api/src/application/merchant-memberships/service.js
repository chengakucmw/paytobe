import { normalizeMerchantEmail } from "../merchant-accounts/service.js";

export const MERCHANT_CAPABILITIES = Object.freeze({
  owner: Object.freeze(["resources.read", "members.manage", "domains.manage", "agents.manage", "credentials.manage", "recipients.manage", "webhooks.manage", "audit.read"]),
  admin: Object.freeze(["resources.read", "members.manage", "domains.manage", "agents.manage", "credentials.manage", "recipients.manage", "webhooks.manage", "audit.read"]),
  developer: Object.freeze(["resources.read", "agents.manage", "credentials.manage", "recipients.manage", "webhooks.manage", "audit.read"]),
  viewer: Object.freeze(["resources.read", "audit.read"])
});

const ROLE_RANK = Object.freeze({ viewer: 0, developer: 1, admin: 2, owner: 3 });

export function roleAllows(role, capability) {
  return Boolean(MERCHANT_CAPABILITIES[role]?.includes(capability));
}

export class MerchantMembershipService {
  constructor({ repository, clock, random, hash }) {
    for (const [name, value] of Object.entries({ repository, clock, random, hash })) {
      if (!value) throw new TypeError(`Merchant membership ${name} dependency is required`);
    }
    this.repository = repository;
    this.clock = clock;
    this.random = random;
    this.hash = hash;
  }

  invite(scope, actor, input) {
    if (!roleAllows(actor?.role, "members.manage")) return forbidden();
    const role = normalizedRole(input?.role);
    if (role === "owner" && actor.role !== "owner") return forbidden("Only an Owner can invite another Owner");
    const token = this.random.opaqueToken("minvite", 32);
    const now = this.clock.now();
    const invitation = this.repository.createInvitation(scope, {
      invitation_id: this.random.id("minvite"),
      email_normalized: normalizeMerchantEmail(input?.email),
      role,
      token_hash: this.hash(token),
      created_by_account_id: actor.account_id,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
    });
    return invitation ? { ok: true, invitation, invitation_token: token } : conflict("membership_invitation_conflict", "An active invitation or membership already exists");
  }

  accept(input) {
    const invitationToken = String(input?.invitation_token || "").trim();
    const sessionGrant = String(input?.session_grant || "").trim();
    if (!/^minvite_[A-Za-z0-9_-]{43}$/.test(invitationToken) || !/^msgrant_[A-Za-z0-9_-]{43}$/.test(sessionGrant)) return unauthenticated();
    const now = this.clock.now();
    const nextGrant = this.random.opaqueToken("msgrant", 32);
    const result = this.repository.acceptInvitation({
      invitation_token_hash: this.hash(invitationToken),
      grant_hash: this.hash(sessionGrant),
      membership_id: this.random.id("membership"),
      next_grant_id: this.random.id("msgrant"),
      next_grant_hash: this.hash(nextGrant),
      accepted_at: now.toISOString(),
      grant_expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString()
    });
    return result ? { ok: true, ...result, session_grant: nextGrant } : unauthenticated();
  }

  list(scope, actor) {
    if (!roleAllows(actor?.role, "resources.read")) return forbidden();
    return { ok: true, items: this.repository.list(scope) };
  }

  changeRole(scope, actor, membershipId, input, options = {}) {
    if (!roleAllows(actor?.role, "members.manage")) return forbidden();
    const target = this.repository.get(scope, membershipId);
    if (!target) return notFound();
    const role = normalizedRole(input?.role);
    const expectedVersion = Number(input?.version);
    if (!Number.isInteger(expectedVersion) || target.version !== expectedVersion) return conflict("concurrency_conflict", "Membership version does not match");
    if (role === "owner" && actor.role !== "owner") return forbidden("Only an Owner can grant Owner role");
    if (actor.account_id === target.account_id && ROLE_RANK[role] > ROLE_RANK[target.role]) return forbidden("Self elevation is not allowed");
    if (target.role === "owner" && role !== "owner" && this.repository.ownerCount(scope) <= 1) {
      return conflict("last_owner_required", "The last Owner cannot be demoted");
    }
    if (ROLE_RANK[role] > ROLE_RANK[target.role] && !options.allowSensitive) {
      return { ok: false, status: 403, code: "step_up_required", message: "Recent step-up authentication is required" };
    }
    const updated = this.repository.updateRole(scope, membershipId, role, expectedVersion, this.clock.nowIso());
    return updated ? { ok: true, membership: updated } : conflict("concurrency_conflict", "Membership changed concurrently");
  }

  remove(scope, actor, membershipId, input = {}) {
    if (!roleAllows(actor?.role, "members.manage")) return forbidden();
    const target = this.repository.get(scope, membershipId);
    if (!target) return notFound();
    if (target.role === "owner" && this.repository.ownerCount(scope) <= 1) {
      return conflict("last_owner_required", "The last Owner cannot be removed");
    }
    const expectedVersion = Number(input.version);
    if (!Number.isInteger(expectedVersion) || target.version !== expectedVersion) return conflict("concurrency_conflict", "Membership version does not match");
    const removed = this.repository.remove(scope, membershipId, expectedVersion, this.clock.nowIso());
    return removed ? { ok: true, membership: removed } : conflict("concurrency_conflict", "Membership changed concurrently");
  }
}

export class SqliteMerchantMembershipRepository {
  constructor(db) {
    if (!db) throw new TypeError("SQLite database is required");
    this.db = db;
    this.ensureSchema();
  }
  ensureSchema() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS merchant_membership_invitations (
      invitation_id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      email_normalized TEXT NOT NULL,
      role TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('active', 'accepted', 'superseded', 'expired', 'revoked')),
      created_by_account_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      accepted_by_account_id TEXT,
      FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id)
    );
    CREATE INDEX IF NOT EXISTS merchant_membership_invitations_tenant_idx
      ON merchant_membership_invitations(merchant_id, status, email_normalized);`);
  }
  createInvitation(scope, value) {
    assertScope(scope);
    const member = this.db.prepare(`SELECT 1 FROM merchant_memberships mm JOIN merchant_accounts a ON a.account_id = mm.account_id
      WHERE mm.merchant_id = ? AND a.email_normalized = ? AND mm.status = 'active'`).get(scope.merchant_id, value.email_normalized);
    if (member) return null;
    this.db.prepare(`UPDATE merchant_membership_invitations SET status = 'superseded'
      WHERE merchant_id = ? AND email_normalized = ? AND status = 'active'`).run(scope.merchant_id, value.email_normalized);
    this.db.prepare(`INSERT INTO merchant_membership_invitations
      (invitation_id, merchant_id, email_normalized, role, token_hash, status, created_by_account_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
      .run(value.invitation_id, scope.merchant_id, value.email_normalized, value.role, value.token_hash,
        value.created_by_account_id, value.created_at, value.expires_at);
    return publicInvitation(this.db.prepare("SELECT * FROM merchant_membership_invitations WHERE invitation_id = ?").get(value.invitation_id));
  }
  acceptInvitation(value) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const invitation = this.db.prepare(`SELECT * FROM merchant_membership_invitations WHERE token_hash = ?`).get(value.invitation_token_hash);
      const grant = this.db.prepare(`SELECT g.*, a.email_normalized, a.status AS account_status
        FROM merchant_session_grants g JOIN merchant_accounts a ON a.account_id = g.account_id WHERE g.grant_hash = ?`).get(value.grant_hash);
      if (!invitation || invitation.status !== "active" || invitation.expires_at <= value.accepted_at
          || !grant || grant.status !== "active" || grant.expires_at <= value.accepted_at || grant.account_status !== "active"
          || grant.email_normalized !== invitation.email_normalized) return rollbackNull(this.db);
      if (this.db.prepare("SELECT 1 FROM merchant_memberships WHERE merchant_id = ? AND account_id = ? AND status = 'active'")
        .get(invitation.merchant_id, grant.account_id)) return rollbackNull(this.db);
      this.db.prepare(`INSERT INTO merchant_memberships
        (membership_id, merchant_id, account_id, role, status, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', 1, ?, ?)`)
        .run(value.membership_id, invitation.merchant_id, grant.account_id, invitation.role, value.accepted_at, value.accepted_at);
      this.db.prepare(`UPDATE merchant_membership_invitations SET status = 'accepted', accepted_at = ?, accepted_by_account_id = ?
        WHERE invitation_id = ? AND status = 'active'`).run(value.accepted_at, grant.account_id, invitation.invitation_id);
      this.db.prepare("UPDATE merchant_session_grants SET status = 'used', used_at = ? WHERE grant_id = ? AND status = 'active'")
        .run(value.accepted_at, grant.grant_id);
      this.db.prepare(`INSERT INTO merchant_session_grants
        (grant_id, account_id, grant_hash, status, created_at, expires_at) VALUES (?, ?, ?, 'active', ?, ?)`)
        .run(value.next_grant_id, grant.account_id, value.next_grant_hash, value.accepted_at, value.grant_expires_at);
      const membership = this.db.prepare("SELECT * FROM merchant_memberships WHERE membership_id = ?").get(value.membership_id);
      this.db.exec("COMMIT");
      return { membership: { ...membership } };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }
  get(scope, id) {
    assertScope(scope);
    const row = this.db.prepare("SELECT * FROM merchant_memberships WHERE merchant_id = ? AND membership_id = ?").get(scope.merchant_id, id);
    return row ? { ...row } : null;
  }
  list(scope) {
    assertScope(scope);
    return this.db.prepare(`SELECT mm.membership_id, mm.merchant_id, mm.account_id, mm.role, mm.status, mm.version,
      a.email_normalized, mm.created_at, mm.updated_at FROM merchant_memberships mm
      JOIN merchant_accounts a ON a.account_id = mm.account_id WHERE mm.merchant_id = ? ORDER BY mm.created_at`)
      .all(scope.merchant_id).map((row) => ({ ...row }));
  }
  ownerCount(scope) {
    assertScope(scope);
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM merchant_memberships
      WHERE merchant_id = ? AND role = 'owner' AND status = 'active'`).get(scope.merchant_id).count);
  }
  updateRole(scope, id, role, version, at) {
    assertScope(scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const target = this.get(scope, id);
      if (!target || target.version !== version) return rollbackNull(this.db);
      const result = this.db.prepare(`UPDATE merchant_memberships SET role = ?, version = version + 1, updated_at = ?
        WHERE merchant_id = ? AND membership_id = ? AND version = ?`).run(role, at, scope.merchant_id, id, version);
      if (Number(result.changes || 0) !== 1) return rollbackNull(this.db);
      this.revokeAccountSessions(scope.merchant_id, target.account_id, at);
      const updated = this.get(scope, id);
      this.db.exec("COMMIT");
      return updated;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }
  remove(scope, id, version, at) {
    assertScope(scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const target = this.get(scope, id);
      if (!target || target.version !== version) return rollbackNull(this.db);
      const result = this.db.prepare(`UPDATE merchant_memberships SET status = 'removed', version = version + 1, updated_at = ?
        WHERE merchant_id = ? AND membership_id = ? AND version = ? AND status = 'active'`).run(at, scope.merchant_id, id, version);
      if (Number(result.changes || 0) !== 1) return rollbackNull(this.db);
      this.revokeAccountSessions(scope.merchant_id, target.account_id, at);
      const updated = this.get(scope, id);
      this.db.exec("COMMIT");
      return updated;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }
  revokeAccountSessions(merchantId, accountId, at) {
    this.db.prepare(`UPDATE merchant_sessions SET status = 'revoked', revoked_at = ?, updated_at = ?
      WHERE merchant_id = ? AND account_id = ? AND status = 'active'`).run(at, at, merchantId, accountId);
  }
}

export class MemoryMerchantMembershipRepository {
  createInvitation() { return null; }
  acceptInvitation() { return null; }
  get() { return null; }
  list() { return []; }
  ownerCount() { return 0; }
  updateRole() { return null; }
  remove() { return null; }
}

function normalizedRole(value) {
  const role = String(value || "viewer").trim().toLowerCase();
  if (!Object.hasOwn(MERCHANT_CAPABILITIES, role)) throw new TypeError("Membership role is invalid");
  return role;
}
function publicInvitation(value) {
  return { invitation_id: value.invitation_id, merchant_id: value.merchant_id, email_normalized: value.email_normalized,
    role: value.role, status: value.status, created_at: value.created_at, expires_at: value.expires_at };
}
function assertScope(scope) { if (!scope || !Object.isFrozen(scope) || !scope.merchant_id) throw new TypeError("Immutable TenantScope is required"); }
function forbidden(message = "Merchant role is not permitted") { return { ok: false, status: 403, code: "forbidden", message }; }
function conflict(code, message) { return { ok: false, status: 409, code, message }; }
function notFound() { return { ok: false, status: 404, code: "resource_not_found", message: "Resource not found" }; }
function unauthenticated() { return { ok: false, status: 401, code: "membership_invitation_invalid", message: "Membership invitation or account proof is invalid" }; }
function rollbackNull(db) { db.exec("ROLLBACK"); return null; }
