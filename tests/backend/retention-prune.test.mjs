import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../services/platform-api/src/store.js";

// Coverage for retention pruning (store.pruneTerminal). It must drop terminal,
// old payment requests / intents (plus their idempotency back-references and any
// stray reservation) and old UNreferenced transaction contexts, while never
// touching in-flight records, recent terminal records, or contexts a surviving
// record still references. Pruning keeps the store bounded so the per-write
// reload+snapshot cost stays small as history accumulates.

function freshSqlite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-prune-"));
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

function seedStore(store) {
  const OLD = "2020-01-01T00:00:00.000Z";
  const NOW = new Date().toISOString();
  store.state.paymentRequests = {
    oldDone: { request_id: "oldDone", status: "confirmed", created_at: OLD, updated_at: OLD, transaction_id: "txOrphan", connection_id: "c1", idempotency_key: "k1" },
    recentDone: { request_id: "recentDone", status: "confirmed", created_at: NOW, updated_at: NOW },
    oldPending: { request_id: "oldPending", status: "pending", created_at: OLD, updated_at: OLD },
    livePending: { request_id: "livePending", status: "pending", created_at: NOW, updated_at: NOW, transaction_id: "txLive" }
  };
  store.state.paymentRequestIdempotency = { "c1:k1": "oldDone" };
  store.state.intents = {
    oldIntent: { intent_id: "oldIntent", status: "failed", created_at: OLD, updated_at: OLD, idempotency_key: "ik1", target_app_device_id: "d1" },
    livesignedIntent: { intent_id: "livesignedIntent", status: "broadcasted", created_at: OLD, updated_at: OLD }
  };
  store.state.idempotency = { "d1:ik1": "oldIntent" };
  store.state.transactionContexts = {
    txOrphan: { transaction_id: "txOrphan", status: "confirmed", created_at: OLD, updated_at: OLD },
    txLive: { transaction_id: "txLive", status: "pending", created_at: OLD, updated_at: OLD }
  };
  // A stray held reservation on a record that is about to be pruned.
  store.state.reservations = { oldDone: { asset: "XLM", amount: "1.0000000", day: "2020-01-01", state: "held" } };
  store.save();
}

test("pruneTerminal drops only terminal, old records and their back-references", (t) => {
  const { dir, file } = freshSqlite();
  t.after(() => cleanup(dir));

  const store = new Store(file);
  t.after(() => store.close());
  seedStore(store);

  const pruned = store.pruneTerminal(Date.now(), 24 * 60 * 60 * 1000); // 1-day TTL

  assert.equal(pruned, 3, "pruned the old confirmed request, the old failed intent, and the orphan context");

  // Terminal + old → gone.
  assert.equal(store.paymentRequest("oldDone"), null, "old confirmed request pruned");
  assert.equal(store.intent("oldIntent"), undefined, "old failed intent pruned");
  assert.equal(store.transactionContext("txOrphan"), null, "old unreferenced context pruned");

  // In-flight or recent → kept.
  assert.ok(store.paymentRequest("recentDone"), "recent confirmed request kept (not old)");
  assert.ok(store.paymentRequest("oldPending"), "old pending request kept (not terminal)");
  assert.ok(store.paymentRequest("livePending"), "live pending request kept");
  assert.ok(store.intent("livesignedIntent"), "broadcasted intent kept (not terminal)");
  assert.ok(store.transactionContext("txLive"), "context referenced by a live request kept");

  // Back-references cleaned so a pruned record can't be resurrected via idempotency.
  assert.equal(store.findPaymentRequestByIdempotency("k1", "c1"), null, "request idempotency entry removed");
  assert.equal(store.findByIdempotency("ik1", "d1"), null, "intent idempotency entry removed");
  // Stray reservation released.
  assert.equal(store.state.reservations.oldDone, undefined, "held reservation on the pruned record released");
});

test("pruneTerminal is a no-op when nothing is old enough or when disabled", (t) => {
  const { dir, file } = freshSqlite();
  t.after(() => cleanup(dir));

  const store = new Store(file);
  t.after(() => store.close());
  seedStore(store);

  assert.equal(store.pruneTerminal(Date.now(), 100 * 365 * 24 * 60 * 60 * 1000), 0, "huge TTL prunes nothing");
  assert.equal(store.pruneTerminal(Date.now(), 0), 0, "ttl 0 disables pruning");
  assert.ok(store.paymentRequest("oldDone"), "record still present after no-op prunes");
});

test("a prune persists to the normalized tables (survives reopen)", (t) => {
  const { dir, file } = freshSqlite();
  t.after(() => cleanup(dir));

  const store = new Store(file);
  seedStore(store);
  store.pruneTerminal(Date.now(), 24 * 60 * 60 * 1000);
  store.close();

  // 4 seeded requests minus the 1 pruned terminal one = 3 rows on disk.
  assert.equal(tableCount(file, "payment_requests"), 3, "pruned request row deleted on disk");
  assert.equal(tableCount(file, "intents"), 1, "pruned intent row deleted on disk");
  assert.equal(tableCount(file, "transaction_contexts"), 1, "orphan context row deleted on disk");

  const reopened = new Store(file);
  t.after(() => reopened.close());
  assert.equal(reopened.paymentRequest("oldDone"), null, "prune survived reopen");
  assert.ok(reopened.paymentRequest("recentDone"), "kept record survived reopen");
});
