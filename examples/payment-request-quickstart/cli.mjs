#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BASE_URL,
  createPaytobeClient,
  validatePaymentRequest,
  validateTransactionContext
} from "../../packages/sdk-js/src/index.js";

const DEFAULT_SCOPES = [
  "payment.requests.create",
  "payment.requests.read",
  "transaction_contexts.create",
  "transaction_contexts.read"
];

const FIXTURE_ALIASES = {
  base_usdc: "base_usdc",
  base: "base_usdc",
  normal: "normal",
  stellar: "stellar_xlm",
  stellar_xlm: "stellar_xlm"
};

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");

async function main() {
  const { command, args, options } = parseCli(process.argv.slice(2));

  if (!command || command === "help" || options.help) {
    printHelp();
    return;
  }

  switch (command) {
    case "fixtures":
      return printFixtures(options);
    case "pair":
      return pair(options);
    case "context:create":
      return createContext(options);
    case "request:create":
      return createRequest(options);
    case "request:get":
      return getRequest(args, options);
    case "events:poll":
      return pollEvents(options);
    case "request:reject":
      return updateRequestStatus(args, options, "rejected");
    case "request:confirm":
      return updateRequestStatus(args, options, "confirmed");
    case "status:update":
      return updateRequestStatus(args, options, readOption(options, "status"));
    default:
      throw new CliError(`Unknown command: ${command}`, {
        hint: "Run: node examples/payment-request-quickstart/cli.mjs help"
      });
  }
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  const args = [];
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) {
      args.push(item);
      continue;
    }

    const raw = item.slice(2);
    const eq = raw.indexOf("=");
    const key = camelize(eq >= 0 ? raw.slice(0, eq) : raw);
    if (eq >= 0) {
      options[key] = raw.slice(eq + 1);
      continue;
    }

    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }

  return { command, args, options };
}

async function printFixtures(options = {}) {
  const files = (await readdir(fixturesDir))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const items = [];
  for (const file of files) {
    const fixture = await loadFixture(file.replace(/\.json$/, ""));
    items.push({
      name: fixture.name || file.replace(/\.json$/, ""),
      file: `fixtures/${file}`,
      description: fixture.description || "",
      rail: fixture.payment_request?.payment?.rail || "",
      network: fixture.payment_request?.payment?.network || "",
      asset: fixture.payment_request?.payment?.asset || ""
    });
  }
  output(options, { ok: true, items }, () => {
    console.log("Available quickstart fixtures:");
    for (const item of items) {
      console.log(`- ${item.name}: ${item.asset} on ${item.network} (${item.rail})`);
      if (item.description) console.log(`  ${item.description}`);
    }
  });
}

async function pair(options) {
  const baseUrl = baseUrlFrom(options);
  const client = clientFrom(options);
  const scopes = scopesFrom(options);
  const payload = {
    agent: {
      agent_id: readOption(options, "agentId") || `agt_cli_${Date.now()}`,
      agent_name: readOption(options, "agentName") || "Paytobe CLI Quickstart",
      runtime: readOption(options, "runtime") || "cli",
      device_label: readOption(options, "deviceLabel") || "local developer shell"
    },
    requested_scopes: scopes,
    expires_in_seconds: numberOption(options, "expiresInSeconds", 300)
  };

  const pairing = await unwrap(client.createPairingSession(payload));
  const result = { ok: true, pairing_session: pairing.pairing_session };

  if (options.approveDevWallet) {
    const wallet = walletCredentials(options, { generate: true });
    await api(baseUrl, "POST", "/v1/devices/app", {
      device_id: wallet.device_id,
      token: wallet.token
    });
    const approved = await api(
      baseUrl,
      "POST",
      `/v1/pairing/sessions/${encodeURIComponent(pairing.pairing_session.pairing_session_id)}/approve`,
      {
        device_id: wallet.device_id,
        token: wallet.token,
        approved_scopes: scopes
      }
    );
    result.dev_wallet = wallet;
    result.connection = approved.connection;
    result.pairing_session = approved.pairing_session;
  }

  output(options, result, () => {
    const session = result.pairing_session;
    console.log("Pairing session created.");
    console.log(`Pairing code: ${session.pairing_code}`);
    console.log(`Pairing URI: ${session.pairing_uri}`);
    console.log(`Status: ${session.status}`);
    if (result.connection) {
      const runId = `cli_${Date.now()}`;
      console.log("");
      console.log("Dev wallet approved this pairing.");
      console.log("Use these exports for the next commands:");
      console.log(`export CONNECTION_TOKEN=${shellQuote(result.connection.connection_token)}`);
      console.log(`export WALLET_DEVICE_ID=${shellQuote(result.dev_wallet.device_id)}`);
      console.log(`export WALLET_TOKEN=${shellQuote(result.dev_wallet.token)}`);
      console.log(`export QUICKSTART_RUN_ID=${shellQuote(runId)}`);
    } else {
      console.log("");
      console.log("Approve this session in the wallet, then set CONNECTION_TOKEN before creating context or requests.");
    }
  });
}

