import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../services/platform-api/src/store.js";

// Regression coverage for H1: once the 1000-event buffer filled, the old code
// derived `seq` from `events.length`, pinning every later event at 1001. An
// agent polling `eventsSince(cursor)` would then never advance past 1001 and
// silently stop receiving status updates. These tests prove the sequence
// counter is now independent of the buffer size.

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Paytobe-store-"));
  const file = path.join(dir, "relay-store.json"); // .json => in-memory JSON driver
  const store = new Store(file);
  return { store, file, dir };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("event seq keeps increasing past the 1000-event buffer cap", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));

  for (let i = 0; i < 1500; i++) {
    store.event("payment_request.status", `prq_${i}`, { status: "pending" });
  }

  const events = store.state.events;
  assert.equal(events.length, 1000, "buffer is still capped at 1000 entries");
  assert.equal(events.at(-1).seq, 1500, "the 1500th event has seq 1500, not 1001");
  assert.equal(events[0].seq, 501, "buffer retains the most recent window (501..1500)");

  // Every retained seq is unique and strictly increasing.
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].seq > events[i - 1].seq, `seq must strictly increase at index ${i}`);
  }
});

test("an agent's ?since cursor never stalls, even after the buffer fills", (t) => {
  const { store, dir } = freshStore();
  t.after(() => cleanup(dir));

  let cursor = 0;
  let received = 0;

  // Simulate the real polling loop: emit an event, then have the agent read
  // everything newer than its cursor and advance. With the bug, the cursor
  // would freeze at 1001 and `received` would stop climbing.
  for (let i = 0; i < 1005; i++) {
    store.event("payment_request.status", "prq_live", { status: "broadcasted" });
    const batch = store.eventsSince(cursor);
    assert.ok(batch.length >= 1, `poll after event ${i} returned no new events (cursor stalled)`);
    received += batch.length;
    cursor = batch.at(-1).seq;
  }

  assert.equal(received, 1005, "agent observed every event exactly once");
  assert.equal(cursor, 1005, "cursor advanced past the old 1001 ceiling");
  assert.equal(store.eventsSince(cursor).length, 0, "no events remain newer than the cursor");
});

test("the seq counter persists across a restart", (t) => {
  const { store, file, dir } = freshStore();
  t.after(() => cleanup(dir));

  for (let i = 0; i < 5; i++) {
    store.event("pairing_session.created", `sess_${i}`, { status: "pending" });
  }
  store.save();
  store.close();

  // Reopen the same store file — a fresh process picking up persisted state.
  const reopened = new Store(file);
  assert.equal(reopened.state.eventSeq, 5, "persisted counter survives a restart");

  reopened.event("pairing_session.status", "sess_new", { status: "approved" });
  assert.equal(reopened.state.events.at(-1).seq, 6, "seq resumes from the persisted counter, not from length+1");
});

test("recovers a store already corrupted by the old length-based seq", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Paytobe-store-"));
  const file = path.join(dir, "relay-store.json");
  t.after(() => cleanup(dir));

  // Craft a pre-fix state: a full buffer where the tail events all share
  // seq 1001 (exactly what the old code produced) and no eventSeq field.
  const events = [];
  for (let i = 0; i < 999; i++) events.push({ seq: i + 2, type: "x", intent_id: `i${i}`, data: {}, at: "2026-06-18T00:00:00.000Z" });
  events.push({ seq: 1001, type: "x", intent_id: "dup", data: {}, at: "2026-06-18T00:00:00.000Z" });
  fs.writeFileSync(file, JSON.stringify({ events }));

  const store = new Store(file);
  // An agent that had already consumed up to the frozen 1001 ceiling:
  const stuckCursor = 1001;
  assert.equal(store.eventsSince(stuckCursor).length, 0, "precondition: agent is stuck at 1001");

  store.event("payment_request.status", "prq_after", { status: "confirmed" });
  const fresh = store.eventsSince(stuckCursor);
  assert.equal(fresh.length, 1, "the agent finally receives a new event after recovery");
  assert.ok(fresh[0].seq > 1001, "the recovered seq jumps above the frozen ceiling");
});
