import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAdapterContractHarness, requestOptions } from "./platform-adapter-harness.mjs";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = JSON.parse(fs.readFileSync(path.join(codeRoot, "tests/fixtures/platform-adapter-contract.json"), "utf8"));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "velarumpay-adapter-contract-"));
const workerAgentToken = "agent_contract_test_token_1234567890";

process.env.VP_NO_AUTO_LISTEN = "1";
process.env.RELAY_STORE_DRIVER = "sqlite";
process.env.RELAY_STORE_PATH = path.join(tempRoot, "express.sqlite");
process.env.AUDIT_LOG_STDOUT = "false";

const [{ server }, { createTestWorker }] = await Promise.all([
  import("../../services/platform-api/src/server.js"),
  import("../../services/platform-api/edge-testnet/src/worker.mjs")
]);

const worker = createTestWorker({ AGENTFOOD_CLIENT_TOKEN: workerAgentToken });
let expressOrigin = "";

test.before(async () => {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      expressOrigin = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const adapters = {
  express_sqlite: createAdapterContractHarness({
    name: "express-sqlite",
    call: (pathname, options) => fetch(`${expressOrigin}${pathname}`, requestOptions(options))
  }),
  worker_d1: createAdapterContractHarness({
    name: "worker-d1",
    registeredAgentToken: workerAgentToken,
    call: (pathname, options) => worker.fetch(new Request(`https://worker.test${pathname}`, requestOptions(options)))
  })
};

test("the runtime-independent adapter interface exposes request normalization and reset", async () => {
  assert.equal(fixture.version, "velarum.platform-adapter-contract.v1");
  for (const adapter of Object.values(adapters)) {
    assert.equal(typeof adapter.reset, "function");
    assert.equal(typeof adapter.scenarioHealth, "function");
    assert.match(await adapter.reset(), /-1$/);
  }
});

test("one contract fixture drives health, errors, missing AuthContext, and idempotency conflict in both runtimes", async () => {
  const actual = {};
  for (const [runtime, adapter] of Object.entries(adapters)) {
    actual[runtime] = {
      health: await adapter.scenarioHealth(),
      error_envelope: await adapter.scenarioErrorEnvelope(),
      auth_context_missing: await adapter.scenarioMissingAuthContext(),
      idempotency_conflict: await adapter.scenarioIdempotencyConflict()
    };
  }
  const transposed = {};
  for (const scenario of Object.keys(fixture.scenarios)) {
    transposed[scenario] = {};
    for (const runtime of Object.keys(adapters)) transposed[scenario][runtime] = actual[runtime][scenario];
  }
  assert.deepEqual(transposed, fixture.scenarios);
});

test("every known runtime difference is explicit and has a removal task", () => {
  assert.ok(fixture.difference_allowlist.length > 0);
  for (const difference of fixture.difference_allowlist) {
    assert.ok(fixture.scenarios[difference.scenario], difference.id);
    assert.match(difference.remove_by_task, /^VP-TASK-\d{3}$/);
  }
  assert.ok(fixture.difference_allowlist.some((entry) => entry.id === "idempotency-conflict-not-enforced"));
});
