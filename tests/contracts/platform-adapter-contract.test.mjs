import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAdapterContractHarness, requestOptions } from "./platform-adapter-harness.mjs";
import { tokenHash } from "../../services/platform-api/src/crypto.js";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = JSON.parse(fs.readFileSync(path.join(codeRoot, "tests/fixtures/platform-adapter-contract.json"), "utf8"));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "velarumpay-adapter-contract-"));
const workerAdminToken = "admin_contract_test_token_1234567890";

process.env.VP_NO_AUTO_LISTEN = "1";
process.env.RELAY_STORE_DRIVER = "sqlite";
process.env.RELAY_STORE_PATH = path.join(tempRoot, "express.sqlite");
process.env.AUDIT_LOG_STDOUT = "false";

const [{ server, store }, { createTestWorker }] = await Promise.all([
  import("../../services/platform-api/src/server.js"),
  import("../../services/platform-api/edge-testnet/src/worker.mjs")
]);

const expressAgentToken = `vat_${"E".repeat(43)}`;
seedExpressContractAgent(store, expressAgentToken);

const worker = createTestWorker({ PLATFORM_ADMIN_TOKEN: workerAdminToken });
const workerRegistration = await worker.fetch(new Request("https://worker.test/v1/admin/agent-clients", requestOptions({
  method: "POST",
  headers: { authorization: `Bearer ${workerAdminToken}` },
  payload: {
    tenant_id: "contract-fixture",
    tenant_name: "Contract Fixture",
    agent_name: "Contract Agent",
    runtime: "node-test",
    source_domain: "contract-fixture.test"
  }
})));
assert.equal(workerRegistration.status, 201);
const workerAgentToken = (await workerRegistration.json()).client_token;
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
    registeredAgentToken: expressAgentToken,
    recipientBound: true,
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

function seedExpressContractAgent(targetStore, accessToken) {
  const at = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  targetStore.db.prepare(`INSERT INTO merchants
    (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
    VALUES (?, ?, 'active', 'verified', 1, ?, ?)`)
    .run("contract-fixture", "Contract Fixture", at, at);
  targetStore.db.prepare(`INSERT INTO agents
    (agent_id, merchant_id, name, runtime, environment, allowed_scopes_json,
     token_revocation_version, status, version, created_at, updated_at)
    VALUES (?, ?, ?, 'node-test', 'testnet', ?, 0, 'active', 1, ?, ?)`)
    .run("agent-contract-fixture", "contract-fixture", "Contract Agent", JSON.stringify(["payment.requests.create", "payment.requests.read"]), at, at);
  targetStore.db.prepare(`INSERT INTO agent_credentials
    (credential_id, merchant_id, agent_id, kid, alg, public_key, status, not_before,
     expires_at, revocation_version, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'Ed25519', ?, 'active', ?, ?, 0, 1, ?, ?)`)
    .run("credential-contract-fixture", "contract-fixture", "agent-contract-fixture", "contract-key", "test-public-key", at, expiresAt, at, at);
  targetStore.db.prepare(`INSERT INTO agent_access_tokens
    (token_id, token_hash, merchant_id, agent_id, client_id, credential_id, scopes_json,
     agent_revocation_version, credential_revocation_version, status, issued_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'active', ?, ?)`)
    .run("token-contract-fixture", tokenHash(accessToken), "contract-fixture", "agent-contract-fixture",
      "contract-client", "credential-contract-fixture", JSON.stringify(["payment.requests.create", "payment.requests.read"]), at, expiresAt);
  targetStore.db.prepare(`INSERT INTO recipients
    (recipient_id, merchant_id, name, status, active_version_id, version, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, 1, ?, ?)`)
    .run("recipient-contract-fixture", "contract-fixture", "Contract Recipient", "recipient-version-contract-fixture", at, at);
  targetStore.db.prepare(`INSERT INTO recipient_versions
    (recipient_version_id, merchant_id, recipient_id, network, asset, address, memo,
     verification_state, effective_at, created_at)
    VALUES (?, ?, ?, 'stellar_testnet', 'XLM', ?, NULL, 'active', ?, ?)`)
    .run("recipient-version-contract-fixture", "contract-fixture", "recipient-contract-fixture",
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", at, at);
}

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
  assert.equal(fixture.difference_allowlist.some((entry) => entry.scenario === "idempotency_conflict"), false);
});
