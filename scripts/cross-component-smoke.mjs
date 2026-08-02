#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPaymentRequest as buildOpenClawPaymentRequest } from "../connectors/openclaw-telegram/src/intent_builder.js";
import { callTool, tools as mcpTools } from "../connectors/mcp-server/src/tools.js";
import {
  createHermesPaymentRequestAdapter,
  prepareHermesPaymentRequest
} from "../connectors/hermes/src/index.js";
import {
  createVelarumPayClient,
  validatePaymentRequest,
  validateTransactionContext
} from "../packages/sdk-js/src/index.js";

const STANDARD_FIXTURE_NAMES = ["normal", "missing_context", "mismatch", "ai_only", "expired"];
const RAIL_FIXTURE_NAMES = ["base_usdc", "stellar_xlm"];
const ALL_FIXTURE_NAMES = [...new Set([...RAIL_FIXTURE_NAMES, ...STANDARD_FIXTURE_NAMES])];
const SCOPES = Object.freeze([
  "payment.requests.create",
  "payment.requests.read",
  "transaction_contexts.create",
  "transaction_contexts.read"
]);
const STATIC_VALIDATION_NOW = "2026-06-17T10:00:00.000Z";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const fixturesDir = path.join(repoRoot, "examples/payment-request-quickstart/fixtures");
const hermesFixturesDir = path.join(repoRoot, "connectors/hermes/fixtures");
const serverPath = path.join(repoRoot, "services/platform-api/src/server.js");
const cliPath = path.join(repoRoot, "examples/payment-request-quickstart/cli.mjs");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const results = {
    ok: false,
    run_id: `cross_${Date.now()}`,
    started_at: new Date().toISOString(),
    base_url: "",
    server_mode: "",
    standard_fixtures: STANDARD_FIXTURE_NAMES,
    rail_fixtures: RAIL_FIXTURE_NAMES,
    steps: [],
    requests: [],
    reports: {}
  };

  let server = null;
  try {
    let fixtures = {};
    await step(results, "fixtures.load_and_validate", "fixture", async () => {
      const loaded = await loadQuickstartFixtures(ALL_FIXTURE_NAMES);
      validateStaticFixtures(loaded);
      assertRailCoverage(loaded);
      fixtures = loaded;
      return {
        fixtures: Object.keys(loaded),
        standard_fixtures: STANDARD_FIXTURE_NAMES,
        rails: RAIL_FIXTURE_NAMES.map((name) => loaded[name].payment_request.payment.rail)
      };
    });

    server = await step(results, "platform_api.start_or_detect", "api", async () => startOrUseServer(options));
    results.base_url = server.baseUrl;
    results.server_mode = server.mode;

    const auth = await step(results, "platform_api.pair_and_approve_dev_wallet", "api", async () => {
      const wallet = {
        device_id: `wallet_${results.run_id}`,
        token: `token_${results.run_id}`
      };
      await api(server.baseUrl, "POST", "/v1/devices/app", wallet);
      const setupClient = createVelarumPayClient({ baseUrl: server.baseUrl });
      const pairing = await unwrapApiResult(await setupClient.createPairingSession({
        agent: {
          agent_id: `agt_${results.run_id}`,
          agent_name: "Cross Component Smoke Agent",
          runtime: "node",
          device_label: "local cross-component smoke harness"
        },
        requested_scopes: SCOPES,
        expires_in_seconds: 300
      }), "create pairing session");
      const approved = await api(
        server.baseUrl,
        "POST",
        `/v1/pairing/sessions/${encodeURIComponent(pairing.pairing_session.pairing_session_id)}/approve`,
        {
          device_id: wallet.device_id,
          token: wallet.token,
          approved_scopes: SCOPES
        }
      );
      return {
        wallet,
        connection: approved.connection,
        pairing_session: approved.pairing_session
      };
    });

    const client = createVelarumPayClient({
      baseUrl: server.baseUrl,
      connectionToken: auth.connection.connection_token
    });

    const sdkCreated = await step(results, "sdk.base_usdc_context_request_detail", "sdk", async () => {
      const materialized = materializeQuickstartFixture(fixtures.base_usdc, auth, results.run_id, "sdk");
      await createContextWithSdk(client, materialized);
      const created = await createRequestWithSdk(client, materialized, auth.wallet.device_id);
      assertProjection("sdk base_usdc", fixtures.base_usdc.expected, created.payment_request);
      const detail = await unwrapApiResult(
        await client.getPaymentRequest(created.payment_request.request_id),
        "SDK get payment request"
      );
      assert(detail.payment_request.request_id === created.payment_request.request_id, "SDK detail returned the wrong request");
      trackRequest(results, "sdk", fixtures.base_usdc.name, created.payment_request);
      return summarizeProjection(created.payment_request);
    });

    const cliCreated = await step(results, "cli.stellar_xlm_context_request_status", "cli", async () => {
      const env = {
        ...process.env,
        BASE_URL: server.baseUrl,
        CONNECTION_TOKEN: auth.connection.connection_token,
        WALLET_DEVICE_ID: auth.wallet.device_id,
        WALLET_TOKEN: auth.wallet.token,
        QUICKSTART_RUN_ID: `${results.run_id}_cli`
      };
      await runCli(["context:create", "--fixture", "stellar_xlm", "--json"], env);
      const created = await runCli(["request:create", "--fixture", "stellar_xlm", "--json"], env);
      assertProjection("cli stellar_xlm", fixtures.stellar_xlm.expected, created.payment_request);
      await api(
        server.baseUrl,
        "POST",
        `/v1/payment-requests/${encodeURIComponent(created.payment_request.request_id)}/status`,
        {
          device_id: auth.wallet.device_id,
          token: auth.wallet.token,
          status: "broadcasted",
          tx_hash: `${results.run_id}-stellar-broadcast`
        }
      );
      const confirmed = await api(
        server.baseUrl,
        "POST",
        `/v1/payment-requests/${encodeURIComponent(created.payment_request.request_id)}/status`,
        {
          device_id: auth.wallet.device_id,
          token: auth.wallet.token,
          status: "confirmed",
          tx_hash: `${results.run_id}-stellar-confirmed`
        }
      );
      const events = await runCli(["events:poll", "--since", "0", "--json"], env);
      assert(
        events.items.some((event) => event.request_id === created.payment_request.request_id && event.status === "confirmed"),
        "CLI events polling did not observe confirmed status"
      );
      trackRequest(results, "cli", fixtures.stellar_xlm.name, confirmed.payment_request);
      return {
        request_id: confirmed.payment_request.request_id,
        rail: confirmed.payment_request.payment?.rail,
        status: confirmed.payment_request.status,
        event_count: events.items.length
      };
    });

    await step(results, "openclaw.normal_standard_payload", "openclaw", async () => {
      const materialized = materializeQuickstartFixture(fixtures.normal, auth, results.run_id, "openclaw");
      const openclawRequest = buildOpenClawRequestFromFixture(materialized);
      assertValidatedPaymentRequest("OpenClaw payment_request", openclawRequest);
      const context = {
        ...materialized.transaction_context,
        source: {
          ...materialized.transaction_context.source,
          runtime: "openclaw",
          channel: "telegram"
        }
      };
      await createContextWithSdk(client, { transaction_context: context });
      const created = await createRequestWithSdk(client, {
        payment_request: openclawRequest
      }, auth.wallet.device_id);
      assertProjection("openclaw normal", fixtures.normal.expected, created.payment_request);
      trackRequest(results, "openclaw", fixtures.normal.name, created.payment_request);
      return summarizeProjection(created.payment_request);
    });

    await step(results, "mcp.mismatch_tool_loop", "mcp", async () => {
      const materialized = materializeQuickstartFixture(fixtures.mismatch, auth, results.run_id, "mcp");
      const context = await callTool("create_transaction_context", {
        base_url: server.baseUrl,
        connection_token: auth.connection.connection_token,
        transaction_context: materialized.transaction_context
      });
      assertToolOk("MCP create_transaction_context", context);
      const payment = await callTool("create_payment_request", {
        base_url: server.baseUrl,
        connection_token: auth.connection.connection_token,
        target_app_device_id: auth.wallet.device_id,
        payment_request: materialized.payment_request
      });
      assertToolOk("MCP create_payment_request", payment);
      const projection = payment.structuredContent.payment_request;
      assertProjection("mcp mismatch", fixtures.mismatch.expected, projection);
      const status = await callTool("get_payment_status", {
        base_url: server.baseUrl,
        connection_token: auth.connection.connection_token,
        request_id: projection.request_id
      });
      assertToolOk("MCP get_payment_status", status);
      assert(status.structuredContent.status === projection.status, "MCP status read drifted from created request");
      trackRequest(results, "mcp", fixtures.mismatch.name, projection);
      return summarizeProjection(projection);
    });

    await step(results, "hermes.base_usdc_adapter_loop", "hermes", async () => {
      const fixture = await loadJson(path.join(hermesFixturesDir, "base-usdc-payment-request.json"));
      const materialized = materializeHermesFixture(fixture, auth, results.run_id, "hermes");
      const prepared = prepareHermesPaymentRequest(materialized, {
        connectionId: auth.connection.connection_id,
        now: materialized.payment_request.created_at
      });
      assert(prepared.ok, `Hermes fixture failed local preparation: ${JSON.stringify(prepared.error)}`);
      const adapter = createHermesPaymentRequestAdapter({
        baseUrl: server.baseUrl,
        connectionToken: auth.connection.connection_token,
        connectionId: auth.connection.connection_id
      });
      const created = await adapter.createStandardPaymentRequest(materialized, {
        connectionToken: auth.connection.connection_token,
        targetAppDeviceId: auth.wallet.device_id
      });
      assert(created.ok, `Hermes createStandardPaymentRequest failed: ${JSON.stringify(created.error)}`);
      const status = await adapter.getPaymentStatus(created.request_id);
      assert(status.payment_request?.request_id === created.request_id, "Hermes getPaymentStatus returned the wrong request");
      const events = await adapter.pollStatusEvents({ since: 0 });
      assert(
        events.items.some((event) => event.request_id === created.request_id),
        "Hermes pollStatusEvents did not include its created request"
      );
      trackRequest(results, "hermes", fixture.name, status.payment_request);
      return {
        ...summarizeProjection(status.payment_request),
        websocket_url: adapter.agentWebSocketUrl()
      };
    });

    await step(results, "fixture.missing_context_request", "fixture", async () => {
      const materialized = materializeQuickstartFixture(fixtures.missing_context, auth, results.run_id, "missing");
      const created = await createRequestWithSdk(client, materialized, auth.wallet.device_id);
      assertProjection("missing_context", fixtures.missing_context.expected, created.payment_request);
      trackRequest(results, "fixture", fixtures.missing_context.name, created.payment_request);
      return summarizeProjection(created.payment_request);
    });

    await step(results, "fixture.ai_only_request", "fixture", async () => {
      const materialized = materializeQuickstartFixture(fixtures.ai_only, auth, results.run_id, "ai");
      await createContextWithSdk(client, materialized);
      const created = await createRequestWithSdk(client, materialized, auth.wallet.device_id);
      assertProjection("ai_only", fixtures.ai_only.expected, created.payment_request);
      trackRequest(results, "fixture", fixtures.ai_only.name, created.payment_request);
      return summarizeProjection(created.payment_request);
    });

    await step(results, "fixture.expired_request", "fixture", async () => {
      const materialized = materializeQuickstartFixture(fixtures.expired, auth, results.run_id, "expired", {
        ttlMs: 150
      });
      await createContextWithSdk(client, materialized);
      const created = await createRequestWithSdk(client, materialized, auth.wallet.device_id);
      assert(created.payment_request.status === "pending", "expired fixture should be created before it expires");
      await sleep(350);
      const detail = await unwrapApiResult(
        await client.getPaymentRequest(created.payment_request.request_id),
        "expired fixture detail"
      );
      assertProjection("expired", fixtures.expired.expected, detail.payment_request);
      trackRequest(results, "fixture", fixtures.expired.name, detail.payment_request);
      return summarizeProjection(detail.payment_request);
    });

    await step(results, "api.list_detail_status_events", "api", async () => {
      const rejected = await api(
        server.baseUrl,
        "POST",
        `/v1/payment-requests/${encodeURIComponent(sdkCreated.request_id)}/status`,
        {
          device_id: auth.wallet.device_id,
          token: auth.wallet.token,
          status: "rejected"
        }
      );
      assert(rejected.payment_request.status === "rejected", "wallet status update did not reject SDK request");
      const walletList = await api(
        server.baseUrl,
        "GET",
        `/v1/payment-requests?device_id=${encodeURIComponent(auth.wallet.device_id)}&token=${encodeURIComponent(auth.wallet.token)}`
      );
      assert(walletList.items.length >= results.requests.length, "wallet list missed created requests");
      const connectionList = await unwrapApiResult(await client.requestJson("GET", "/v1/payment-requests"), "connection list");
      assert(connectionList.items.length >= results.requests.length, "connection list missed created requests");
      const events = await unwrapApiResult(await client.pollEvents({ since: 0 }), "SDK poll events");
      assert(
        events.items.some((event) => event.request_id === sdkCreated.request_id && event.status === "rejected"),
        "events polling did not include rejected SDK request"
      );
      return {
        rejected_request_id: rejected.payment_request.request_id,
        wallet_list_count: walletList.items.length,
        connection_list_count: connectionList.items.length,
        event_count: events.items.length
      };
    });

    await step(results, "observability.metrics_and_audit_guard", "api", async () => {
      const metrics = await request(server.baseUrl, "GET", "/metrics");
      assert(metrics.status === 200, "metrics endpoint did not return HTTP 200");
      assert(metrics.text.includes("velarumpay_http_requests_total"), "metrics did not include HTTP request counter");
      assert(metrics.text.includes("velarumpay_audit_events_total"), "metrics did not include audit event counter");
      assert(
        !metrics.text.includes(auth.connection.connection_token) && !metrics.text.includes(auth.wallet.token),
        "metrics exposed a sensitive token"
      );
      const audit = await request(server.baseUrl, "GET", "/v1/audit/events");
      assert(audit.status === 403, "audit events endpoint should require an ops token by default");
      assert(audit.json?.error?.code === "audit_log_token_required", "audit guard returned the wrong error code");
      return {
        metrics_bytes: metrics.text.length,
        audit_guard_status: audit.status,
        audit_guard_code: audit.json.error.code
      };
    });

    await step(results, "negative.api_invalid_status_error", "api", async () => {
      const response = await request(
        server.baseUrl,
        "POST",
        `/v1/payment-requests/${encodeURIComponent(cliCreated.request_id)}/status`,
        {
          device_id: auth.wallet.device_id,
          token: auth.wallet.token,
          status: "paid"
        }
      );
      assert(response.status === 400, "invalid status did not return HTTP 400");
      assert(response.json?.error?.code === "invalid_status", "invalid status error code was not structured");
      return {
        expected_failure: true,
        locator: "api",
        status: response.status,
        code: response.json.error.code,
        field: response.json.error.details?.field || response.json.error.field || "status"
      };
    });

    await step(results, "negative.mcp_unsupported_scope", "connector", async () => {
      assert(
        mcpTools.every((tool) => !tool.name.toLowerCase().includes("sign")),
        "MCP tools unexpectedly expose signing"
      );
      const denied = await callTool("create_pairing_session", {
        agent: {
          agent_id: "agt_mcp_scope_negative",
          agent_name: "MCP Scope Negative"
        },
        requested_scopes: ["payment.requests.create", "wallet.sign"]
      });
      assert(denied.isError, "MCP unsupported scope was not rejected");
      assert(denied.structuredContent.error.code === "unsupported_scope", "MCP unsupported scope error code drifted");
      return {
        expected_failure: true,
        locator: "connector",
        code: denied.structuredContent.error.code,
        field: denied.structuredContent.error.field
      };
    });

    await step(results, "negative.fixture_schema_expired", "schema", async () => {
      const invalid = clone(fixtures.expired.payment_request);
      invalid.connection_id = auth.connection.connection_id;
      invalid.status = "pending";
      invalid.created_at = "2026-06-17T09:00:00.000Z";
      invalid.expires_at = "2026-06-17T09:59:00.000Z";
      const validation = validatePaymentRequest(invalid, { now: STATIC_VALIDATION_NOW });
      assert(!validation.ok, "expired schema negative fixture unexpectedly passed validation");
      assert(validation.error.code === "expired_request", "expired schema negative did not locate expired_request");
      return {
        expected_failure: true,
        locator: "schema",
        fixture: "expired",
        code: validation.error.code,
        field: validation.error.details?.field || validation.error.field || "expires_at"
      };
    });

    results.ok = true;
  } catch (error) {
    results.error = normalizeCaughtError(error);
    results.ok = false;
  } finally {
    results.finished_at = new Date().toISOString();
    results.duration_ms = Date.parse(results.finished_at) - Date.parse(results.started_at);
    const reportPaths = await writeReports(results, options);
    results.reports = reportPaths;
    if (server) await server.stop();
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printHumanSummary(results);
  }

  if (!results.ok) process.exit(1);
}

