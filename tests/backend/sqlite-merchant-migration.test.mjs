import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  applySqliteMerchantSchema,
  QUARANTINE_MERCHANT_ID
} from "../../services/platform-api/src/adapters/sqlite/merchant-schema.js";
import { Store } from "../../services/platform-api/src/store.js";

const LEGACY_TABLES = [
  "devices",
  "pairing_sessions",
  "connect_invitations",
  "connections",
  "transaction_contexts",
  "payment_requests"
];

const CORE_TABLES = [
  "merchant_accounts",
  "merchants",
  "merchant_memberships",
  "merchant_sessions",
  "merchant_domains",
  "agents",
  "agent_credentials",
  "agent_assertion_jtis",
  "recipients",
  "recipient_versions",
  "webhook_endpoints",
  "webhook_events",
  "webhook_deliveries",
  "audit_events"
];

function temporaryDatabase(t, prefix = "Paytobe-merchant-migration-") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, "relay-store.sqlite") };
}

function open(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

test("an empty database receives the complete tenant schema and merchant-first indexes", (t) => {
  const { file } = temporaryDatabase(t);
  const store = new Store(file);
  const info = store.info();
  store.close();

  assert.equal(info.schema_version, 3);
  assert.equal(info.merchant_migration.version, 3);
  assert.deepEqual(info.merchant_migration.before, Object.fromEntries(LEGACY_TABLES.map((table) => [table, 0])));

  const db = open(file);
  t.after(() => db.close());
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  for (const table of CORE_TABLES) assert.ok(tables.has(table), table);
  for (const table of LEGACY_TABLES) {
    const columns = Object.fromEntries(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => [row.name, row]));
    assert.equal(columns.merchant_id.notnull, 1, `${table}.merchant_id is NOT NULL`);
    assert.equal(columns.tenant_attribution.notnull, 1, `${table}.tenant_attribution is NOT NULL`);
    const leading = db.prepare(`PRAGMA index_info(${table}_merchant_idx)`).all()[0];
    assert.equal(leading.name, "merchant_id", `${table} tenant index starts with merchant_id`);
  }
  for (const index of db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%_tenant_idx'").all()) {
    assert.equal(db.prepare(`PRAGMA index_info(${index.name})`).all()[0].name, "merchant_id", index.name);
  }
});

test("a current relay snapshot is counted, explicitly attributed, quarantined when unknown, backed up, and not remigrated", (t) => {
  const { directory, file } = temporaryDatabase(t);
  const raw = open(file);
  raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  raw.exec("CREATE TABLE relay_state (id INTEGER PRIMARY KEY CHECK (id = 1), state_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
  raw.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)").run("2026-08-01T00:00:00.000Z");
  raw.prepare("INSERT INTO relay_state (id, state_json, updated_at) VALUES (1, ?, ?)").run(JSON.stringify({
    devices: {
      explicit: { device_id: "explicit", merchant_id: "merchant_a" },
      unknown: { device_id: "unknown" }
    },
    connections: {
      compatible: { connection_id: "compatible", tenant_id: "merchant_b", status: "active", scopes: [] }
    },
    transactionContexts: {
      context_a: { transaction_id: "context_a", merchant_id: "merchant_a" }
    },
    paymentRequests: {
      request_unknown: { request_id: "request_unknown", status: "pending" }
    }
  }), "2026-08-01T00:00:00.000Z");
  raw.close();

  const store = new Store(file);
  const firstReport = store.info().merchant_migration;
  assert.equal(firstReport.before.devices, 2);
  assert.equal(firstReport.before.connections, 1);
  assert.equal(firstReport.attribution.devices.explicit_merchant_id, 1);
  assert.equal(firstReport.attribution.devices.quarantined, 1);
  assert.equal(firstReport.attribution.connections.legacy_tenant_id, 1);
  assert.equal(firstReport.attribution.payment_requests.quarantined, 1);
  assert.ok(store.device("explicit"));
  assert.ok(store.device("unknown"));

  const backup = path.join(directory, "rollback.sqlite");
  store.backup(backup);
  store.close();

  const migrated = open(file);
  assert.deepEqual(
    migrated.prepare("SELECT k, merchant_id, tenant_attribution FROM devices ORDER BY k").all().map((row) => ({ ...row })),
    [
      { k: "explicit", merchant_id: "merchant_a", tenant_attribution: "explicit_merchant_id" },
      { k: "unknown", merchant_id: QUARANTINE_MERCHANT_ID, tenant_attribution: "quarantined" }
    ]
  );
  assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM platform_migration_reports").get().count, 1);
  migrated.close();

  const reopened = new Store(file);
  assert.deepEqual(reopened.info().merchant_migration, firstReport, "repeat execution reuses the original evidence report");
  reopened.close();

  const restored = new Store(backup);
  assert.equal(restored.info().schema_version, 3);
  assert.ok(restored.device("explicit"));
  assert.ok(restored.device("unknown"));
  restored.close();
});

test("an injected migration failure rolls back schema, attribution, and version together", (t) => {
  const { file } = temporaryDatabase(t);
  const db = open(file);
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)").run("2026-08-01T00:00:00.000Z");
  for (const table of LEGACY_TABLES) db.exec(`CREATE TABLE ${table} (k TEXT PRIMARY KEY, json TEXT NOT NULL)`);
  db.prepare("INSERT INTO devices (k, json) VALUES (?, ?)").run("d1", JSON.stringify({ device_id: "d1", merchant_id: "merchant_a" }));

  assert.throws(() => applySqliteMerchantSchema(db, { failAfterSchema: true }), /Injected merchant migration failure/);
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'merchants'").get().count, 0);
  assert.equal(db.prepare("PRAGMA table_info(devices)").all().some((column) => column.name === "merchant_id"), false);
  db.close();
});
