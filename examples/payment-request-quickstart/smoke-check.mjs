import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizePaymentRequestV1,
  normalizeTransactionContextV1
} from "../../packages/protocol/src/index.js";

const FIXTURE_NAMES = [
  "base_usdc",
  "normal",
  "stellar_xlm",
  "missing_context",
  "mismatch",
  "ai_only",
  "asset_network_mismatch"
];
const SCOPES = [
  "payment.requests.create",
  "payment.requests.read",
  "transaction_contexts.create",
  "transaction_contexts.read"
];

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "../../services/platform-api/src/server.js");

async function main() {
  const fixtures = await loadFixtures();
  validateStaticFixtures(fixtures);

  const server = await startOrUseServer();
  try {
    const runId = `smoke_${Date.now()}`;
    const deviceId = `wallet_${runId}`;
    const deviceToken = `token_${runId}`;

    await api(server.baseUrl, "POST", "/v1/devices/app", {
      device_id: deviceId,
      token: deviceToken
    });

    const pairing = await api(server.baseUrl, "POST", "/v1/pairing/sessions", {
      agent: {
        agent_id: `agt_${runId}`,
        agent_name: "Quickstart Smoke Agent",
        runtime: "node",
        device_label: "local smoke check"
      },
      requested_scopes: SCOPES,
      expires_in_seconds: 300
    });

    const approved = await api(
      server.baseUrl,
      "POST",
      `/v1/pairing/sessions/${pairing.pairing_session.pairing_session_id}/approve`,
      {
        device_id: deviceId,
        token: deviceToken,
        approved_scopes: SCOPES
      }
    );
    const connection = approved.connection;

    const created = [];
    for (const [index, fixture] of fixtures.entries()) {
      const materialized = materializeFixture(fixture, connection.connection_id, deviceId, runId, index);
      await api(server.baseUrl, "POST", "/v1/transaction-contexts", materialized.transaction_context, {
        connectionToken: connection.connection_token
      });
      const response = await api(server.baseUrl, "POST", "/v1/payment-requests", {
        ...materialized.payment_request,
        target_app_device_id: deviceId
      }, {
        connectionToken: connection.connection_token,
        idempotencyKey: materialized.payment_request.idempotency_key
      });
      assertProjection(fixture, response.payment_request);
      created.push({ fixture, payment_request: response.payment_request });
    }

    const list = await api(
      server.baseUrl,
      "GET",
      `/v1/payment-requests?device_id=${encodeURIComponent(deviceId)}&token=${encodeURIComponent(deviceToken)}`
    );
    assert(list.items.length >= created.length, "wallet list did not include created requests");

    const normal = created.find((item) => item.fixture.name === "normal");
    assert(normal, "normal fixture was not created");

    const detail = await api(
      server.baseUrl,
      "GET",
      `/v1/payment-requests/${normal.payment_request.request_id}?device_id=${encodeURIComponent(deviceId)}&token=${encodeURIComponent(deviceToken)}`
    );
    assert(detail.payment_request.request_id === normal.payment_request.request_id, "detail returned the wrong request");

    const stellar = created.find((item) => item.fixture.name === "stellar_xlm");
    assert(stellar, "stellar_xlm fixture was not created");
    const txHash = `stellar-smoke-tx-${runId}`;
    const broadcasted = await api(
      server.baseUrl,
      "POST",
      `/v1/payment-requests/${stellar.payment_request.request_id}/status`,
      {
        device_id: deviceId,
        token: deviceToken,
        status: "broadcasted",
        tx_hash: txHash
      }
    );
    assert(broadcasted.payment_request.status === "broadcasted", "broadcasted status update failed");
    assert(broadcasted.payment_request.tx_hash === txHash, "broadcasted status did not keep tx_hash");

    const confirmed = await api(
      server.baseUrl,
      "POST",
      `/v1/payment-requests/${stellar.payment_request.request_id}/status`,
      {
        device_id: deviceId,
        token: deviceToken,
        status: "confirmed",
        tx_hash: txHash
      }
    );
    assert(confirmed.payment_request.status === "confirmed", "confirmed status update failed");
    assert(
      confirmed.payment_request.history.some((item) => item.status === "confirmed"),
      "confirmed status was not recorded in history"
    );

    const rejected = await api(
      server.baseUrl,
      "POST",
      `/v1/payment-requests/${normal.payment_request.request_id}/status`,
      {
        device_id: deviceId,
        token: deviceToken,
        status: "rejected"
      }
    );
    assert(rejected.payment_request.status === "rejected", "status update did not reject the request");
    assert(
      rejected.payment_request.history.some((item) => item.status === "rejected"),
      "rejected status was not recorded in history"
    );

    const invalidStatus = await request(
      server.baseUrl,
      "POST",
      `/v1/payment-requests/${normal.payment_request.request_id}/status`,
      {
        device_id: deviceId,
        token: deviceToken,
        status: "paid"
      }
    );
    assert(invalidStatus.status === 400, "invalid status did not return HTTP 400");
    assert(invalidStatus.json?.error?.code === "invalid_status", "invalid status did not return a structured error");

    const agentConfirm = await request(
      server.baseUrl,
      "POST",
      `/v1/payment-requests/${created[1].payment_request.request_id}/status`,
      {
        status: "confirmed"
      },
      {
        connectionToken: connection.connection_token
      }
    );
    assert(agentConfirm.status === 401, "agent token was able to call wallet status update");
    assert(
      agentConfirm.json?.error?.code === "invalid_app_device_token",
      "agent status failure did not use invalid_app_device_token"
    );

    const mismatch = created.find((item) => item.fixture.name === "mismatch");
    assert(mismatch, "mismatch fixture was not created");
    await verifyAgentWebSocketStatus(
      server.baseUrl,
      connection.connection_token,
      connection.connection_id,
      mismatch.payment_request.request_id,
      "rejected",
      () => api(
        server.baseUrl,
        "POST",
        `/v1/payment-requests/${mismatch.payment_request.request_id}/status`,
        {
          device_id: deviceId,
          token: deviceToken,
          status: "rejected"
        }
      )
    );

    const events = await api(server.baseUrl, "GET", "/v1/payment-requests/events?since=0", null, {
      connectionToken: connection.connection_token
    });
    assert(
      events.items.some((event) => event.request_id === normal.payment_request.request_id && event.status === "rejected"),
      "agent events did not include rejected status"
    );

    console.log("Payment Request quickstart smoke check passed");
    console.log(`Created fixtures: ${created.map((item) => item.fixture.name).join(", ")}`);
    console.log(`Rejected request: ${normal.payment_request.request_id}`);
    console.log(`Agent events observed: ${events.items.length}`);
  } finally {
    await server.stop();
  }
}

