import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  RecipientService,
  SqliteRecipientRepository
} from "../../services/platform-api/src/application/recipients/service.js";
import { D1RecipientRepository } from "../../services/platform-api/edge-testnet/src/recipient-repository.mjs";
import { createTenantScope } from "../../services/platform-api/src/ports/tenant-repository.js";
import { Store } from "../../services/platform-api/src/store.js";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const addressA = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const addressB = "GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H";

for (const runtime of ["express_sqlite", "worker_d1"]) {
  test(`${runtime} keeps Recipient payment facts tenant-scoped and immutable`, async (t) => {
    const adapter = runtime === "express_sqlite" ? sqliteAdapter(t) : d1Adapter(t);
    const service = new RecipientService({
      repository: adapter.repository,
      clock: fixedClock(),
      random: sequentialRandom(runtime)
    });
    const tenantA = scope("merchant_a");
    const tenantB = scope("merchant_b");
    adapter.seedMerchant("merchant_a");
    adapter.seedMerchant("merchant_b");

    const created = await service.create(tenantA, {
      name: "Primary treasury",
      network: "stellar_public",
      asset: "XLM",
      address: addressA,
      memo: "invoice-1"
    });
    assert.equal(created.ok, true);
    assert.equal(created.recipient.status, "draft");
    assert.equal(created.recipient.active_version_id, null);
    for (const fact of ["network", "asset", "address", "memo"]) {
      assert.equal(Object.hasOwn(created.recipient, fact), false, `${fact} never lives on Recipient`);
    }
    assert.deepEqual(
      pickFacts(created.recipient_version),
      { network: "stellar_public", asset: "XLM", address: addressA, memo: "invoice-1" }
    );

    const crossRecipient = await service.get(tenantB, created.recipient.recipient_id);
    const absentRecipient = await service.get(tenantB, "recipient_absent");
    assert.deepEqual(crossRecipient, absentRecipient);
    const crossVersion = await service.getVersion(tenantB, created.recipient.recipient_id, created.recipient_version.recipient_version_id);
    const absentVersion = await service.getVersion(tenantB, "recipient_absent", "recipient_version_absent");
    assert.deepEqual(crossVersion, absentVersion);
    assert.deepEqual((await service.list(tenantB)).items, []);

    const pinned = await service.pinVersionForPayment(tenantA, created.recipient.recipient_id, created.recipient_version.recipient_version_id);
    assert.equal(Object.isFrozen(pinned.recipient_snapshot), true);
    const second = await service.createVersion(tenantA, created.recipient.recipient_id, {
      network: "stellar_public",
      asset: "XLM",
      address: addressB,
      memo: "invoice-2",
      version: 1
    });
    assert.equal(second.ok, true);
    assert.equal(second.recipient.version, 2);
    assert.notEqual(second.recipient_version.recipient_version_id, created.recipient_version.recipient_version_id);
    assert.deepEqual(pickFacts(await adapter.repository.getVersion(
      tenantA, created.recipient.recipient_id, created.recipient_version.recipient_version_id
    )), pickFacts(created.recipient_version));

    const stale = await service.createVersion(tenantA, created.recipient.recipient_id, {
      network: "stellar_public", asset: "XLM", address: addressA, version: 1
    });
    assert.equal(stale.code, "concurrency_conflict");
    const inPlaceFacts = await service.update(tenantA, created.recipient.recipient_id, {
      address: addressB, version: 2
    });
    assert.equal(inPlaceFacts.status, 404);

    const removed = await service.update(tenantA, created.recipient.recipient_id, { status: "revoked", version: 2 });
    assert.equal(removed.recipient.status, "revoked");
    const historical = await service.pinVersionForPayment(tenantA, created.recipient.recipient_id, created.recipient_version.recipient_version_id);
    assert.deepEqual(historical.recipient_snapshot, pinned.recipient_snapshot);
    assert.deepEqual(pickFacts(historical.recipient_snapshot), pickFacts(created.recipient_version));
    assert.equal((await service.listVersions(tenantA, created.recipient.recipient_id)).items.length, 2);

    const events = adapter.audit("merchant_a", created.recipient.recipient_id);
    assert.deepEqual(events.map((event) => event.action), ["recipient.created", "recipient.version_created", "recipient.status_changed"]);
    assert.equal(events.every((event) => !event.details_json.includes(addressA) && !event.details_json.includes(addressB)), true);
  });
}

function sqliteAdapter(t) {
  const directory = temporaryDirectory(t);
  const store = new Store(path.join(directory, "recipient.sqlite"));
  t.after(() => store.close());
  return {
    repository: new SqliteRecipientRepository(store.db),
    seedMerchant: (merchantId) => seedMerchant(store.db, merchantId),
    audit: (merchantId, resourceId) => store.db.prepare(`SELECT action, details_json FROM audit_events
      WHERE merchant_id = ? AND resource_id = ? ORDER BY occurred_at, audit_event_id`).all(merchantId, resourceId)
  };
}

function d1Adapter(t) {
  const directory = temporaryDirectory(t);
  const sqlite = new DatabaseSync(path.join(directory, "recipient-d1.sqlite"));
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const migration of ["0000_multitenant_connect_platform.sql", "0002_merchant_tenant_control_plane.sql"]) {
    sqlite.exec(fs.readFileSync(path.join(codeRoot, "services/platform-api/edge-testnet/drizzle", migration), "utf8"));
  }
  t.after(() => sqlite.close());
  const d1 = new D1Database(sqlite);
  return {
    repository: new D1RecipientRepository(d1),
    seedMerchant: (merchantId) => seedMerchant(sqlite, merchantId),
    audit: (merchantId, resourceId) => sqlite.prepare(`SELECT action, details_json FROM audit_events
      WHERE merchant_id = ? AND resource_id = ? ORDER BY occurred_at, audit_event_id`).all(merchantId, resourceId)
  };
}

function seedMerchant(db, merchantId) {
  const at = "2026-08-01T16:45:00.000Z";
  db.prepare(`INSERT INTO merchants
    (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
    VALUES (?, ?, 'active', 'verified', 1, ?, ?)`).run(merchantId, merchantId, at, at);
}

function fixedClock() {
  return { nowIso: () => "2026-08-01T16:45:00.000Z" };
}

function sequentialRandom(prefix) {
  let counter = 0;
  return { id: (type) => `${type}_${prefix}_${String(++counter).padStart(4, "0")}` };
}

function scope(merchantId) {
  return createTenantScope(Object.freeze({
    merchant_id: merchantId,
    actor_id: `owner_${merchantId}`,
    request_id: `request_${merchantId}`
  }));
}

function pickFacts(value) {
  return { network: value.network, asset: value.asset, address: value.address, memo: value.memo };
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-recipient-registry-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

class D1Database {
  constructor(db) { this.db = db; }
  prepare(sql) { return new D1Statement(this.db.prepare(sql)); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }
}

class D1Statement {
  constructor(statement) { this.statement = statement; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { const row = this.statement.get(...this.values); return row ? { ...row } : null; }
  async all() { return { results: this.statement.all(...this.values).map((row) => ({ ...row })) }; }
  async run() { const result = this.statement.run(...this.values); return { meta: { changes: Number(result.changes || 0) } }; }
}
