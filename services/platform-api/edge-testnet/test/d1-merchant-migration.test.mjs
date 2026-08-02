import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "drizzle");
const migrationNames = [
  "0000_multitenant_connect_platform.sql",
  "0001_agentfood_registered_integration.sql",
  "0002_merchant_tenant_control_plane.sql",
  "0003_agentfood_standard_merchant.sql"
];

function database(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-d1-migration-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(directory, "d1.sqlite"));
  db.exec("PRAGMA foreign_keys = ON");
  t.after(() => db.close());
  return db;
}

function apply(db, names) {
  db.exec("CREATE TABLE IF NOT EXISTS d1_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const name of names) {
    if (db.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").get(name)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(fs.readFileSync(path.join(migrationDirectory, name), "utf8"));
      db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)").run(name, "2026-08-01T00:00:00.000Z");
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }
}

test("the new sequential migration creates the complete D1 tenant schema and merchant-first indexes", (t) => {
  const db = database(t);
  apply(db, [migrationNames[0], migrationNames[2]]);
  const required = [
    "merchant_accounts", "merchants", "merchant_memberships", "merchant_sessions", "merchant_domains",
    "agents", "agent_credentials", "agent_assertion_jtis", "recipients", "recipient_versions",
    "webhook_endpoints", "webhook_events", "webhook_deliveries", "audit_events"
  ];
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  for (const table of required) assert.ok(tables.has(table), table);
  for (const index of db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%_tenant_idx'").all()) {
    assert.equal(db.prepare(`PRAGMA index_info(${index.name})`).all()[0].name, "merchant_id", index.name);
  }
  for (const table of ["app_devices", "connect_invitations", "connections", "transaction_contexts", "payment_requests"]) {
    const merchant = db.prepare(`PRAGMA table_info(${table})`).all().find((column) => column.name === "merchant_id");
    assert.equal(merchant.notnull, 1, `${table}.merchant_id`);
  }
});

test("AgentFood compatibility data maps one-to-one without plaintext secrets", (t) => {
  const db = database(t);
  apply(db, migrationNames);
  assert.deepEqual({ ...db.prepare("SELECT merchant_id, display_name, status, verification_state FROM merchants WHERE merchant_id = 'agentfood'").get() }, {
    merchant_id: "agentfood",
    display_name: "AgentFood",
    status: "active",
    verification_state: "verified"
  });
  const agent = db.prepare("SELECT agent_id, merchant_id, status FROM agents WHERE agent_id = 'agentfood-testnet'").get();
  assert.deepEqual({ ...agent }, { agent_id: "agentfood-testnet", merchant_id: "agentfood", status: "active" });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM legacy_resource_mappings WHERE source_system = 'agentfood_legacy'").get().count, 5);
  const migrationSource = fs.readFileSync(path.join(migrationDirectory, migrationNames[3]), "utf8");
  assert.doesNotMatch(migrationSource, /secret_(?:plaintext|value)|BEGIN (?:PRIVATE|OPENSSH) KEY|seed phrase/i);
});

test("the D1 migration runner is repeatable and preserves append-only history", (t) => {
  const db = database(t);
  apply(db, migrationNames);
  apply(db, migrationNames);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM d1_migrations").get().count, migrationNames.length);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM merchants WHERE merchant_id = 'agentfood'").get().count, 1);
  assert.deepEqual(
    db.prepare("SELECT name FROM d1_migrations ORDER BY name").all().map((row) => row.name),
    migrationNames
  );
});
