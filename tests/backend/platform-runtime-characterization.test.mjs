import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePath = path.join(codeRoot, "tests/fixtures/platform-runtime-characterization.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "velarumpay-runtime-characterization-"));

process.env.VP_NO_AUTO_LISTEN = "1";
process.env.RELAY_STORE_DRIVER = "sqlite";
process.env.RELAY_STORE_PATH = path.join(tempRoot, "express.sqlite");

const [{ app, server }, { createTestWorker }] = await Promise.all([
  import("../../services/platform-api/src/server.js"),
  import("../../services/platform-api/edge-testnet/src/worker.mjs")
]);

const worker = createTestWorker();
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

function requestOptions({ method = "GET", payload, headers = {} } = {}) {
  return {
    method,
    headers: {
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
      ...headers
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  };
}

async function callExpress(pathname, options) {
  return fetch(`${expressOrigin}${pathname}`, requestOptions(options));
}

async function callWorker(pathname, options) {
  return worker.fetch(new Request(`https://worker.test${pathname}`, requestOptions(options)));
}

async function normalized(response, extras = {}) {
  const contentType = response.headers.get("content-type") || "";
  let payload = null;
  if (contentType.includes("application/json")) payload = await response.json();
  else await response.text();
  return {
    status: response.status,
    content_type: contentType.includes("application/json") ? "application/json" : contentType.includes("text/html") ? "text/html" : "other",
    ok: typeof payload?.ok === "boolean" ? payload.ok : null,
    error_code: payload?.error?.code || null,
    ...extras(payload)
  };
}

async function createConnectKey(call, suffix) {
  const device = {
    device_id: `runtime-${suffix}`,
    token: `awt_${suffix}_123456789012345678901234567890`
  };
  const registered = await call("/v1/devices/app", { method: "POST", payload: device });
  assert.equal(registered.status, 200);
  const created = await call("/v1/connect-invitations", {
    method: "POST",
    payload: { ...device, expires_in_seconds: 300 }
  });
  assert.equal(created.status, 201);
  const payload = await created.json();
  return payload.connect_key;
}

test("the checked-in characterization fixture contains only deterministic synthetic data", () => {
  assert.equal(fixture.version, 1);
  assert.equal(fixture.generated_at, "deterministic");
  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /(?:sk_live|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|mnemonic|seed phrase)/i);
  assert.deepEqual(new Set(fixture.gaps.map((gap) => gap.classification)), new Set([
    "compatible_difference",
    "missing_capability"
  ]));
});

test("the route and authentication inventory remains anchored to current source", () => {
  const expressSources = fs.readdirSync(path.join(codeRoot, "services/platform-api/src/routes"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => fs.readFileSync(path.join(codeRoot, "services/platform-api/src/routes", name), "utf8"))
    .join("\n");
  const workerSource = fs.readFileSync(path.join(codeRoot, "services/platform-api/edge-testnet/src/worker.mjs"), "utf8");

  for (const route of fixture.runtimes.express_sqlite.routes) {
    const terminal = route.split(" ").slice(1).join(" ").split("/").filter(Boolean).at(-1);
    assert.ok(expressSources.includes(terminal.replace(/^:/, "")) || route === "GET /health", `Express inventory drifted at ${route}`);
  }
  for (const route of fixture.runtimes.worker_d1.routes) {
    const stableSegments = route.replace(/^(GET|POST|PUT|PATCH|DELETE) /, "")
      .split("/")
      .filter((segment) => segment && !segment.startsWith(":"));
    assert.ok(stableSegments.every((segment) => workerSource.includes(segment)), `Worker inventory drifted at ${route}`);
  }
});

test("Express/SQLite and Worker/D1 current public behavior matches the reviewed gap fixture", async () => {
  const expressKey = await createConnectKey(callExpress, "express");
  const workerKey = await createConnectKey(callWorker, "worker");
  const agentIdentity = {
    agent_id: "runtime-agent",
    agent_name: "Runtime characterization Agent",
    runtime: "test",
    source: "fixture"
  };

  const actual = {
    health: {
      express_sqlite: await normalized(await callExpress("/health"), () => ({})),
      worker_d1: await normalized(await callWorker("/health"), () => ({}))
    },
    unknown_route: {
      express_sqlite: await normalized(await callExpress("/v1/characterization-unknown"), () => ({})),
      worker_d1: await normalized(await callWorker("/v1/characterization-unknown"), () => ({}))
    },
    payment_request_without_auth: {
      express_sqlite: await normalized(await callExpress("/v1/payment-requests", { method: "POST", payload: {} }), () => ({})),
      worker_d1: await normalized(await callWorker("/v1/payment-requests", { method: "POST", payload: {} }), () => ({}))
    },
    self_declared_connect_claim: {
      express_sqlite: await normalized(await callExpress("/v1/connect-invitations/claim", {
        method: "POST",
        payload: { connect_key: expressKey, agent_identity: agentIdentity }
      }), (payload) => ({ identity_assurance: payload?.connect_invitation?.identity_assurance || null })),
      worker_d1: await normalized(await callWorker("/v1/connect-invitations/claim", {
        method: "POST",
        payload: { connect_key: workerKey, agent_identity: agentIdentity }
      }), (payload) => ({ identity_assurance: payload?.connect_invitation?.identity_assurance || null }))
    }
  };

  assert.deepEqual(actual, fixture.scenarios);
});