async function loadQuickstartFixtures(names) {
  const fixtures = {};
  for (const name of names) {
    fixtures[name] = await loadJson(path.join(fixturesDir, `${name}.json`));
  }
  return fixtures;
}

function validateStaticFixtures(fixtures) {
  for (const [name, fixture] of Object.entries(fixtures)) {
    const context = validateTransactionContext(fixture.transaction_context, { now: STATIC_VALIDATION_NOW });
    assert(context.ok, `${name} transaction_context failed validator: ${JSON.stringify(context.error)}`);
    const request = validatePaymentRequest(fixture.payment_request, { now: STATIC_VALIDATION_NOW });
    assert(request.ok, `${name} payment_request failed validator: ${JSON.stringify(request.error)}`);
  }
}

function assertRailCoverage(fixtures) {
  const rails = new Set(Object.values(fixtures).map((fixture) => fixture.payment_request?.payment?.rail));
  assert(rails.has("base_usdc"), "standard fixtures did not cover Base USDC");
  assert(rails.has("stellar_xlm"), "standard fixtures did not cover Stellar XLM");
}

async function startOrUseServer(options) {
  const requestedBaseUrl = options.baseUrl || process.env.BASE_URL || "";
  if (requestedBaseUrl) {
    const baseUrl = requestedBaseUrl.replace(/\/+$/, "");
    await waitForHealth(baseUrl);
    return {
      baseUrl,
      mode: "existing",
      stop: async () => {}
    };
  }

  const port = Number(process.env.CROSS_SMOKE_PORT || 18788);
  const baseUrl = `http://127.0.0.1:${port}`;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "velarumpay-cross-platform-api-"));
  let output = "";
  const child = spawn(process.execPath, [serverPath], {
    cwd: tempDir,
    env: {
      ...process.env,
      PORT: String(port),
      ALLOW_UNSIGNED_OPENCLAW: "true",
      OPENCLAW_DEVICE_SECRET: "cross-component-smoke"
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
    mode: "started",
    stop: async () => {
      if (child.exitCode === null) {
        child.kill();
        await waitForExit(child, 1000);
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

async function waitForHealth(baseUrl, child = null, output = () => "") {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child && child.exitCode !== null) {
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

async function createContextWithSdk(client, materialized) {
  const result = await unwrapApiResult(
    await client.createTransactionContext(materialized.transaction_context),
    "create Transaction Context"
  );
  assert(result.context?.transaction_id || result.transaction_context?.transaction_id, "Transaction Context create returned no transaction_id");
  return result;
}

async function createRequestWithSdk(client, materialized, targetDeviceId) {
  const result = await unwrapApiResult(
    await client.createPaymentRequest({
      ...materialized.payment_request,
      target_app_device_id: targetDeviceId
    }, {
      idempotencyKey: materialized.payment_request.idempotency_key
    }),
    "create Payment Request"
  );
  assert(result.payment_request?.request_id, "Payment Request create returned no request_id");
  return result;
}

function buildOpenClawRequestFromFixture(materialized) {
  const request = materialized.payment_request;
  const context = materialized.transaction_context;
  const source = {
    request_id: request.request_id,
    transaction_id: request.transaction_id,
    connection_id: request.connection_id,
    created_at: request.created_at,
    expires_at: request.expires_at,
    idempotency_key: request.idempotency_key,
    agent_id: "agt_openclaw_cross_smoke",
    agent_name: "OpenClaw Cross Smoke",
    runtime: "openclaw",
    channel: "telegram",
    device_id: "device_openclaw_cross_smoke",
    payee: request.payee,
    display: request.display,
    metadata: request.metadata,
    food_order: request.metadata?.food_order,
    title: context.title,
    summary: context.summary
  };
  return buildOpenClawPaymentRequest(request.payment, source);
}

function materializeQuickstartFixture(fixture, auth, runId, label, options = {}) {
  const now = new Date();
  const createdAt = now.toISOString();
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const suffix = sanitizeId(`${runId}_${label}`);
  const transactionContext = clone(fixture.transaction_context);
  const paymentRequest = clone(fixture.payment_request);
  const transactionId = `${paymentRequest.transaction_id}_${suffix}`;

  transactionContext.connection_id = auth.connection.connection_id;
  transactionContext.transaction_id = transactionId;
  transactionContext.created_at = createdAt;
  transactionContext.updated_at = createdAt;

  paymentRequest.connection_id = auth.connection.connection_id;
  paymentRequest.transaction_id = transactionId;
  paymentRequest.request_id = `${paymentRequest.request_id}_${suffix}`;
  paymentRequest.idempotency_key = `${paymentRequest.idempotency_key}_${suffix}`;
  paymentRequest.created_at = createdAt;
  paymentRequest.expires_at = expiresAt;
  paymentRequest.status = "pending";

  return {
    transaction_context: transactionContext,
    payment_request: paymentRequest
  };
}

function materializeHermesFixture(fixture, auth, runId, label) {
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  const suffix = sanitizeId(`${runId}_${label}`);
  const transactionContext = clone(fixture.transaction_context);
  const paymentRequest = clone(fixture.payment_request);
  const transactionId = `${paymentRequest.transaction_id}_${suffix}`;

  transactionContext.connection_id = auth.connection.connection_id;
  transactionContext.transaction_id = transactionId;
  transactionContext.created_at = createdAt;
  transactionContext.updated_at = createdAt;

  paymentRequest.connection_id = auth.connection.connection_id;
  paymentRequest.transaction_id = transactionId;
  paymentRequest.request_id = `${paymentRequest.request_id}_${suffix}`;
  paymentRequest.idempotency_key = `${paymentRequest.idempotency_key}_${suffix}`;
  paymentRequest.created_at = createdAt;
  paymentRequest.expires_at = expiresAt;
  paymentRequest.status = "pending";

  return {
    ...clone(fixture),
    target_app_device_id: auth.wallet.device_id,
    transaction_context: transactionContext,
    payment_request: paymentRequest
  };
}

async function runCli(args, env) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const code = await new Promise((resolve) => {
    child.on("close", resolve);
  });
  if (code !== 0) {
    throw new Error(`CLI failed (${args.join(" ")}): ${stderr || stdout}`);
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`CLI returned non-JSON output for ${args.join(" ")}: ${stdout}\n${error.message}`);
  }
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
  const headers = {
    accept: "application/json"
  };
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
    json,
    text
  };
}

async function unwrapApiResult(result, label) {
  if (result?.ok === false) {
    throw new Error(`${label} failed: ${JSON.stringify(result.error || result)}`);
  }
  return result;
}

function assertValidatedPaymentRequest(label, payload) {
  const validation = validatePaymentRequest(payload, { now: payload.created_at || new Date().toISOString() });
  assert(validation.ok, `${label} failed validation: ${JSON.stringify(validation.error)}`);
}

function assertProjection(label, expected = {}, projection = {}) {
  assert(projection.request_id, `${label} response did not include request_id`);
  if (expected.lifecycle_status) {
    assert(
      projection.status_projection?.lifecycle_status === expected.lifecycle_status || projection.status === expected.lifecycle_status,
      `${label} expected lifecycle_status ${expected.lifecycle_status}, got ${projection.status_projection?.lifecycle_status || projection.status}`
    );
  }
  if (expected.review_state) {
    assert(
      projection.status_projection?.review_state === expected.review_state,
      `${label} expected review_state ${expected.review_state}, got ${projection.status_projection?.review_state}`
    );
  }
  if (expected.risk_level) {
    assert(
      projection.risk?.level === expected.risk_level,
      `${label} expected risk level ${expected.risk_level}, got ${projection.risk?.level}`
    );
  }
  if (expected.signing_allowed !== undefined) {
    assert(
      projection.risk?.signing_allowed === expected.signing_allowed,
      `${label} expected signing_allowed ${expected.signing_allowed}, got ${projection.risk?.signing_allowed}`
    );
  }
  for (const code of expected.error_codes || []) {
    assert(hasRiskCode(projection.risk?.errors, code), `${label} missing expected risk error ${code}`);
  }
  for (const code of expected.warning_codes || []) {
    assert(hasRiskCode(projection.risk?.warnings, code), `${label} missing expected risk warning ${code}`);
  }
}

function assertToolOk(label, result) {
  if (result?.isError) {
    throw new Error(`${label} failed: ${JSON.stringify(result.structuredContent?.error || result.structuredContent)}`);
  }
  assert(result?.structuredContent?.ok !== false, `${label} returned ok:false`);
}

function summarizeProjection(projection) {
  return {
    request_id: projection.request_id,
    transaction_id: projection.transaction_id,
    rail: projection.payment?.rail,
    network: projection.payment?.network,
    asset: projection.payment?.asset,
    status: projection.status,
    review_state: projection.status_projection?.review_state,
    risk_level: projection.risk?.level,
    signing_allowed: projection.risk?.signing_allowed
  };
}

function trackRequest(results, component, fixture, projection) {
  results.requests.push({
    component,
    fixture,
    ...summarizeProjection(projection)
  });
}

async function step(results, id, component, fn) {
  const started = Date.now();
  try {
    const data = await fn();
    results.steps.push({
      id,
      component,
      status: "passed",
      duration_ms: Date.now() - started,
      data
    });
    return data;
  } catch (error) {
    const normalized = normalizeCaughtError(error);
    results.steps.push({
      id,
      component,
      status: "failed",
      duration_ms: Date.now() - started,
      error: normalized
    });
    throw error;
  }
}

async function writeReports(results, options) {
  const reportDir = options.reportDir
    ? path.resolve(options.reportDir)
    : await mkdtemp(path.join(os.tmpdir(), "velarumpay-cross-component-smoke-"));
  await mkdir(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, "cross-component-smoke-result.json");
  const summaryPath = path.join(reportDir, "cross-component-smoke-summary.md");
  const paths = {
    directory: reportDir,
    json: jsonPath,
    summary: summaryPath
  };
  await writeFile(jsonPath, JSON.stringify({ ...results, reports: paths }, null, 2));
  await writeFile(summaryPath, renderMarkdownSummary({ ...results, reports: paths }));
  return paths;
}

function renderMarkdownSummary(results) {
  const lines = [
    "# VelarumPay Cross Component Smoke Summary",
    "",
    `- Result: ${results.ok ? "PASS" : "FAIL"}`,
    `- Run ID: ${results.run_id}`,
    `- Platform API: ${results.base_url || "not available"} (${results.server_mode || "unknown"})`,
    `- Duration: ${results.duration_ms || 0} ms`,
    "",
    "## Steps",
    "",
    "| Step | Component | Status | Notes |",
    "| --- | --- | --- | --- |"
  ];
  for (const item of results.steps) {
    const note = item.status === "passed"
      ? summarizeStepNote(item.data)
      : `${item.error?.message || "failed"} (${item.error?.code || "error"})`;
    lines.push(`| ${item.id} | ${item.component} | ${item.status} | ${escapeMarkdownTable(note)} |`);
  }
  lines.push("", "## Requests", "");
  if (!results.requests.length) {
    lines.push("No requests were created.");
  } else {
    lines.push("| Component | Fixture | Request | Rail | Status | Review | Risk |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const requestItem of results.requests) {
      lines.push(
        `| ${requestItem.component} | ${requestItem.fixture} | ${requestItem.request_id} | ${requestItem.rail || ""} | ${requestItem.status || ""} | ${requestItem.review_state || ""} | ${requestItem.risk_level || ""} |`
      );
    }
  }
  if (results.error) {
    lines.push("", "## Error", "", "```json", JSON.stringify(results.error, null, 2), "```");
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function summarizeStepNote(data = {}) {
  if (data.expected_failure) return `expected failure ${data.locator || ""} ${data.code || ""}`.trim();
  if (data.request_id) return `${data.request_id} ${data.status || ""} ${data.review_state || ""}`.trim();
  if (data.fixtures) return `fixtures: ${data.fixtures.join(", ")}`;
  if (data.wallet_list_count !== undefined) return `wallet=${data.wallet_list_count}, connection=${data.connection_list_count}, events=${data.event_count}`;
  if (data.baseUrl) return data.baseUrl;
  return "";
}

function printHumanSummary(results) {
  const passed = results.steps.filter((item) => item.status === "passed").length;
  const failed = results.steps.filter((item) => item.status === "failed").length;
  console.log(`VelarumPay cross-component smoke ${results.ok ? "passed" : "failed"}`);
  console.log(`Steps: ${passed} passed, ${failed} failed`);
  console.log(`Requests created: ${results.requests.length}`);
  if (results.reports?.json) console.log(`Machine-readable result: ${results.reports.json}`);
  if (results.reports?.summary) console.log(`Human-readable summary: ${results.reports.summary}`);
  if (!results.ok && results.error) {
    console.error(`${results.error.name}: ${results.error.message}`);
  }
}

function parseArgs(argv) {
  const options = {
    json: false,
    reportDir: "",
    baseUrl: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--json") {
      options.json = true;
      continue;
    }
    if (item === "--report-dir") {
      options.reportDir = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (item.startsWith("--report-dir=")) {
      options.reportDir = item.slice("--report-dir=".length);
      continue;
    }
    if (item === "--base-url") {
      options.baseUrl = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (item.startsWith("--base-url=")) {
      options.baseUrl = item.slice("--base-url=".length);
      continue;
    }
    if (item === "--help" || item === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown option: ${item}`);
  }
  return options;
}

function printHelp() {
  console.log(`VelarumPay cross-component smoke harness

Usage:
  node scripts/cross-component-smoke.mjs [options]

Options:
  --base-url <url>      Use an already running Platform API. Defaults to BASE_URL.
  --report-dir <path>   Write JSON and Markdown reports to a fixed directory.
  --json                Print the machine-readable result to stdout.
  --help                Show this help.

Without --base-url or BASE_URL, the harness starts a temporary local Platform API.
It never reads private keys, seed phrases, signing keys, or mainnet funds.`);
}

async function loadJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function hasRiskCode(items = [], code) {
  return items.some((item) => item?.code === code);
}

function normalizeCaughtError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || "",
    code: error?.code || ""
  };
}

function escapeMarkdownTable(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function sanitizeId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 96);
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

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
