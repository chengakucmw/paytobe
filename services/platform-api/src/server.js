// VelarumPay relay backend — application bootstrap.
//
// This file's only job is wiring: build the singletons (store, observability,
// WS hub), assemble the shared dependencies, mount the per-resource routers,
// register the WebSocket handlers, and start listening. All request handling
// and domain logic lives in ./routes/*, ./domain/*, ./http/*, ./realtime/* and
// ./chain/*. (Previously this was a single 1700-line file; see
// 巨型文件拆分方案_2026-06-20.md for the decomposition.)

import cors from "cors";
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

import { id } from "./crypto.js";
import { loadDotEnv } from "./env.js";
import { Store } from "./store.js";
import {
  assertRuntimeConfig,
  createCorsOptions,
  createRateLimitMiddleware,
  createSecurityHeadersMiddleware,
  loadRuntimeConfig,
  verifyOpenClawWebSocket
} from "./security.js";
import { createObservability } from "./observability.js";

// Internal helpers re-exported for regression tests (see below).
import {
  PAYMENT_REQUEST_STATUS_TRANSITIONS,
  validatePaymentRequestStatusUpdate
} from "./domain/payment-request.js";

import { createWsHub } from "./realtime/ws-hub.js";
import { apiWarning, createResponders } from "./http/responses.js";
import { createAuth } from "./http/auth.js";
import { createMetrics } from "./domain/metrics.js";
import { createPairing } from "./domain/pairing.js";
import { createTransactionContext } from "./domain/transaction-context.js";
import { createConfirmation } from "./chain/confirmation.js";

import { createSystemRouter } from "./routes/system.js";
import { createDevicesRouter } from "./routes/devices.js";
import { createTransactionContextsRouter } from "./routes/transaction-contexts.js";
import { createPairingRouter } from "./routes/pairing.js";
import { createConnectionsRouter } from "./routes/connections.js";
import { createPaymentRequestsRouter } from "./routes/payment-requests.js";
import { createPaymentIntentsRouter } from "./routes/payment-intents.js";
import { createOpenClawRouter } from "./routes/openclaw.js";

loadDotEnv();

const runtimeConfig = loadRuntimeConfig();
const runtimeValidation = assertRuntimeConfig(runtimeConfig);
const PORT = Number(process.env.PORT || 8787);

// ---------------------------------------------------------------------------
// Singletons + dependency wiring
// ---------------------------------------------------------------------------
const store = new Store();
const observability = createObservability();
const app = express();
if (runtimeConfig.trust_proxy) app.set("trust proxy", 1);
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// The WS hub owns the socket maps; destructure into the same names the WS
// handlers and the test exports use, so they share one Map instance.
const wsHub = createWsHub();
const { appSockets, openclawSockets, addSocket, removeSocket, notifyApp, notifyOpenClaw } = wsHub;

const { sendApiError, sendAuthFailure } = createResponders({ observability });
const {
  auditActorFromAuth,
  authorizeConnection,
  verifyOpenClaw,
  verifyAppQuery,
  verifyAppBody
} = createAuth({ store, runtimeConfig, observability });
const { refreshRuntimeMetrics, recordPairingExpired } = createMetrics({ store, observability, wsHub });
const { uniquePairingCode, resolvePairingSession } = createPairing({ store });
const { buildTransactionContextProjection } = createTransactionContext({ store });
const { confirmLater } = createConfirmation({ store, notifyApp, notifyOpenClaw });

// Shared bag of dependencies handed to every router factory; each router
// destructures only what it needs.
const routeDeps = {
  store,
  observability,
  runtimeConfig,
  runtimeValidation,
  sendApiError,
  sendAuthFailure,
  auditActorFromAuth,
  authorizeConnection,
  verifyOpenClaw,
  verifyAppQuery,
  verifyAppBody,
  notifyApp,
  notifyOpenClaw,
  refreshRuntimeMetrics,
  recordPairingExpired,
  uniquePairingCode,
  resolvePairingSession,
  buildTransactionContextProjection,
  confirmLater
};

// ---------------------------------------------------------------------------
// Middleware (order matters; unchanged from the monolith)
// ---------------------------------------------------------------------------
app.use(observability.httpMiddleware());
app.use(createSecurityHeadersMiddleware());
app.use(cors(createCorsOptions(runtimeConfig)));
app.use("/v1", createRateLimitMiddleware(runtimeConfig, {
  name: "api",
  max: runtimeConfig.rate_limit.max
}));
app.use([
  "/v1/devices",
  "/v1/pairing",
  "/v1/connections",
  "/v1/payment-intents",
  "/v1/openclaw"
], createRateLimitMiddleware(runtimeConfig, {
  name: "auth",
  max: runtimeConfig.rate_limit.auth_max
}));
app.use(express.json({
  limit: "256kb",
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString("utf8");
  }
}));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use("/", createSystemRouter(routeDeps));
app.use("/v1/devices", createDevicesRouter(routeDeps));
app.use("/v1/transaction-contexts", createTransactionContextsRouter(routeDeps));
app.use("/v1/pairing", createPairingRouter(routeDeps));
app.use("/v1/connections", createConnectionsRouter(routeDeps));
app.use("/v1/payment-requests", createPaymentRequestsRouter(routeDeps));
app.use("/v1/payment-intents", createPaymentIntentsRouter(routeDeps));
app.use("/v1/openclaw", createOpenClawRouter(routeDeps));

