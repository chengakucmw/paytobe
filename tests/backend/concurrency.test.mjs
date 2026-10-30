import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../services/platform-api/src/store.js";

// Regression coverage for H4: the store keeps the entire database in memory and
// persists it as one JSON blob. The old code read that blob ONCE at startup and
// then rewrote the whole thing on every change from its cached copy. Two
// writers — a second API instance, or the backup/maintenance scripts running
// beside the server — each overwrote the other's blob wholesale, silently
// dropping the other's updates (a classic lost update: the "read" happened at
// load time, far from the "write").
//
// The fix routes every mutation through store.mutate(), which on the SQLite
// driver holds the read and the write together: BEGIN IMMEDIATE takes the write
// lock, the latest committed blob is RE-READ inside that lock, the change is
// applied to that fresh state, and only then is it written back and COMMITed.
// These tests model two processes as two Store instances over one SQLite file.

function freshSqlitePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Paytobe-concurrency-"));
  return { dir, file: path.join(dir, "relay-store.sqlite") }; // .sqlite => SQLite driver
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("a second writer's whole-store save does not clobber the first writer's record", (t) => {
  const { dir, file } = freshSqlitePath();
  t.after(() => cleanup(dir));

  // Two independent processes, each with its own in-memory snapshot of the store.
  const a = new Store(file);
  const b = new Store(file);
  t.after(() => { a.close(); b.close(); });

  a.registerDevice("dev-a", "tok-a");

  // Precondition: b loaded before dev-a existed, so its cached snapshot is stale.
  // This is exactly the condition that produced lost writes under the old code.
  assert.equal(b.device("dev-a"), undefined, "b's cached snapshot has not seen dev-a");

  // With the bug, b would now overwrite the row with its stale snapshot and erase
  // dev-a. With the fix, b re-reads the committed row under the write lock first.
  b.registerDevice("dev-b", "tok-b");

  const reopened = new Store(file);
  t.after(() => reopened.close());
  assert.ok(reopened.device("dev-a"), "dev-a survived the concurrent writer (no lost update)");
  assert.ok(reopened.device("dev-b"), "dev-b was persisted");
});

test("concurrent daily-spend writers accumulate exactly instead of losing spend", (t) => {
  const { dir, file } = freshSqlitePath();
  t.after(() => cleanup(dir));

  // The money-safety case: two parallel confirmations each record spend. If one
  // overwrites the other, the daily cap under-counts and lets spend slip past it.
  const a = new Store(file);
  const b = new Store(file);
  t.after(() => { a.close(); b.close(); });

  a.addDailySpent("XLM", "0.4");
  assert.equal(b.dailySpent("XLM"), "0", "b's cached snapshot has not seen a's spend yet");

  b.addDailySpent("XLM", "0.4");

  const reopened = new Store(file);
  t.after(() => reopened.close());
  // 0.4 + 0.4 must be recorded exactly; under the bug b's write left it at 0.4.
  assert.equal(reopened.dailySpent("XLM"), "0.8", "both spends accumulated, none lost");
});

test("interleaved payment intents from two writers both persist", (t) => {
  const { dir, file } = freshSqlitePath();
  t.after(() => cleanup(dir));

  const a = new Store(file);
  const b = new Store(file);
  t.after(() => { a.close(); b.close(); });

  const baseIntent = (id) => ({
    intent_id: id,
    status: "pending",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    target_app_device_id: "dev-1",
    payment: { rail: "stellar_xlm", asset: "XLM", amount: "1", to: `G${"A".repeat(55)}` }
  });

  a.putIntent(baseIntent("pi_a"));
  b.putIntent(baseIntent("pi_b"));

  const reopened = new Store(file);
  t.after(() => reopened.close());
  assert.ok(reopened.intent("pi_a"), "intent from writer A survived");
  assert.ok(reopened.intent("pi_b"), "intent from writer B survived");

  // The persistent event sequence must also stay monotonic across writers, not
  // collide — each put emitted one event, so the latest seq must be at least 2.
  const events = reopened.state.events;
  const seqs = events.map((event) => event.seq);
  assert.equal(new Set(seqs).size, seqs.length, "event sequence numbers are unique across writers");
});

test("a single writer still reads back its own committed state", (t) => {
  const { dir, file } = freshSqlitePath();
  t.after(() => cleanup(dir));

  // Guards against the wrapper accidentally discarding the just-applied change.
  const store = new Store(file);
  t.after(() => store.close());

  const device = store.registerDevice("dev-solo", "tok");
  assert.equal(device.device_id, "dev-solo", "mutate returns the applied result");
  assert.ok(store.device("dev-solo"), "the change is visible in the same instance");

  store.addDailySpent("USDC", "2.5");
  store.addDailySpent("USDC", "0.5");
  assert.equal(store.dailySpent("USDC"), "3", "sequential writes on one instance accumulate");
});