async function loadFixtures() {
  const fixtures = [];
  for (const name of FIXTURE_NAMES) {
    const file = path.join(here, "fixtures", `${name}.json`);
    const fixture = JSON.parse(await readFile(file, "utf8"));
    fixtures.push(fixture);
  }
  return fixtures;
}

function validateStaticFixtures(fixtures) {
  for (const fixture of fixtures) {
    const context = normalizeTransactionContextV1(fixture.transaction_context, {
      now: "2026-06-17T10:00:00.000Z"
    });
    assert(context.ok, `${fixture.name} transaction_context failed validator: ${JSON.stringify(context.error)}`);

    const requestResult = normalizePaymentRequestV1(fixture.payment_request, {
      now: "2026-06-17T10:00:00.000Z"
    });
    assert(requestResult.ok, `${fixture.name} payment_request failed validator: ${JSON.stringify(requestResult.error)}`);
  }
}

function materializeFixture(fixture, connectionId, deviceId, runId, index) {
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  const suffix = `${runId}_${index}`;
  const transactionContext = clone(fixture.transaction_context);
  const paymentRequest = clone(fixture.payment_request);
  const transactionId = `${paymentRequest.transaction_id}_${suffix}`;

  transactionContext.connection_id = connectionId;
  transactionContext.transaction_id = transactionId;
  transactionContext.created_at = createdAt;
  transactionContext.updated_at = createdAt;

  paymentRequest.connection_id = connectionId;
  paymentRequest.transaction_id = transactionId;
  paymentRequest.request_id = `${paymentRequest.request_id}_${suffix}`;
  paymentRequest.idempotency_key = `${paymentRequest.idempotency_key}_${suffix}`;
  paymentRequest.created_at = createdAt;
  paymentRequest.expires_at = expiresAt;
  paymentRequest.target_app_device_id = deviceId;

  return {
    transaction_context: transactionContext,
    payment_request: paymentRequest
  };
}