app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  const status = error?.status || error?.statusCode || 500;
  const code = status === 413 ? "payload_too_large" : status === 400 ? "invalid_json" : "internal_error";
  const message = status >= 500 ? "Internal server error" : error.message || "Invalid request";
  sendApiError(res, status, code, message);
});

// ---------------------------------------------------------------------------
// WebSocket handlers
// ---------------------------------------------------------------------------
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!["/v1/ws/app", "/v1/ws/openclaw", "/v1/ws/agent"].includes(url.pathname)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, url);
  });
});

wss.on("connection", (ws, _req, url) => {
  if (url.pathname === "/v1/ws/app") {
    const deviceId = url.searchParams.get("device_id") || "";
    const token = url.searchParams.get("token") || "";
    if (!store.verifyDeviceToken(deviceId, token)) {
      ws.close(1008, "unauthorized");
      return;
    }
    addSocket(appSockets, deviceId, ws);
    ws.send(JSON.stringify({ type: "hello", role: "app", device_id: deviceId }));
    ws.on("close", () => removeSocket(appSockets, deviceId, ws));
    return;
  }

  if (url.pathname === "/v1/ws/agent") {
    const token = url.searchParams.get("connection_token") || url.searchParams.get("token") || "";
    const connection = store.connectionByToken(token);
    if (!connection || connection.status !== "active" || !connection.scopes.includes("payment.requests.read")) {
      ws.close(1008, "unauthorized");
      return;
    }
    if (connection.expires_at && Date.parse(connection.expires_at) <= Date.now()) {
      ws.close(1008, "connection expired");
      return;
    }
    addSocket(openclawSockets, connection.connection_id, ws);
    ws.send(JSON.stringify({
      type: "hello",
      role: "agent",
      connection_id: connection.connection_id
    }));
    ws.on("close", () => removeSocket(openclawSockets, connection.connection_id, ws));
    store.touchConnection(connection.connection_id);
    return;
  }

  if (url.pathname === "/v1/ws/openclaw") {
    const auth = verifyOpenClawWebSocket(_req, url, runtimeConfig);
    if (!auth.ok) {
      ws.close(1008, auth.error || "unauthorized");
      observability.recordAuditEvent("legacy_openclaw.websocket_rejected", "failure", {
        actor: { type: "legacy_openclaw" },
        resource: { type: "websocket", id: url.pathname },
        labels: { code: auth.code || "unauthorized" }
      });
      return;
    }
    // M1: isolate an anonymous legacy socket under its own unguessable key
    // instead of the shared "default" bucket, so it can never be handed another
    // connection's status messages.
    const deviceId = url.searchParams.get("device_id") || id("legacy");
    addSocket(openclawSockets, deviceId, ws);
    ws.send(JSON.stringify({ type: "hello", role: "openclaw", device_id: deviceId }));
    ws.on("close", () => removeSocket(openclawSockets, deviceId, ws));
    return;
  }
});

// Production (`node src/server.js`) leaves VP_NO_AUTO_LISTEN unset and binds the
// port normally. Tests import this module to exercise the handlers/helpers
// directly and set VP_NO_AUTO_LISTEN=1 so importing doesn't occupy a socket.
if (process.env.VP_NO_AUTO_LISTEN !== "1") {
  server.listen(PORT, () => {
    console.log(`AgentWallet Relay listening on http://0.0.0.0:${PORT}`);
  });
}

// Exported for regression tests (see tests/backend/medium-fixes.test.mjs).
// These are internal helpers; the public surface is the HTTP/WS API above.
// addSocket/removeSocket/notifyOpenClaw/appSockets/openclawSockets now come from
// the WS hub, confirmLater from the confirmation module, and the state-machine
// helpers from ./domain/payment-request.js — re-exported here under their
// original names so the test imports are unchanged.
export {
  app,
  server,
  store,
  addSocket,
  removeSocket,
  notifyOpenClaw,
  appSockets,
  openclawSockets,
  confirmLater,
  validatePaymentRequestStatusUpdate,
  PAYMENT_REQUEST_STATUS_TRANSITIONS
};

// apiWarning is part of the HTTP helper surface; kept importable from here too.
export { apiWarning };
