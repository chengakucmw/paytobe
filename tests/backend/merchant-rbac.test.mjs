import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MERCHANT_CAPABILITIES,
  MerchantMembershipService,
  roleAllows,
  SqliteMerchantMembershipRepository
} from "../../services/platform-api/src/application/merchant-memberships/service.js";
import { SqliteMerchantAccountRepository } from "../../services/platform-api/src/application/merchant-accounts/service.js";
import { SqliteMerchantSessionRepository } from "../../services/platform-api/src/application/merchant-sessions/service.js";
import { createClockPort } from "../../services/platform-api/src/ports/clock.js";
import { createRandomPort } from "../../services/platform-api/src/ports/random.js";
import { createTenantScope } from "../../services/platform-api/src/ports/tenant-repository.js";
import { createConnectKey, id, opaqueToken, tokenHash } from "../../services/platform-api/src/crypto.js";
import { Store } from "../../services/platform-api/src/store.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-merchant-rbac-"));
const store = new Store(path.join(directory, "platform.sqlite"));
new SqliteMerchantAccountRepository(store.db);
new SqliteMerchantSessionRepository(store.db);
const clock = createClockPort(() => new Date());
const service = new MerchantMembershipService({
  repository: new SqliteMerchantMembershipRepository(store.db),
  clock,
  random: createRandomPort({ id, opaqueToken, connectKey: createConnectKey }),
  hash: tokenHash
});
const at = clock.nowIso();