async function createContext(options) {
  const fixture = await loadFixture(readOption(options, "fixture") || "base_usdc");
  const materialized = materializeFixture(fixture, options);
  const validation = validateTransactionContext(materialized.validation.transaction_context);
  if (!validation.ok) throw validationFailure("Transaction Context fixture failed local validation", validation);

  const result = await unwrap(clientFrom(options).createTransactionContext(materialized.submit.transaction_context));
  output(options, result, () => {
    const context = result.context;
    console.log("Transaction Context created.");
    console.log(`transaction_id: ${context.transaction_id}`);
    if (result.warnings?.length) printWarnings(result.warnings);
  });
}

async function createRequest(options) {
  const fixture = await loadFixture(readOption(options, "fixture") || "base_usdc");
  const materialized = materializeFixture(fixture, options);
  const validation = validatePaymentRequest(materialized.validation.payment_request);
  if (!validation.ok) throw validationFailure("Payment Request fixture failed local validation", validation);

  const payload = {
    ...materialized.submit.payment_request
  };
  const targetDevice = readOption(options, "walletDeviceId") || process.env.WALLET_DEVICE_ID || "";
  if (targetDevice) payload.target_app_device_id = targetDevice;

  const result = await unwrap(clientFrom(options).createPaymentRequest(payload, {
    idempotencyKey: materialized.submit.payment_request.idempotency_key
  }));
  output(options, result, () => {
    const request = result.payment_request;
    console.log(result.duplicate ? "Payment Request already existed for this idempotency key." : "Payment Request created.");
    console.log(`request_id: ${request.request_id}`);
    console.log(`transaction_id: ${request.transaction_id}`);
    console.log(`status: ${request.status}`);
    console.log(`review_state: ${request.status_projection?.review_state || request.review_state || "unknown"}`);
    console.log(`risk: ${request.risk?.level || "unknown"}`);
    if (result.warnings?.length) printWarnings(result.warnings);
  });
}

async function getRequest(args, options) {
  const requestId = args[0] || readOption(options, "requestId");
  if (!requestId) {
    throw new CliError("request:get requires a request id", {
      hint: "Example: node examples/payment-request-quickstart/cli.mjs request:get prq_123 --connection-token \"$CONNECTION_TOKEN\""
    });
  }

  const result = await unwrap(clientFrom(options).getPaymentRequest(requestId));
  output(options, result, () => {
    const request = result.payment_request;
    console.log("Payment Request detail.");
    console.log(`request_id: ${request.request_id}`);
    console.log(`status: ${request.status}`);
    console.log(`review_state: ${request.status_projection?.review_state || request.review_state || "unknown"}`);
    console.log(`label: ${request.status_projection?.label || request.status_label || "unknown"}`);
    console.log(`payment: ${request.payment?.amount} ${request.payment?.asset} on ${request.payment?.network}`);
  });
}

async function pollEvents(options) {
  const since = numberOption(options, "since", 0);
  const result = await unwrap(clientFrom(options).pollEvents({ since }));
  output(options, result, () => {
    const items = result.items || [];
    console.log(`Payment Request events since ${since}: ${items.length}`);
    for (const event of items) {
      console.log(`- seq=${event.seq} type=${event.type} request_id=${event.request_id} status=${event.status || ""}`);
    }
  });
}

async function updateRequestStatus(args, options, status) {
  const requestId = args[0] || readOption(options, "requestId");
  if (!requestId) {
    throw new CliError("status update requires a request id", {
      hint: "Example: node examples/payment-request-quickstart/cli.mjs request:reject prq_123 --wallet-device-id \"$WALLET_DEVICE_ID\" --wallet-token \"$WALLET_TOKEN\""
    });
  }
  if (!status) throw new CliError("status:update requires --status");

  const baseUrl = baseUrlFrom(options);
  const wallet = walletCredentials(options);
  const body = {
    device_id: wallet.device_id,
    token: wallet.token,
    status
  };
  const txHash = readOption(options, "txHash");
  if (txHash) body.tx_hash = txHash;
  const error = readOption(options, "error");
  if (error) body.error = error;

  const result = await api(baseUrl, "POST", `/v1/payment-requests/${encodeURIComponent(requestId)}/status`, body);
  output(options, result, () => {
    const request = result.payment_request;
    console.log("Wallet status callback recorded.");
    console.log(`request_id: ${request.request_id}`);
    console.log(`status: ${request.status}`);
    console.log(`review_state: ${request.status_projection?.review_state || request.review_state || "unknown"}`);
    if (status === "confirmed") {
      console.log("This is a local dev status callback only. The CLI did not sign or broadcast a transaction.");
    }
  });
}

