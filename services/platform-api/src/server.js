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

import {
  createConnectKey,
  id,
  normalizeEd25519PublicKey,
  opaqueToken,
  tokenHash,
  verifyEd25519Signature
} from "./crypto.js";
import { loadDotEnv } from "./env.js";
import { Store } from "./store.js";
import { createPlatformCore } from "./application/platform-core.js";
import { createClockPort } from "./ports/clock.js";
import { createRandomPort } from "./ports/random.js";
import { createRepositoryPort, createTransactionBoundary } from "./ports/repository.js";
import {
  assertRuntimeConfig,
  validateRuntimeConfig,
  createCorsOptions,
  createRateLimitMiddleware,
  createSecurityHeadersMiddleware,
  createTestnetOnlyMiddleware,
  isOriginAllowed,
  loadRuntimeConfig,
  ReplayGuard,
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
import { createFcmPushService } from "./push/fcm.js";
import {
  MerchantAccountService,
  MemoryMerchantAccountRepository,
  SqliteMerchantAccountRepository
} from "./application/merchant-accounts/service.js";
import { createMemoryEmailAdapter } from "./adapters/email/memory.js";
import { createCloudflareEmailAdapter } from "./adapters/email/cloudflare.js";
import {
  MerchantSessionService,
  MemoryMerchantSessionRepository,
  SqliteMerchantSessionRepository
} from "./application/merchant-sessions/service.js";
import {
  MerchantService,
  MemoryMerchantRepository,
  SqliteMerchantRepository
} from "./application/merchants/service.js";
import {
  MerchantMembershipService,
  MemoryMerchantMembershipRepository,
  SqliteMerchantMembershipRepository
} from "./application/merchant-memberships/service.js";
import {
  MerchantDomainService,
  MemoryMerchantDomainRepository,
  SqliteMerchantDomainRepository
} from "./application/merchant-domains/service.js";
import {
  AgentService,
  MemoryAgentRepository,
  SqliteAgentRepository
} from "./application/agents/service.js";
import {
  AgentCredentialService,
  MemoryAgentCredentialRepository,
  SqliteAgentCredentialRepository
} from "./application/agent-credentials/service.js";
import {
  AgentAuthService,
  MemoryAgentAuthRepository,
  SqliteAgentAuthRepository
} from "./application/agent-auth/service.js";
import {
  RecipientService,
  MemoryRecipientRepository,
  SqliteRecipientRepository
} from "./application/recipients/service.js";
import {
  MemoryRecipientEvidenceVerifier,
  SqliteRecipientEvidenceVerifier
} from "./application/recipients/evidence.js";
import { createSystemDomainVerifierPorts } from "./adapters/domain-verifier/system.js";
import { WebhookEndpointVerifier } from "./adapters/webhook/endpoint-verifier.js";
import {
  MemoryWebhookEndpointRepository,
  SqliteWebhookEndpointRepository,
  WebhookEndpointService
} from "./application/webhooks/endpoint-service.js";
import { WebhookDeliveryService } from "./application/webhooks/delivery-worker.js";
import { MemoryWebhookDeliveryRepository, SqliteWebhookDeliveryRepository } from "./adapters/webhook/delivery-repository.js";
import { SqliteWebhookOutbox } from "./adapters/sqlite/webhook-outbox.js";
import { SafeWebhookTransport } from "./adapters/webhook/transport.js";
import { createAes256GcmVault } from "./crypto.js";

import { createSystemRouter } from "./routes/system.js";
import { createDevicesRouter } from "./routes/devices.js";
import { createTransactionContextsRouter } from "./routes/transaction-contexts.js";
import { createPairingRouter } from "./routes/pairing.js";
import { createConnectInvitationsRouter } from "./routes/connect-invitations.js";
import { createConnectionsRouter } from "./routes/connections.js";
import { createPaymentRequestsRouter } from "./routes/payment-requests.js";
import { createPaymentIntentsRouter } from "./routes/payment-intents.js";
import { createOpenClawRouter } from "./routes/openclaw.js";
import { createMerchantAccountsRouter } from "./routes/merchant-accounts.js";
import { createMerchantSessionsRouter } from "./routes/merchant-sessions.js";
import { createMerchantsRouter } from "./routes/merchants.js";
import { createMerchantMembershipsRouter } from "./routes/merchant-memberships.js";
import { createMerchantDomainsRouter } from "./routes/merchant-domains.js";
import { createAgentsRouter } from "./routes/agents.js";
import { createAgentCredentialsRouter } from "./routes/agent-credentials.js";
import { createAgentAuthRouter } from "./routes/agent-auth.js";
import { createRecipientsRouter } from "./routes/recipients.js";
import { createWebhookEndpointsRouter } from "./routes/webhook-endpoints.js";
import { createWebhookDeliveriesRouter } from "./routes/webhook-deliveries.js";
import { createMerchantAuditRouter } from "./routes/merchant-audit.js";

loadDotEnv();

const runtimeConfig = loadRuntimeConfig();
// Validate the runtime config, but only HARD-FAIL when we are actually going to
// serve. Under the test hook (VP_NO_AUTO_LISTEN) server.js is imported for its
// exported internals — not deployed — so a non-production-ready config (e.g. a
// dev machine that exports NODE_ENV=production in its shell) must not block the
// import. Real startup and `npm run start:production` still assert.
const runtimeValidation = process.env.VP_NO_AUTO_LISTEN
  ? validateRuntimeConfig(runtimeConfig)
  : assertRuntimeConfig(runtimeConfig);
const PORT = Number(process.env.PORT || 8787);

// ---------------------------------------------------------------------------
// Singletons + dependency wiring
// ---------------------------------------------------------------------------
const store = new Store();
const observability = createObservability();
const platformCore = createPlatformCore({
  clock: createClockPort(),
  random: createRandomPort({ id, opaqueToken, connectKey: createConnectKey }),
  transaction: createTransactionBoundary(),
  repositories: { legacy: createRepositoryPort(store, ["info"]) }
});
// One process-wide replay guard for OpenClaw signed requests; TTL matches the
// signature freshness window so remembered nonces expire exactly when a request
// bearing them would already be rejected as stale.
const openClawReplayGuard = new ReplayGuard({ ttlMs: runtimeConfig.openclaw.signature_max_skew_ms });
const app = express();
if (runtimeConfig.trust_proxy) app.set("trust proxy", 1);
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// The WS hub owns the socket maps; destructure into the same names the WS
// handlers and the test exports use, so they share one Map instance.
const wsHub = createWsHub();
const { appSockets, openclawSockets, addSocket, removeSocket, notifyApp, notifyOpenClaw } = wsHub;

const { sendApiError, sendAuthFailure } = createResponders({ observability });
const merchantEmail = runtimeConfig.email.provider === "cloudflare"
  ? createCloudflareEmailAdapter(runtimeConfig.email)
  : createMemoryEmailAdapter();
const merchantAccountService = new MerchantAccountService({
  repository: store.db ? new SqliteMerchantAccountRepository(store.db) : new MemoryMerchantAccountRepository(),
  email: merchantEmail,
  clock: platformCore.clock,
  random: platformCore.random,
  hash: tokenHash
});
const merchantSessionService = new MerchantSessionService({
  repository: store.db ? new SqliteMerchantSessionRepository(store.db) : new MemoryMerchantSessionRepository(),
  clock: platformCore.clock,
  random: platformCore.random,
  hash: tokenHash,
  originAllowed: (origin) => isOriginAllowed(origin, runtimeConfig).ok,
  email: merchantEmail
});
const merchantService = new MerchantService({
  repository: store.db ? new SqliteMerchantRepository(store.db) : new MemoryMerchantRepository(),
  clock: platformCore.clock,
  random: platformCore.random,
  hash: tokenHash
});
const merchantMembershipService = new MerchantMembershipService({
  repository: store.db ? new SqliteMerchantMembershipRepository(store.db) : new MemoryMerchantMembershipRepository(),
  clock: platformCore.clock,
  random: platformCore.random,
  hash: tokenHash
});
const domainVerifierPorts = createSystemDomainVerifierPorts();
const merchantDomainService = new MerchantDomainService({
  repository: store.db ? new SqliteMerchantDomainRepository(store.db) : new MemoryMerchantDomainRepository(),
  clock: platformCore.clock,
  random: platformCore.random,
  hash: tokenHash,
  resolver: domainVerifierPorts.resolver,
  fetcher: domainVerifierPorts.fetcher
});
const agentService = new AgentService({
  repository: store.db ? new SqliteAgentRepository(store.db) : new MemoryAgentRepository(),
  clock: platformCore.clock,
  random: platformCore.random
});
const agentCredentialService = new AgentCredentialService({
  repository: store.db ? new SqliteAgentCredentialRepository(store.db) : new MemoryAgentCredentialRepository(),
  clock: platformCore.clock,
  random: platformCore.random,
  hash: tokenHash,
  normalizePublicKey: normalizeEd25519PublicKey,
  verifySignature: verifyEd25519Signature
});
const agentAuthService = new AgentAuthService({
  repository: store.db ? new SqliteAgentAuthRepository(store.db) : new MemoryAgentAuthRepository(),
  clock: platformCore.clock,
  random: platformCore.random,
  hash: tokenHash,
  verifySignature: verifyEd25519Signature
});
const recipientService = new RecipientService({
  repository: store.db ? new SqliteRecipientRepository(store.db) : new MemoryRecipientRepository(),
  evidenceVerifier: store.db ? new SqliteRecipientEvidenceVerifier(store.db) : new MemoryRecipientEvidenceVerifier(),
  clock: platformCore.clock,
  random: platformCore.random,
  hash: tokenHash
});
const webhookEndpointVerifier = new WebhookEndpointVerifier(domainVerifierPorts);
const webhookSecretVault = optionalWebhookSecretVault(process.env.WEBHOOK_SECRET_ENCRYPTION_KEY);
const webhookEndpointService = new WebhookEndpointService({
  repository: store.db ? new SqliteWebhookEndpointRepository(store.db) : new MemoryWebhookEndpointRepository(),
  verifier: webhookEndpointVerifier,
  vault: webhookSecretVault,
  clock: platformCore.clock,
  random: platformCore.random,
  hash: tokenHash
});
const webhookDeliveryService = new WebhookDeliveryService({
  repository: store.db ? new SqliteWebhookDeliveryRepository(store.db) : new MemoryWebhookDeliveryRepository(),
  transport: new SafeWebhookTransport({ verifier: webhookEndpointVerifier, clock: platformCore.clock }),
  vault: webhookSecretVault,
  clock: platformCore.clock,
  random: platformCore.random,
  observability
});
const webhookOutbox = store.db ? new SqliteWebhookOutbox(store.db) : null;
let webhookDeliveryRunning = false;
function scheduleWebhookDelivery() {
  if (webhookDeliveryRunning) return;
  webhookDeliveryRunning = true;
  setImmediate(async () => {
    try {
      for (let processed = 0; processed < 100; processed += 1) {
        const result = await webhookDeliveryService.runOnce("webhook-worker");
        if (result.idle) break;
      }
    } catch (error) {
      observability.recordAuditEvent("webhook.worker_failed", "failure", {
        actor: { type: "platform_worker", id: "webhook_delivery" },
        resource: { type: "webhook_worker", id: "webhook-worker" },
        labels: { code: error?.code || "webhook_worker_failed" }
      });
    } finally {
      webhookDeliveryRunning = false;
    }
  });
}
const {
  auditActorFromAuth,
  authorizeConnection,
  verifyOpenClaw,
  verifyAppQuery,
  verifyAppBody,
  verifyMerchantSession,
  requireMerchantStepUp,
  verifyAgentAccessToken
} = createAuth({
  store,
  runtimeConfig,
  observability,
  replayGuard: openClawReplayGuard,
  merchantSessionService,
  agentAuthService
});
const { refreshRuntimeMetrics, recordPairingExpired } = createMetrics({ store, observability, wsHub });
const { uniquePairingCode, resolvePairingSession } = createPairing({ store });
const { buildTransactionContextProjection } = createTransactionContext({ store });
const { confirmLater, confirmPaymentRequestLater } = createConfirmation({ store, notifyApp, notifyOpenClaw });
const pushService = createFcmPushService({ config: runtimeConfig, store, observability });

// Shared bag of dependencies handed to every router factory; each router
// destructures only what it needs.
const routeDeps = {
  store,
  platformCore,
  merchantAccountService,
  merchantSessionService,
  merchantService,
  merchantMembershipService,
  merchantDomainService,
  agentService,
  agentCredentialService,
  agentAuthService,
  recipientService,
  webhookEndpointService,
  webhookDeliveryService,
  webhookOutbox,
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
  verifyMerchantSession,
  requireMerchantStepUp,
  verifyAgentAccessToken,
  notifyApp,
  notifyOpenClaw,
  pushService,
  refreshRuntimeMetrics,
  recordPairingExpired,
  uniquePairingCode,
  resolvePairingSession,
  buildTransactionContextProjection,
  confirmLater,
  confirmPaymentRequestLater,
  scheduleWebhookDelivery
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
  "/v1/connect-invitations",
  "/v1/connections",
  "/v1/payment-intents",
  "/v1/openclaw",
  "/v1/merchant-accounts",
  "/v1/merchant-sessions"
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
app.use("/v1", createTestnetOnlyMiddleware(runtimeConfig, {
  onViolation: (res, field) => sendApiError(
    res,
    400,
    "validation_failed",
    "The official VelarumPay environment accepts Stellar testnet only.",
    { field, details: { reason: "mainnet_forbidden", field } }
  )
}));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use("/", createSystemRouter(routeDeps));
app.use("/v1/devices", createDevicesRouter(routeDeps));
app.use("/v1/transaction-contexts", createTransactionContextsRouter(routeDeps));
app.use("/v1/pairing", createPairingRouter(routeDeps));
app.use("/v1/connect-invitations", createConnectInvitationsRouter(routeDeps));
app.use("/v1/connections", createConnectionsRouter(routeDeps));
const paymentRequestsRouter = createPaymentRequestsRouter(routeDeps);
app.use("/v1/payment-requests", paymentRequestsRouter);
app.use("/v1/payment-intents", createPaymentIntentsRouter(routeDeps));
app.use("/v1/openclaw", createOpenClawRouter(routeDeps));
app.use("/v1/merchant-accounts", createMerchantAccountsRouter(routeDeps));
app.use("/v1/merchant-sessions", createMerchantSessionsRouter(routeDeps));
app.use("/v1/merchants", createMerchantsRouter(routeDeps));
app.use("/v1", createMerchantMembershipsRouter(routeDeps));
app.use("/v1/merchant-domains", createMerchantDomainsRouter(routeDeps));
app.use("/v1/agents", createAgentsRouter(routeDeps));
app.use("/v1/agents", createAgentCredentialsRouter(routeDeps));
app.use("/v1/agent-auth", createAgentAuthRouter(routeDeps));
app.use("/v1/recipients", createRecipientsRouter(routeDeps));
app.use("/v1/webhook-endpoints", createWebhookEndpointsRouter(routeDeps));
app.use("/v1/webhook-deliveries", createWebhookDeliveriesRouter(routeDeps));
app.use("/v1/merchant-audit", createMerchantAuditRouter(routeDeps));

app.use((_req, res) => {
  sendApiError(res, 404, "resource_not_found", "Resource not found");
});

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
    if (platformCore.clock.isExpired(connection.expires_at)) {
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
    const deviceId = url.searchParams.get("device_id") || platformCore.random.id("legacy");
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
    void paymentRequestsRouter.reconcileBroadcasted();
  });

  // Background maintenance: sweep due expiries and retention-prune terminal records
  // OFF the request path. This keeps routine reads from escalating to an O(store)
  // expiry write (the on-request fast path stays cheap because nothing is due once the
  // sweep has run) and bounds the store as history accumulates, so the per-write
  // reload+snapshot stays small. unref() so the timer never keeps the process alive; it
  // only runs while serving (this branch is skipped under the VP_NO_AUTO_LISTEN test
  // hook). Interval configurable via RELAY_MAINTENANCE_INTERVAL_MS (default 60s).
  const maintenanceIntervalMs = Number(process.env.RELAY_MAINTENANCE_INTERVAL_MS) || 60_000;
  if (maintenanceIntervalMs > 0) {
    const maintenanceTimer = setInterval(() => {
      try {
        store.expireStale();
        store.expirePairingSessions();
        store.expireConnectInvitations();
        agentCredentialService.sweep();
        const pruned = store.pruneTerminal();
        if (pruned > 0) console.log(`relay maintenance: pruned ${pruned} terminal record(s)`);
      } catch (error) {
        console.error("relay maintenance sweep failed:", error?.message || error);
      }
    }, maintenanceIntervalMs);
    maintenanceTimer.unref();
  }

  const webhookIntervalMs = Number(process.env.WEBHOOK_DELIVERY_INTERVAL_MS) || 5_000;
  if (webhookIntervalMs > 0) {
    const webhookTimer = setInterval(scheduleWebhookDelivery, webhookIntervalMs);
    webhookTimer.unref();
    scheduleWebhookDelivery();
  }
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
  platformCore,
  merchantAccountService,
  merchantEmail,
  merchantSessionService,
  merchantService,
  merchantMembershipService,
  merchantDomainService,
  agentService,
  agentCredentialService,
  agentAuthService,
  recipientService,
  webhookEndpointService,
  webhookDeliveryService,
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

function optionalWebhookSecretVault(encodedKey) {
  try {
    return createAes256GcmVault(encodedKey, "velarumpay.webhook_secret.v1");
  } catch {
    return Object.freeze({
      encrypt() {
        throw Object.assign(new Error("Webhook secret encryption is unavailable"), {
          code: "webhook_secret_encryption_unavailable"
        });
      },
      decrypt() {
        throw Object.assign(new Error("Webhook secret encryption is unavailable"), {
          code: "webhook_secret_encryption_unavailable"
        });
      }
    });
  }
}
