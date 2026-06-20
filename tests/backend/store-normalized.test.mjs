import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../services/platform-api/src/store.js";

// Coverage for the schema-v2 normalization: the relay state is now persisted as
// one table per in-memory collection (devices, connections, payment_requests,
// …, events, meta) instead of a single JSON blob in relay_state(id=1). These
// tests lock three things: the one-time migration of an existing v1 blob store,
// that writes actually land in the per-entity tables (never the blob), and that
// the delta-write path keeps the tables exactly in sync — including DELETEs.

function freshSqlite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-norm-"));
  return { dir, file: path.join(dir, "relay-store.sqlite") };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function tableCount(file, table) {
  const db = new DatabaseSync(file);
  try {
    return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  } finally {
    db.close();
  }
}

test("a legacy v1 single-blob SQLite store migrates into the normalized tables once", (t) => {
  const { dir, file } = freshSqlite();
  t.after(() => cleanup(dir));

  // Hand-craft a v1 store: schema version 1 + the whole state in one blob row.
  const raw = new DatabaseSync(file);
  raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  raw.exec("CREATE TABLE relay_state (id INTEGER PRIMARY KEY CHECK (id = 1), state_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
  raw.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)").run("2026-06-18T00:00:00.000Z");
  const v1State = {
    devices: { dev1: { device_id: "dev1", token_hash: "sha256:deadbeef", registered_at: "t", last_seen_at: "t" } },
    events: [{ seq: 7, type: "payment_request.status", intent_id: "i", data: {}, at: "t" }],
    eventSeq: 7
  };
  raw.prepare("INSERT INTO relay_state (id, state_json, updated_at) VALUES (1, ?, ?)").run(JSON.stringify(v1State), "t");
  raw.close();

  // Opening it upgrades to v2 without losing data.
  const store = new Store(file);
  assert.equal(store.info().schema_version, 2, "store reports the normalized schema version");
  assert.ok(store.device("dev1"), "device survived the migration");
  assert.equal(store.state.eventSeq, 7, "persistent event counter survived");
  assert.equal(store.eventsSince(0).length, 1, "events survived");
  store.close();

  // The data now lives in the normalized tables, and the schema is stamped v2.
  assert.equal(tableCount(file, "devices"), 1, "device row moved into the devices table");
  assert.equal(tableCount(file, "events"), 1, "event row moved into the events table");
  const db = new DatabaseSync(file);
  const version = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v;
  db.close();
  assert.equal(version, 2, "schema stamped to v2 so the import never repeats");
});

test("writes land in per-entity tables, never the legacy blob row", (t) => {
  const { dir, file } = freshSqlite();
  t.after(() => cleanup(dir));

  const store = new Store(file);
  store.registerDevice("dev-x", "tok");
  store.putPaymentRequest({
    request_id: "prq1",
    status: "pending",
    created_at: "2026-06-20T00:00:00.000Z",
    connection_id: "c1",
    idempotency_key: "k1"
  });
  store.close();

  assert.equal(tableCount(file, "devices"), 1, "device is a row in the devices table");
  assert.equal(tableCount(file, "payment_requests"), 1, "payment request is a row in payment_requests");
  assert.equal(tableCount(file, "relay_state"), 0, "the single-blob row is never written under v2");
});

test("delta writes keep the tables exactly in sync, including deletes", (t) => {
  const { dir, file } = freshSqlite();
  t.after(() => cleanup(dir));

  const store = new Store(file);
  store.createConnection("conn1", "tok1", { scopes: ["payment.requests.read"], approved_by_device_id: "d1" });
  // Rotating the token deletes the old token-index row and inserts a new one;
  // the delta writer must DELETE the stale row, not leave it orphaned.
  store.rotateConnectionToken("conn1", "tok2");
  store.updateConnectionStatus("conn1", "revoked");
  store.close();

  assert.equal(tableCount(file, "connections"), 1, "exactly one connection row");
  assert.equal(tableCount(file, "connection_tokens"), 1, "old token index row was deleted, not orphaned");

  // The new token resolves; the old one does not.
  const reopened = new Store(file);
  t.after(() => reopened.close());
  assert.ok(reopened.connectionByToken("tok2"), "rotated token resolves after reopen");
  assert.equal(reopened.connectionByToken("tok1"), null, "old token no longer resolves");
  assert.equal(reopened.connection("conn1").status, "revoked", "status update persisted");
});

test("the 1000-event cap is reflected in the events table", (t) => {
  const { dir, file } = freshSqlite();
  t.after(() => cleanup(dir));

  const store = new Store(file);
  for (let i = 0; i < 1500; i++) store.event("payment_request.status", `p${i}`, { status: "pending" });
  store.save();
  store.close();

  assert.equal(tableCount(file, "events"), 1000, "events table is capped at 1000 rows");
  const db = new DatabaseSync(file);
  const minSeq = db.prepare("SELECT MIN(seq) AS s FROM events").get().s;
  db.close();
  assert.equal(minSeq, 501, "the oldest retained event is seq 501 (the recent window)");
});