test.after(() => {
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function tenant(merchantId) {
  return createTenantScope(Object.freeze({ merchant_id: merchantId, actor_id: `actor_${merchantId}`, request_id: `request_${merchantId}` }));
}
const scopeA = tenant("merchant_a");
const scopeB = tenant("merchant_b");

function insertMerchant(merchantId) {
  store.db.prepare(`INSERT INTO merchants
    (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
    VALUES (?, ?, 'active', 'verified', 1, ?, ?)`).run(merchantId, merchantId, at, at);
}
function insertAccount(accountId, email) {
  store.db.prepare(`INSERT INTO merchant_accounts
    (account_id, email_normalized, status, version, created_at, updated_at)
    VALUES (?, ?, 'active', 1, ?, ?)`).run(accountId, email, at, at);
}
function insertMembership(membershipId, merchantId, accountId, role) {
  store.db.prepare(`INSERT INTO merchant_memberships
    (membership_id, merchant_id, account_id, role, status, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', 1, ?, ?)`).run(membershipId, merchantId, accountId, role, at, at);
}
function grant(accountId) {
  const token = opaqueToken("msgrant", 32);
  store.db.prepare(`INSERT INTO merchant_session_grants
    (grant_id, account_id, grant_hash, status, created_at, expires_at)
    VALUES (?, ?, ?, 'active', ?, ?)`).run(id("grant"), accountId, tokenHash(token), at, new Date(Date.now() + 300_000).toISOString());
  return token;
}
function activeSession(sessionId, merchantId, accountId) {
  store.db.prepare(`INSERT INTO merchant_sessions
    (session_id, merchant_id, account_id, token_hash, csrf_hash, status, expires_at, idle_expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
    .run(sessionId, merchantId, accountId, tokenHash(`${sessionId}_token`), tokenHash(`${sessionId}_csrf`),
      new Date(Date.now() + 3_600_000).toISOString(), new Date(Date.now() + 1_800_000).toISOString(), at, at);
}

test("the shared RBAC matrix separates merchant roles from Agent authority", () => {
  assert.deepEqual(Object.keys(MERCHANT_CAPABILITIES), ["owner", "admin", "developer", "viewer"]);
  for (const role of ["owner", "admin"]) assert.equal(roleAllows(role, "members.manage"), true);
  for (const role of ["developer", "viewer"]) assert.equal(roleAllows(role, "members.manage"), false);
  for (const role of ["owner", "admin", "developer"]) {
    assert.equal(roleAllows(role, "agents.manage"), true);
    assert.equal(roleAllows(role, "recipients.manage"), true);
    assert.equal(roleAllows(role, "webhooks.manage"), true);
  }
  assert.equal(roleAllows("viewer", "resources.read"), true);
  assert.equal(roleAllows("viewer", "agents.manage"), false);
  assert.equal(roleAllows("agent", "members.manage"), false);
  assert.equal(roleAllows("owner", "payment.requests.create"), false);
});

test("invitations are tenant/email/role-bound, hashed, one-time, and reject mismatched account proof", () => {
  insertMerchant("merchant_a");
  insertMerchant("merchant_b");
  insertAccount("owner_a", "owner-a@example.com");
  insertMembership("membership_owner_a", "merchant_a", "owner_a", "owner");
  insertAccount("developer_a", "developer-a@example.com");
  insertAccount("wrong_account", "wrong@example.com");

  const invitation = service.invite(scopeA, { account_id: "owner_a", role: "owner" }, {
    email: " Developer-A@Example.com ", role: "developer"
  });
  assert.equal(invitation.ok, true);
  assert.equal(invitation.invitation.merchant_id, "merchant_a");
  assert.equal(invitation.invitation.email_normalized, "developer-a@example.com");
  const stored = store.db.prepare("SELECT token_hash FROM merchant_membership_invitations WHERE invitation_id = ?")
    .get(invitation.invitation.invitation_id);
  assert.match(stored.token_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(stored.token_hash.includes(invitation.invitation_token), false);

  const mismatch = service.accept({ invitation_token: invitation.invitation_token, session_grant: grant("wrong_account"), merchant_id: "merchant_b" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "membership_invitation_invalid");

  const accepted = service.accept({ invitation_token: invitation.invitation_token, session_grant: grant("developer_a"), merchant_id: "merchant_b" });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.membership.merchant_id, "merchant_a", "claimed merchant_id cannot redirect acceptance");
  assert.equal(accepted.membership.role, "developer");
  const replay = service.accept({ invitation_token: invitation.invitation_token, session_grant: accepted.session_grant });
  assert.equal(replay.ok, false);
});

test("Viewer and Developer cannot manage members, Admin cannot grant Owner, and self elevation fails", () => {
  const deniedDeveloper = service.invite(scopeA, { account_id: "developer_a", role: "developer" }, { email: "x@example.com", role: "viewer" });
  const deniedViewer = service.invite(scopeA, { account_id: "viewer_a", role: "viewer" }, { email: "y@example.com", role: "viewer" });
  assert.equal(deniedDeveloper.code, "forbidden");
  assert.equal(deniedViewer.code, "forbidden");

  insertAccount("admin_a", "admin-a@example.com");
  insertMembership("membership_admin_a", "merchant_a", "admin_a", "admin");
  const adminInvite = service.invite(scopeA, { account_id: "admin_a", role: "admin" }, { email: "viewer-new@example.com", role: "viewer" });
  assert.equal(adminInvite.ok, true);
  const adminOwnerInvite = service.invite(scopeA, { account_id: "admin_a", role: "admin" }, { email: "owner-new@example.com", role: "owner" });
  assert.equal(adminOwnerInvite.code, "forbidden");
  const selfElevate = service.changeRole(scopeA, { account_id: "admin_a", role: "admin" }, "membership_admin_a", { role: "owner", version: 1 }, { allowSensitive: true });
  assert.equal(selfElevate.code, "forbidden");
});

test("last Owner protection and tenant filters prevent demotion, removal, and cross-tenant mutation", () => {
  const demoteLast = service.changeRole(scopeA, { account_id: "owner_a", role: "owner" }, "membership_owner_a", { role: "admin", version: 1 }, { allowSensitive: true });
  assert.equal(demoteLast.code, "last_owner_required");
  const removeLast = service.remove(scopeA, { account_id: "owner_a", role: "owner" }, "membership_owner_a", { version: 1 });
  assert.equal(removeLast.code, "last_owner_required");
  const cross = service.remove(scopeB, { account_id: "owner_b", role: "owner" }, "membership_admin_a", { version: 1 });
  assert.equal(cross.code, "resource_not_found");
});

test("role changes and removals revoke affected sessions in the same transaction", () => {
  activeSession("session_developer_a", "merchant_a", "developer_a");
  const target = store.db.prepare("SELECT * FROM merchant_memberships WHERE merchant_id = 'merchant_a' AND account_id = 'developer_a'").get();
  const changed = service.changeRole(scopeA, { account_id: "owner_a", role: "owner" }, target.membership_id, { role: "viewer", version: target.version });
  assert.equal(changed.ok, true);
  assert.equal(changed.membership.role, "viewer");
  assert.equal(store.db.prepare("SELECT status FROM merchant_sessions WHERE session_id = 'session_developer_a'").get().status, "revoked");

  activeSession("session_admin_a", "merchant_a", "admin_a");
  const removed = service.remove(scopeA, { account_id: "owner_a", role: "owner" }, "membership_admin_a", { version: 1 });
  assert.equal(removed.ok, true);
  assert.equal(removed.membership.status, "removed");
  assert.equal(store.db.prepare("SELECT status FROM merchant_sessions WHERE session_id = 'session_admin_a'").get().status, "revoked");
});
