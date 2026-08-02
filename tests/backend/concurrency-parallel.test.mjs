import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { Store } from "../../services/platform-api/src/store.js";

// concurrency.test.mjs models two writers SEQUENTIALLY (two Store instances in
// the same thread), which proves the read-modify-write logic but not that the
// SQLite locking actually holds under genuine parallelism. This file spawns real
// worker_threads that hammer ONE SQLite file at the same time, so the BEGIN
// IMMEDIATE write lock + in-lock re-read (the H4 / F1 fix) is exercised under
// true contention:
//   - every increment must survive (exact accumulation, no lost spend), and
//   - every worker's device row must survive (no lost update on a sibling row).
// If the lock or the delta-persist regressed, the totals come up short here even
// though the single-threaded test still passes.

const storeUrl = new URL("../../services/platform-api/src/store.js", import.meta.url).href;

// One worker: open its own connection to the shared SQLite file, record many
// small spends and register its own device, then close. Written as a data: URL
// module so the whole test stays self-contained (no sidecar worker file that the
// *.test.mjs glob might try to run on its own).
function workerSource() {
  return `
    import { workerData, parentPort } from "node:worker_threads";
    import { Store } from ${JSON.stringify(storeUrl)};
    const store = new Store(workerData.file);
    try {
      for (let i = 0; i < workerData.iterations; i++) {
        store.addDailySpent(workerData.asset, workerData.addend);
      }
      store.registerDevice("dev-" + workerData.id, "tok-" + workerData.id);
      parentPort.postMessage({ ok: true });
    } catch (error) {
      parentPort.postMessage({ ok: false, error: String(error && error.stack || error) });
    } finally {
      store.close();
    }
  `;
}

function runWorker(file, { id, iterations, asset, addend }) {
  const url = new URL(`data:text/javascript,${encodeURIComponent(workerSource())}`);
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, { workerData: { file, id, iterations, asset, addend } });
    let report = null;
    // Capture the worker's verdict, but only settle on "exit": that is the point
    // at which the worker's `finally { store.close() }` has run and its SQLite
    // connection is fully released, so the main thread can safely reopen without
    // racing a still-closing writer.
    worker.once("message", (msg) => { report = msg; });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`worker ${id} exited with code ${code}`));
      if (report && report.ok === false) return reject(new Error(`worker ${id} failed: ${report.error}`));
      resolve();
    });
  });
}

test("parallel writers accumulate daily spend exactly under real SQLite contention", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-parallel-"));
  const file = path.join(dir, "relay-store.sqlite"); // .sqlite => SQLite driver (cross-connection locking)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Create the schema before the workers race so every worker opens an existing,
  // initialized database (mirrors a running server that workers connect beside).
  const seed = new Store(file);
  assert.equal(seed.info().driver, "sqlite", "test must exercise the SQLite driver, not JSON");
  seed.close();

  const WORKERS = 4;
  const ITERATIONS = 250;
  const ADDEND = "0.001";
  const ASSET = "XLM";

  await Promise.all(
    Array.from({ length: WORKERS }, (_, id) => runWorker(file, { id, iterations: ITERATIONS, asset: ASSET, addend: ADDEND }))
  );

  const reopened = new Store(file);
  t.after(() => reopened.close());

  // 4 workers * 250 * 0.001 == exactly 1. A single lost or double-counted write
  // under contention would move this off "1" (float drift would read ~0.9999…).
  assert.equal(reopened.dailySpent(ASSET), "1", "parallel daily-spend total drifted — a write was lost or double-counted");

  // Every worker's device must have survived its siblings' concurrent commits.
  for (let id = 0; id < WORKERS; id++) {
    assert.ok(reopened.device(`dev-${id}`), `dev-${id} was lost under concurrent registration`);
  }
});

test("parallel writers on two assets keep each cap independent and exact", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-parallel-2-"));
  const file = path.join(dir, "relay-store.sqlite");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const seed = new Store(file);
  seed.close();

  // Two workers on XLM, two on USDC — interleaved commits must not bleed one
  // asset's spend into the other's day-key bucket.
  await Promise.all([
    runWorker(file, { id: 0, iterations: 200, asset: "XLM", addend: "0.01" }),
    runWorker(file, { id: 1, iterations: 200, asset: "XLM", addend: "0.01" }),
    runWorker(file, { id: 2, iterations: 200, asset: "USDC", addend: "0.05" }),
    runWorker(file, { id: 3, iterations: 200, asset: "USDC", addend: "0.05" })
  ]);

  const reopened = new Store(file);
  t.after(() => reopened.close());

  // XLM: 2 * 200 * 0.01 == 4 ; USDC: 2 * 200 * 0.05 == 20.
  assert.equal(reopened.dailySpent("XLM"), "4", "XLM total drifted under contention");
  assert.equal(reopened.dailySpent("USDC"), "20", "USDC total drifted under contention");
});