async function startOrUseServer() {
  if (process.env.BASE_URL) {
    const baseUrl = process.env.BASE_URL.replace(/\/+$/, "");
    await waitForHealth(baseUrl);
    return {
      baseUrl,
      stop: async () => {}
    };
  }

  const port = Number(process.env.SMOKE_PORT || 18787);
  const baseUrl = `http://127.0.0.1:${port}`;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "Paytobe-platform-api-"));
  let output = "";
  const child = spawn(process.execPath, [serverPath], {
    cwd: tempDir,
    env: {
      ...process.env,
      PORT: String(port),
      ALLOW_UNSIGNED_OPENCLAW: "true",
      OPENCLAW_DEVICE_SECRET: "quickstart-smoke"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  try {
    await waitForHealth(baseUrl, child, () => output);
  } catch (error) {
    child.kill();
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  return {
    baseUrl,
    stop: async () => {
      child.kill();
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

async function verifyAgentWebSocketStatus(baseUrl, connectionToken, connectionId, requestId, status, trigger) {
  const wsUrl = `${baseUrl.replace(/^http/, "ws")}/v1/ws/agent?connection_token=${encodeURIComponent(connectionToken)}`;
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let triggered = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("agent WebSocket status notification timed out"));
    }, 3000);

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "hello") {
          assert(message.role === "agent", "agent WebSocket did not return role=agent");
          assert(message.connection_id === connectionId, "agent WebSocket returned the wrong connection_id");
          if (!triggered) {
            triggered = true;
            trigger().catch((error) => {
              clearTimeout(timer);
              ws.close();
              reject(error);
            });
          }
          return;
        }
        if (message.type === "payment_request_status" && message.request_id === requestId && message.status === status) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      } catch (error) {
        clearTimeout(timer);
        ws.close();
        reject(error);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("agent WebSocket connection failed"));
    };
  });
}

async function waitForHealth(baseUrl, child = null, output = () => "") {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child?.exitCode !== null) {
      throw new Error(`platform-api exited before health check passed\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Retry until the local server is ready.
    }
    await sleep(100);
  }
  throw new Error(`platform-api health check timed out\n${output()}`);
}

async function api(baseUrl, method, pathName, body = null, options = {}) {
  const response = await request(baseUrl, method, pathName, body, options);
  if (!response.status || response.status < 200 || response.status >= 300) {
    throw new Error(`${method} ${pathName} failed with ${response.status}: ${JSON.stringify(response.json)}`);
  }
  if (response.json?.ok === false) {
    throw new Error(`${method} ${pathName} returned ok:false: ${JSON.stringify(response.json)}`);
  }
  return response.json;
}

async function request(baseUrl, method, pathName, body = null, options = {}) {
  const headers = {};
  if (body !== null && body !== undefined) headers["content-type"] = "application/json";
  if (options.connectionToken) headers.authorization = `Bearer ${options.connectionToken}`;
  if (options.idempotencyKey) headers["x-idempotency-key"] = options.idempotencyKey;

  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers,
    body: body === null || body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return {
    status: response.status,
    json
  };
}

function assertProjection(fixture, projection) {
  assert(projection.request_id, `${fixture.name} response did not include request_id`);
  assert(projection.transaction_id, `${fixture.name} response did not include transaction_id`);
  assert(projection.payment_facts?.amount === fixture.payment_request.payment.amount, `${fixture.name} payment facts amount drifted`);
  assert(projection.payment_facts?.recipient === fixture.payment_request.payment.to, `${fixture.name} payment facts recipient drifted`);
  assert(
    projection.status_projection?.review_state === fixture.expected.review_state,
    `${fixture.name} expected review_state ${fixture.expected.review_state}, got ${projection.status_projection?.review_state}`
  );
  assert(
    projection.risk?.level === fixture.expected.risk_level,
    `${fixture.name} expected risk level ${fixture.expected.risk_level}, got ${projection.risk?.level}`
  );
  assert(
    projection.risk?.signing_allowed === fixture.expected.signing_allowed,
    `${fixture.name} expected signing_allowed ${fixture.expected.signing_allowed}, got ${projection.risk?.signing_allowed}`
  );

  for (const code of fixture.expected.error_codes || []) {
    assert(hasRiskCode(projection.risk?.errors, code), `${fixture.name} missing expected error code ${code}`);
  }
  for (const code of fixture.expected.warning_codes || []) {
    assert(hasRiskCode(projection.risk?.warnings, code), `${fixture.name} missing expected warning code ${code}`);
  }
}

function hasRiskCode(items = [], code) {
  return items.some((item) => item?.code === code);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
