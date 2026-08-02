import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

import {
  RECIPIENT_COOLING_MS,
  RecipientService,
  SqliteRecipientRepository
} from "../../services/platform-api/src/application/recipients/service.js";
import { SqliteRecipientEvidenceVerifier } from "../../services/platform-api/src/application/recipients/evidence.js";
import { createRecipientsRouter } from "../../services/platform-api/src/routes/recipients.js";
import { tokenHash } from "../../services/platform-api/src/crypto.js";
import { createTenantScope } from "../../services/platform-api/src/ports/tenant-repository.js";
import { Store } from "../../services/platform-api/src/store.js";

const addressA = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const addressB = "GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H";
const start = Date.parse("2026-08-01T16:50:00.000Z");

test("evidence, mandatory cooling, owner notification, activation, suspension, and revoke use the controlled Clock", async (t) => {
  const runtime = sqliteRuntime(t);
  const clock = controlledClock(start);
  const service = recipientService(runtime, clock);
  const tenant = scope("merchant_a");
  runtime.seedTenant("merchant_a", "owner_a", "owner");

  const created = await service.create(tenant, recipientInput(addressA));
  assert.equal(Date.parse(created.recipient_version.cooling_until) - Date.parse(created.recipient_version.cooling_started_at), RECIPIENT_COOLING_MS);
  assert.equal(created.recipient_version.verification_state, "unverified");
  const notification = runtime.db.prepare("SELECT * FROM recipient_owner_notifications WHERE merchant_id = ?").get("merchant_a");
  assert.equal(notification.audience_role, "owner");
  assert.equal(notification.status, "pending");
  assert.equal(notification.cooling_until, created.recipient_version.cooling_until);
  assert.equal(runtime.db.prepare(`SELECT COUNT(*) AS count FROM merchant_memberships
    WHERE merchant_id = ? AND role = 'owner' AND status = 'active'`).get("merchant_a").count, 1);

  const source = runtime.seedEvidenceSource({
    merchantId: "merchant_a",
    type: "address_control",
    facts: created.recipient_version,
    verifiedAt: clock.nowIso()
  });
  const verified = await service.verify(tenant, created.recipient.recipient_id, {
    recipient_version_id: created.recipient_version.recipient_version_id,
    type: "address_control",
    source_id: source.source_id,
    evidence_digest: source.evidence_digest,
    version: 1
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.recipient.status, "pending_verification");
  assert.equal(verified.recipient.version, 2);
  assert.equal(verified.recipient_version.verification_state, "verified_cooling");

  const early = await service.activate(tenant, created.recipient.recipient_id, activation(verified, 2));
  assert.equal(early.code, "recipient_cooling_active");
  clock.advance(RECIPIENT_COOLING_MS - 1);
  assert.equal((await service.activate(tenant, created.recipient.recipient_id, activation(verified, 2))).code, "recipient_cooling_active");
  clock.set(start - 1);
  assert.equal((await service.activate(tenant, created.recipient.recipient_id, activation(verified, 2))).code, "clock_rollback_detected");

  clock.set(start + RECIPIENT_COOLING_MS);
  const activated = await service.activate(tenant, created.recipient.recipient_id, activation(verified, 2));
  assert.equal(activated.ok, true);
  assert.equal(activated.recipient.status, "active");
  assert.equal(activated.recipient.active_version_id, created.recipient_version.recipient_version_id);
  assert.equal(activated.recipient_version.verification_state, "active");
  assert.equal((await service.usableForNewRequest(tenant, activated.recipient.recipient_id)).ok, true);

  const suspended = await service.update(tenant, activated.recipient.recipient_id, { status: "suspended", version: 3 });
  assert.equal(suspended.recipient.active_version_id, null);
  assert.equal((await service.usableForNewRequest(tenant, activated.recipient.recipient_id)).status, 404);
  assert.equal((await service.activate(tenant, activated.recipient.recipient_id, activation(verified, 4))).code, "recipient_not_usable");
  const revoked = await service.update(tenant, activated.recipient.recipient_id, { status: "revoked", version: 4 });
  assert.equal(revoked.recipient.status, "revoked");
  assert.equal((await service.usableForNewRequest(tenant, activated.recipient.recipient_id)).status, 404);

  const audit = runtime.db.prepare("SELECT action, details_json FROM audit_events WHERE resource_id = ? ORDER BY occurred_at, audit_event_id")
    .all(created.recipient.recipient_id);
  assert.deepEqual(audit.map((event) => event.action), [
    "recipient.created", "recipient.verified", "recipient.activated", "recipient.status_changed", "recipient.status_changed"
  ]);
  assert.equal(audit.every((event) => !event.details_json.includes(source.evidence_digest) && !event.details_json.includes(addressA)), true);
});

test("all evidence types are extensible trusted sources and tenant/facts/digest mismatches fail closed", async (t) => {
  const runtime = sqliteRuntime(t);
  const clock = controlledClock(start);
  const service = recipientService(runtime, clock);
  const tenantA = scope("merchant_a");
  const tenantB = scope("merchant_b");
  runtime.seedTenant("merchant_a", "owner_a", "owner");
  runtime.seedTenant("merchant_b", "owner_b", "owner");

  for (const type of ["domain_proof", "address_control", "reviewed_operational"]) {
    const created = await service.create(tenantA, recipientInput(addressA, type));
    const source = runtime.seedEvidenceSource({ merchantId: "merchant_a", type, facts: created.recipient_version, verifiedAt: clock.nowIso() });
    const result = await service.verify(tenantA, created.recipient.recipient_id, {
      recipient_version_id: created.recipient_version.recipient_version_id,
      type,
      source_id: source.source_id,
      version: 1
    });
    assert.equal(result.ok, true, type);
  }

  const cross = await service.create(tenantA, recipientInput(addressB, "cross"));
  const sourceB = runtime.seedEvidenceSource({ merchantId: "merchant_b", type: "domain_proof", facts: cross.recipient_version, verifiedAt: clock.nowIso() });
  const crossResult = await service.verify(tenantA, cross.recipient.recipient_id, {
    recipient_version_id: cross.recipient_version.recipient_version_id,
    type: "domain_proof",
    source_id: sourceB.source_id,
    version: 1
  });
  const absentResult = await service.verify(tenantA, cross.recipient.recipient_id, {
    recipient_version_id: cross.recipient_version.recipient_version_id,
    type: "domain_proof",
    source_id: "source_absent",
    version: 1
  });
  assert.deepEqual(crossResult, absentResult);

  const wrongFacts = runtime.seedEvidenceSource({
    merchantId: "merchant_a",
    type: "address_control",
    facts: { ...cross.recipient_version, address: addressA },
    verifiedAt: clock.nowIso()
  });
  assert.equal((await service.verify(tenantA, cross.recipient.recipient_id, {
    recipient_version_id: cross.recipient_version.recipient_version_id,
    type: "address_control",
    source_id: wrongFacts.source_id,
    version: 1
  })).code, "recipient_evidence_facts_mismatch");

  const correct = runtime.seedEvidenceSource({ merchantId: "merchant_a", type: "address_control", facts: cross.recipient_version, verifiedAt: clock.nowIso() });
  const verified = await service.verify(tenantA, cross.recipient.recipient_id, {
    recipient_version_id: cross.recipient_version.recipient_version_id,
    type: "address_control",
    source_id: correct.source_id,
    version: 1
  });
  clock.advance(RECIPIENT_COOLING_MS);
  const wrongDigest = await service.activate(tenantA, cross.recipient.recipient_id, {
    ...activation(verified, 2),
    evidence_digest: "digest_from_old_facts"
  });
  assert.equal(wrongDigest.code, "recipient_evidence_digest_mismatch");

  const newVersion = await service.createVersion(tenantA, cross.recipient.recipient_id, {
    rail: "stellar_xlm", network: "stellar_testnet", asset: "XLM", address: addressA, memo: "replacement",
    version: 2
  });
  clock.advance(RECIPIENT_COOLING_MS);
  assert.equal((await service.activate(tenantA, cross.recipient.recipient_id, {
    recipient_version_id: newVersion.recipient_version.recipient_version_id,
    evidence_id: verified.evidence.evidence_id,
    evidence_digest: verified.evidence.evidence_digest,
    version: 3
  })).status, 404);
});

test("activation route requires both a managing role and fresh step-up", async (t) => {
  let calls = 0;
  const app = express();
  app.use(express.json());
  app.use("/v1/recipients", createRecipientsRouter({
    recipientService: {
      activate: async () => {
        calls += 1;
        return { ok: true, recipient: { recipient_id: "recipient_1", status: "active", version: 2 } };
      }
    },
    verifyMerchantSession: authFromRequest,
    requireMerchantStepUp: (req) => req.headers["x-step-up"] === "fresh"
      ? authFromRequest(req)
      : { ok: false, status: 403, code: "step_up_required", message: "Fresh step-up authentication is required" },
    sendApiError: (res, status, code, message) => res.status(status).json({ error: { code, message } }),
    observability: { recordAuditEvent() {} }
  }));
  const server = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const noStep = await post(origin, "admin", "");
  assert.equal(noStep.status, 403);
  assert.equal((await noStep.json()).error.code, "step_up_required");
  const viewer = await post(origin, "viewer", "fresh");
  assert.equal(viewer.status, 403);
  assert.equal((await viewer.json()).error.code, "forbidden");
  const admin = await post(origin, "admin", "fresh");
  assert.equal(admin.status, 200);
  assert.equal(calls, 1);
});

function sqliteRuntime(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-recipient-verification-"));
  const store = new Store(path.join(directory, "recipient.sqlite"));
  const repository = new SqliteRecipientRepository(store.db);
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let sourceCounter = 0;
  return {
    db: store.db,
    repository,
    verifier: new SqliteRecipientEvidenceVerifier(store.db),
    seedTenant(merchantId, accountId, role) {
      const at = new Date(start).toISOString();
      store.db.prepare(`INSERT INTO merchants
        (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
        VALUES (?, ?, 'active', 'verified', 1, ?, ?)`).run(merchantId, merchantId, at, at);
      store.db.prepare(`INSERT INTO merchant_accounts
        (account_id, email_normalized, status, version, created_at, updated_at)
        VALUES (?, ?, 'active', 1, ?, ?)`).run(accountId, `${accountId}@example.invalid`, at, at);
      store.db.prepare(`INSERT INTO merchant_memberships
        (membership_id, merchant_id, account_id, role, status, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', 1, ?, ?)`).run(`membership_${accountId}`, merchantId, accountId, role, at, at);
    },
    seedEvidenceSource({ merchantId, type, facts, verifiedAt }) {
      const sourceId = `source_${++sourceCounter}`;
      const factsDigest = digestFacts(facts);
      const evidenceDigest = tokenHash(`${type}:${sourceId}:${factsDigest}`);
      store.db.prepare(`INSERT INTO recipient_verification_sources
        (source_id, merchant_id, type, status, evidence_digest, facts_digest, verified_at, created_at)
        VALUES (?, ?, ?, 'verified', ?, ?, ?, ?)`).run(sourceId, merchantId, type, evidenceDigest, factsDigest, verifiedAt, verifiedAt);
      return { source_id: sourceId, evidence_digest: evidenceDigest, facts_digest: factsDigest };
    }
  };
}

function recipientService(runtime, clock) {
  let counter = 0;
  return new RecipientService({
    repository: runtime.repository,
    evidenceVerifier: runtime.verifier,
    clock,
    random: { id: (prefix) => `${prefix}_${String(++counter).padStart(6, "0")}` },
    hash: tokenHash
  });
}

function controlledClock(initial) {
  let current = initial;
  return {
    now: () => new Date(current),
    nowIso: () => new Date(current).toISOString(),
    advance: (milliseconds) => { current += milliseconds; },
    set: (milliseconds) => { current = milliseconds; }
  };
}

function scope(merchantId) {
  return createTenantScope(Object.freeze({ merchant_id: merchantId, actor_id: `owner_${merchantId}`, request_id: `request_${merchantId}` }));
}

function recipientInput(address, suffix = "") {
  return {
    name: `Treasury ${suffix}`.trim(),
    rail: "stellar_xlm",
    network: "stellar_testnet",
    asset: "XLM",
    address,
    ...(suffix ? { memo: suffix } : {})
  };
}

function activation(verified, version) {
  return {
    recipient_version_id: verified.recipient_version.recipient_version_id,
    evidence_id: verified.evidence.evidence_id,
    evidence_digest: verified.evidence.evidence_digest,
    version
  };
}

function digestFacts(value) {
  return tokenHash(JSON.stringify([value.network, value.asset, value.address, value.memo ?? null]));
}

function authFromRequest(req) {
  return {
    ok: true,
    auth_context: Object.freeze({
      merchant_id: "merchant_route",
      actor_id: "account_route",
      request_id: "request_route",
      role: String(req.headers["x-role"] || "viewer")
    })
  };
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}

function post(origin, role, stepUp) {
  return fetch(`${origin}/v1/recipients/recipient_1/versions/version_1/activate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-role": role, ...(stepUp ? { "x-step-up": stepUp } : {}) },
    body: JSON.stringify({ evidence_id: "evidence_1", evidence_digest: "digest", version: 1 })
  });
}