function clientFrom(options) {
  const token = readOption(options, "connectionToken") || process.env.CONNECTION_TOKEN || "";
  return createPaytobeClient({
    baseUrl: baseUrlFrom(options),
    connectionToken: token
  });
}

function baseUrlFrom(options) {
  return String(readOption(options, "baseUrl") || process.env.BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

async function loadFixture(nameOrPath) {
  const requested = String(nameOrPath || "base_usdc");
  const normalized = FIXTURE_ALIASES[requested] || requested;
  const file = normalized.endsWith(".json") || normalized.includes("/")
    ? normalized
    : path.join(fixturesDir, `${normalized}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new CliError(`Could not load fixture: ${requested}`, {
      hint: `Run fixtures to see available names. Underlying error: ${error.message}`
    });
  }
}

function materializeFixture(fixture, options = {}) {
  const runId = sanitizeRunId(readOption(options, "runId") || process.env.QUICKSTART_RUN_ID || "");
  const connectionId = readOption(options, "connectionId") || process.env.CONNECTION_ID || "";
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + numberOption(options, "ttlSeconds", 600) * 1000).toISOString();
  const transactionContext = clone(fixture.transaction_context);
  const paymentRequest = clone(fixture.payment_request);

  if (runId) {
    transactionContext.transaction_id = `${transactionContext.transaction_id}_${runId}`;
    paymentRequest.transaction_id = transactionContext.transaction_id;
    paymentRequest.request_id = `${paymentRequest.request_id}_${runId}`;
    paymentRequest.idempotency_key = `${paymentRequest.idempotency_key}_${runId}`;
  }

  transactionContext.created_at = createdAt;
  transactionContext.updated_at = createdAt;
  paymentRequest.created_at = createdAt;
  paymentRequest.expires_at = expiresAt;
  paymentRequest.status = "pending";

  const validationContext = clone(transactionContext);
  const validationRequest = clone(paymentRequest);
  validationContext.connection_id = connectionId || validationContext.connection_id || "conn_quickstart_placeholder";
  validationRequest.connection_id = connectionId || validationRequest.connection_id || "conn_quickstart_placeholder";

  if (connectionId) {
    transactionContext.connection_id = connectionId;
    paymentRequest.connection_id = connectionId;
  } else {
    delete transactionContext.connection_id;
    delete paymentRequest.connection_id;
  }

  return {
    validation: {
      transaction_context: validationContext,
      payment_request: validationRequest
    },
    submit: {
      transaction_context: transactionContext,
      payment_request: paymentRequest
    }
  };
}

async function api(baseUrl, method, urlPath, body = null) {
  let response;
  try {
    response = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    throw new CliError(`Could not reach Platform API at ${baseUrl}`, {
      hint: "Start it from the repository root with: cd services/platform-api && npm start",
      cause: error
    });
  }

  const data = await readResponseJson(response);
  if (!response.ok || data?.ok === false) {
    throw apiFailure(data, response.status, response.statusText);
  }
  return data;
}

async function unwrap(promise) {
  let result;
  try {
    result = await promise;
  } catch (error) {
    throw new CliError("Could not reach Platform API", {
      hint: "Start it from the repository root with: cd services/platform-api && npm start",
      cause: error
    });
  }
  if (result?.ok === false) throw apiFailure(result, result.status, result.error?.message);
  return result;
}

async function readResponseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid_json_response",
        message: "Platform API returned a non-JSON response",
        severity: "blocker"
      }
    };
  }
}

function apiFailure(data, status, statusText = "") {
  const error = normalizeError(data?.error || {
    code: "http_error",
    message: statusText || `HTTP ${status}`,
    severity: "blocker"
  });
  return new CliError("Platform API request failed", {
    status,
    error,
    warnings: data?.warnings || [],
    hint: hintFor(error.code)
  });
}

function validationFailure(message, result) {
  const error = normalizeError(result.error);
  return new CliError(message, {
    error,
    hint: "Check the selected fixture or run the built-in fixtures command."
  });
}

function normalizeError(error) {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  return {
    ...error,
    code: error?.code || "api_error",
    message: error?.message || error?.code || "Request failed",
    field: error?.field || details.field || "",
    severity: error?.severity || details.severity || "blocker"
  };
}

function hintFor(code) {
  const hints = {
    unauthorized_connection: "Set CONNECTION_TOKEN from the pair --approve-dev-wallet output, or approve the pairing in a wallet first.",
    invalid_app_device_token: "Set WALLET_DEVICE_ID and WALLET_TOKEN from pair --approve-dev-wallet, or register a dev wallet first.",
    scope_denied: "Approve all quickstart scopes: payment.requests.create/read and transaction_contexts.create/read.",
    target_device_required: "Pass --wallet-device-id or set WALLET_DEVICE_ID so the request has a local wallet target.",
    payment_request_not_found: "Check the request id and make sure you are using the same connection or wallet credentials.",
    terminal_payment_request: "Create a new request with a new QUICKSTART_RUN_ID before changing status again."
  };
  return hints[code] || "";
}

function walletCredentials(options, settings = {}) {
  const generated = settings.generate ? `dev_${Date.now()}` : "";
  const deviceId = readOption(options, "walletDeviceId") || process.env.WALLET_DEVICE_ID || (generated && `wallet_${generated}`);
  const token = readOption(options, "walletToken") || process.env.WALLET_TOKEN || (generated && `token_${generated}`);
  if (!deviceId || !token) {
    throw new CliError("Wallet device credentials are required for this command", {
      hint: "Use pair --approve-dev-wallet first, then export WALLET_DEVICE_ID and WALLET_TOKEN from its output."
    });
  }
  return { device_id: deviceId, token };
}

function scopesFrom(options) {
  const raw = readOption(options, "scopes");
  if (!raw) return DEFAULT_SCOPES;
  return String(raw)
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function numberOption(options, key, fallback) {
  const value = readOption(options, key);
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new CliError(`--${kebab(key)} must be a number`);
  }
  return number;
}

function readOption(options, key) {
  return options[key] ?? options[camelize(key)] ?? options[kebab(key)];
}

function output(options, json, renderHuman) {
  if (options.json) {
    console.log(JSON.stringify(json, null, 2));
    return;
  }
  renderHuman();
}

function printWarnings(warnings = []) {
  console.log("warnings:");
  for (const warning of warnings) {
    const error = normalizeError(warning);
    console.log(`- ${error.code}${error.field ? ` (${error.field})` : ""}: ${error.message}`);
  }
}

function printHelp() {
  console.log(`Paytobe CLI quickstart

Usage:
  node examples/payment-request-quickstart/cli.mjs <command> [options]

Core commands:
  pair                         Create a pairing session.
  context:create               Submit a fixture Transaction Context.
  request:create               Submit a fixture Payment Request.
  request:get <request_id>     Read a Payment Request through the connection token.
  events:poll                  Poll Payment Request status events.

Dev wallet demo commands:
  request:reject <request_id>  Simulate a local wallet reject callback.
  request:confirm <request_id> Simulate a local wallet confirmed callback.
  status:update <request_id>   Simulate a wallet status callback with --status.

Utility:
  fixtures                     List available fixtures.

Common options:
  --base-url <url>             Platform API URL. Defaults to ${DEFAULT_BASE_URL}.
  --connection-token <token>   Connection token. Defaults to CONNECTION_TOKEN.
  --wallet-device-id <id>      Wallet device id. Defaults to WALLET_DEVICE_ID.
  --wallet-token <token>       Wallet token. Defaults to WALLET_TOKEN.
  --fixture <name>             Fixture name. Defaults to base_usdc.
  --run-id <id>                Suffix request ids and idempotency keys.
  --json                       Print machine-readable JSON.

Fast local path:
  node examples/payment-request-quickstart/cli.mjs pair --approve-dev-wallet
  node examples/payment-request-quickstart/cli.mjs context:create --fixture stellar_xlm
  node examples/payment-request-quickstart/cli.mjs request:create --fixture stellar_xlm
  node examples/payment-request-quickstart/cli.mjs events:poll --since 0

This CLI never handles private keys, seed phrases, signing material, or automatic payment authority.`);
}

function camelize(value) {
  return String(value).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function kebab(value) {
  return String(value).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function sanitizeRunId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 64);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class CliError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

main().catch((error) => {
  if (error instanceof CliError) {
    console.error(error.message);
    if (error.details.status) console.error(`status: ${error.details.status}`);
    if (error.details.error) {
      const apiError = normalizeError(error.details.error);
      console.error(`code: ${apiError.code}`);
      console.error(`message: ${apiError.message}`);
      if (apiError.field) console.error(`field: ${apiError.field}`);
      if (apiError.severity) console.error(`severity: ${apiError.severity}`);
    }
    if (error.details.hint) console.error(`hint: ${error.details.hint}`);
    if (error.details.cause?.message) console.error(`cause: ${error.details.cause.message}`);
    process.exit(1);
  }

  console.error(error.stack || error.message);
  process.exit(1);
});
