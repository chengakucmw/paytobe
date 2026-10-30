import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { buildTestnetArtifacts } from "./artifacts.mjs";
import { buildMockOrder, publicCatalog, recommendMockOrder } from "./catalog.mjs";
import { assertConfig, configHealth, loadConfig } from "./config.mjs";
import { compareDecimal } from "./money.mjs";
import { verifyWebhookSignature } from "../../../packages/sdk-js/src/index.js";
import { createAgentCredentialSigner, PlatformClient } from "./platform-client.mjs";
import { AgentFoodStore } from "./store.mjs";

const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

export function createAgentFoodServer({ config, store, platformClient }) {
  const connectSessions = new Map();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true, service: "agentfood", runtime_env: config.runtimeEnv });
      }
      if (req.method === "GET" && url.pathname === "/ready") {
        const health = configHealth(config);
        return sendJson(res, health.ok ? 200 : 503, health);
      }
      if (req.method === "GET" && url.pathname === "/api/auth/session") {
        return sendJson(res, 200, { ok: true, authenticated: false });
      }
      if (req.method === "GET" && url.pathname === "/.well-known/Paytobe-domain-verification") {
        if (!config.domainVerificationChallenge) {
          return sendError(res, 404, "domain_challenge_unavailable", "Domain verification challenge is not configured");
        }
        return sendJson(res, 200, { challenge: config.domainVerificationChallenge });
      }
      if (req.method === "GET" && url.pathname === "/api/catalog") {
        const health = configHealth(config);
        return sendJson(res, 200, {
          ok: true,
          hosting_mode: config.siteOnly ? "production_site_only" : "production_connector",
          payment_ready: health.payment_ready,
          ...publicCatalog()
        });
      }
      if (req.method === "POST" && url.pathname === "/api/chat") {
        const body = await readJson(req);
        const message = String(body.message || "").trim();
        if (!message) return sendError(res, 400, "message_required", "A message is required");
        const connectKey = message.match(/^Paytobe-connect:ck_[A-Za-z0-9_-]{43}$/)?.[0];
        if (connectKey) {
          if (!platformClient || config.siteOnly || !configHealth(config).payment_ready) {
            return sendError(res, 503, "wallet_connection_unavailable", "Wallet connection is not available");
          }
          const session = await claimConnectSession(connectSessions, platformClient, connectKey);
          return sendJson(res, 201, {
            ok: true,
            type: "connect_started",
            session_id: session.session_id,
            connection: publicConnectSession(session),
            message: "Connect Key accepted once. Approve AgentFood in Paytobe to continue."
          });
        }
        const order = recommendMockOrder(message, String(body.preferred_merchant_id || ""));
        return sendJson(res, 200, {
          ok: true,
          type: "mock_recommendation",
          message: `I found a mock recommendation from ${order.merchant.name}. The menu and order are mock; after connecting, you can create a real 0.1 XLM Stellar testnet Payment Request.`,
          order
        });
      }
      const publicConnectMatch = url.pathname.match(/^\/api\/connect\/([^/]+)$/);
      if (req.method === "GET" && publicConnectMatch) {
        const session = connectSessions.get(decodeURIComponent(publicConnectMatch[1]));
        if (!session) return sendError(res, 404, "connect_session_not_found", "Connect session was not found");
        await refreshConnectSession(session, platformClient);
        return sendJson(res, 200, { ok: true, connection: publicConnectSession(session) });
      }
      if (req.method === "POST" && url.pathname === "/api/orders") {
        if (!platformClient || config.siteOnly || !configHealth(config).payment_ready) {
          return sendError(res, 503, "payment_connector_unavailable", "AgentFood payment connector is not available");
        }
        const body = await readJson(req);
        const connectSessionId = String(body.session_id || "").trim();
        const session = connectSessions.get(connectSessionId);
        if (!session) return sendError(res, 409, "connection_required", "Connect AgentFood to Paytobe first");
        await refreshConnectSession(session, platformClient);
        if (!session.connection_token) return sendError(res, 409, "connection_required", "Approve AgentFood in Paytobe first");
        const clientRequestId = String(body.client_request_id || "").trim();
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(clientRequestId)) {
          return sendError(res, 400, "client_request_id_required", "A safe client request identifier is required");
        }
        const idempotencyKey = `public:${crypto.createHash("sha256").update(`${connectSessionId}:${clientRequestId}`).digest("hex")}`;
        const existing = store.orderByIdempotency(idempotencyKey);
        if (existing) return sendJson(res, 200, { ok: true, duplicate: true, order: existing });
        const order = {
          ...buildMockOrder({ merchant_id: body.merchant_id, items: body.items }, config.stellar.paymentAmountXlm),
          connect_session_id: connectSessionId
        };
        const created = store.createOrder(order, idempotencyKey);
        return sendJson(res, 201, { ok: true, duplicate: created.duplicate, order: created.order });
      }
      const publicPaymentMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/payment-request$/);
      if (publicPaymentMatch && req.method === "POST") {
        const body = await readJson(req);
        const orderId = decodeURIComponent(publicPaymentMatch[1]);
        const order = store.order(orderId);
        if (!order) return sendError(res, 404, "order_not_found", "Mock order was not found");
        if (order.connect_session_id !== String(body.session_id || "")) {
          return sendError(res, 404, "order_not_found", "Mock order was not found");
        }
        const outcome = await createOrderPaymentRequest({ order, store, config, connectSessions, platformClient });
        return sendJson(res, outcome.status, outcome.payload);
      }
      if (publicPaymentMatch && req.method === "GET") {
        const orderId = decodeURIComponent(publicPaymentMatch[1]);
        const order = store.order(orderId);
        if (!order || order.connect_session_id !== String(url.searchParams.get("session_id") || "")) {
          return sendError(res, 404, "order_not_found", "Mock order was not found");
        }
        const outcome = await refreshOrderPaymentRequest({ order, store, connectSessions, platformClient });
        return sendJson(res, outcome.status, outcome.payload);
      }
      if (req.method === "GET" && isPublicPath(url.pathname)) {
        return serveStatic(url.pathname, req, res, config.publicBaseUrl);
      }
      if (req.method === "POST" && url.pathname === "/v1/webhooks/Paytobe") {
        const rawBody = await readBody(req);
        const signature = String(req.headers["x-Paytobe-signature"] || "");
        const verified = await verifyWebhookSignature(config.webhook.secret, rawBody, signature, {
          toleranceSeconds: config.webhook.toleranceSeconds
        });
        if (!verified.ok) return sendError(res, 401, verified.code, verified.message);
        const event = parseJson(rawBody);
        const eventId = String(event.event_id || "").trim();
        if (!/^event_[A-Za-z0-9_-]{3,128}$/.test(eventId)) {
          return sendError(res, 400, "invalid_webhook_event", "Webhook event_id is invalid");
        }
        const created = store.rememberWebhookEvent(eventId);
        return sendJson(res, 200, { ok: true, duplicate: !created, event_id: eventId });
      }
      if (!authorized(req, config.apiKey)) {
        return sendError(res, 401, "unauthorized", "A valid x-agentfood-api-key is required");
      }
      if (req.method === "GET" && url.pathname === "/v1/catalog") {
        return sendJson(res, 200, { ok: true, catalog: publicCatalog() });
      }
      if (req.method === "POST" && url.pathname === "/v1/connect") {
        if (!platformClient) return sendError(res, 503, "payment_connector_unavailable", "AgentFood payment connector is not configured");
        const body = await readJson(req);
        const connectKey = String(body.connect_key || "").trim();
        if (!/^Paytobe-connect:ck_[A-Za-z0-9_-]{43}$/.test(connectKey)) {
          return sendError(res, 400, "invalid_connect_key", "A canonical Paytobe Connect Key is required");
        }
        const session = await claimConnectSession(connectSessions, platformClient, connectKey);
        return sendJson(res, 201, {
          ok: true,
          connect_session: publicConnectSession(session),
          connect_invitation: session.connect_invitation,
          pairing_session: session.pairing_session,
          warnings: session.warnings
        });
      }

      const connectMatch = url.pathname.match(/^\/v1\/connect\/([^/]+)$/);
      if (req.method === "GET" && connectMatch) {
        const session = connectSessions.get(decodeURIComponent(connectMatch[1]));
        if (!session) return sendError(res, 404, "connect_session_not_found", "Connect session was not found");
        await refreshConnectSession(session, platformClient);
        return sendJson(res, 200, { ok: true, connect_session: publicConnectSession(session) });
      }
      if (req.method === "POST" && url.pathname === "/v1/orders") {
        const idempotencyKey = String(req.headers["x-idempotency-key"] || "").trim();
        if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
          return sendError(res, 400, "idempotency_key_required", "x-idempotency-key must contain 8 to 128 safe characters");
        }
        const existing = store.orderByIdempotency(idempotencyKey);
        if (existing) return sendJson(res, 200, { ok: true, duplicate: true, order: existing });
        const body = await readJson(req);
        const connectSessionId = String(body.connect_session_id || "").trim();
        if (!connectSessions.has(connectSessionId)) {
          return sendError(res, 409, "connection_required", "A claimed AgentFood Connect session is required");
        }
        const order = { ...buildMockOrder(body, config.stellar.paymentAmountXlm), connect_session_id: connectSessionId };
        const created = store.createOrder(order, idempotencyKey);
        return sendJson(res, 201, { ok: true, duplicate: created.duplicate, order: created.order });
      }

      const orderMatch = url.pathname.match(/^\/v1\/orders\/([^/]+)$/);
      if (req.method === "GET" && orderMatch) {
        const order = store.order(decodeURIComponent(orderMatch[1]));
        if (!order) return sendError(res, 404, "order_not_found", "Mock order was not found");
        return sendJson(res, 200, { ok: true, order });
      }

      const paymentMatch = url.pathname.match(/^\/v1\/orders\/([^/]+)\/payment-request$/);
      if (paymentMatch && req.method === "POST") {
        const orderId = decodeURIComponent(paymentMatch[1]);
        const order = store.order(orderId);
        if (!order) return sendError(res, 404, "order_not_found", "Mock order was not found");
        const outcome = await createOrderPaymentRequest({ order, store, config, connectSessions, platformClient });
        return sendJson(res, outcome.status, outcome.payload);
      }

      if (paymentMatch && req.method === "GET") {
        const orderId = decodeURIComponent(paymentMatch[1]);
        const order = store.order(orderId);
        if (!order) return sendError(res, 404, "order_not_found", "Mock order was not found");
        const outcome = await refreshOrderPaymentRequest({ order, store, connectSessions, platformClient });
        return sendJson(res, outcome.status, outcome.payload);
      }

      return sendError(res, 404, "not_found", "Route not found");
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendError(
        res,
        status,
        error.code || "agentfood_error",
        status < 500 ? error.message : "AgentFood could not complete the request",
        error.details
      );
    }
  });
}

async function claimConnectSession(connectSessions, platformClient, connectKey) {
  const claimed = await platformClient.claimConnectInvitation(connectKey);
  const session = {
    session_id: `afcs_${crypto.randomBytes(18).toString("base64url")}`,
    connect_invitation_id: claimed.connect_invitation.connect_invitation_id,
    pairing_session_id: claimed.pairing_session.pairing_session_id,
    claim_token: claimed.claim_token,
    connection_id: null,
    connection_token: null,
    status: claimed.connect_invitation.status,
    created_at: new Date().toISOString(),
    connect_invitation: claimed.connect_invitation,
    pairing_session: claimed.pairing_session,
    warnings: claimed.warnings || []
  };
  connectSessions.set(session.session_id, session);
  return session;
}

async function createOrderPaymentRequest({ order, store, config, connectSessions, platformClient }) {
  if (order.platform_payment_request) {
    return { status: 200, payload: { ok: true, duplicate: true, order, payment_request: order.platform_payment_request } };
  }
  if (!config.stellar.enabled) {
    return { status: 503, payload: errorPayload("stellar_testnet_disabled", "AgentFood Stellar testnet is disabled") };
  }
  if (compareDecimal(order.settlement.amount, config.stellar.maxXlm) > 0) {
    return { status: 409, payload: errorPayload("stellar_testnet_amount_exceeded", "Stored payment amount exceeds the active AgentFood testnet cap") };
  }
  const connectSession = connectSessions.get(order.connect_session_id);
  if (!connectSession) return { status: 409, payload: errorPayload("connection_required", "The order Connect session is unavailable") };
  await refreshConnectSession(connectSession, platformClient);
  if (!connectSession.connection_token) {
    return { status: 409, payload: errorPayload("connection_required", "Connect Invitation is awaiting wallet approval") };
  }
  const artifacts = buildTestnetArtifacts(order, config);
  const contextResult = await platformClient.createTransactionContext(artifacts.context, connectSession.connection_token);
  const paymentResult = await platformClient.createPaymentRequest(artifacts.paymentRequest, connectSession.connection_token);
  const paymentRequest = paymentResult.payment_request;
  const updated = store.updateOrder(order.order_id, {
    status: paymentRequest?.risk?.signing_allowed === false ? "payment_request_blocked" : "payment_request_created",
    platform_transaction_context: {
      transaction_id: contextResult.context.transaction_id,
      status: contextResult.context.status
    },
    platform_payment_request: paymentRequest
  });
  if (paymentRequest?.risk?.signing_allowed === false) {
    return {
      status: 409,
      payload: {
        ...errorPayload("platform_payment_blocked", "Paytobe created the request but blocked signing under its independent risk policy"),
        order: updated,
        payment_request: paymentRequest
      }
    };
  }
  return { status: 201, payload: { ok: true, duplicate: false, order: updated, payment_request: paymentRequest } };
}

async function refreshOrderPaymentRequest({ order, store, connectSessions, platformClient }) {
  const requestId = order.platform_payment_request?.request_id;
  if (!requestId) return { status: 404, payload: errorPayload("payment_request_not_found", "No Platform Payment Request exists for this mock order") };
  const connectSession = connectSessions.get(order.connect_session_id);
  if (!connectSession?.connection_token) return { status: 409, payload: errorPayload("connection_required", "The order Connect session is unavailable") };
  const result = await platformClient.paymentRequest(requestId, connectSession.connection_token);
  const updated = store.updateOrder(order.order_id, {
    status: `payment_${result.payment_request.status}`,
    platform_payment_request: result.payment_request
  });
  return { status: 200, payload: { ok: true, order: updated, payment_request: result.payment_request } };
}

function errorPayload(code, message) {
  return { ok: false, error: { code, message } };
}

function authorized(req, expected) {
  const provided = String(req.headers["x-agentfood-api-key"] || "");
  const left = Buffer.from(provided);
  const right = Buffer.from(String(expected || ""));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function readJson(req) {
  return parseJson(await readBody(req));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 64 * 1024) throw Object.assign(new Error("Request body is too large"), { status: 413, code: "payload_too_large" });
  }
  return Buffer.from(body, "utf8");
}

function parseJson(rawBody) {
  try { return rawBody.length ? JSON.parse(Buffer.from(rawBody).toString("utf8")) : {}; }
  catch { throw Object.assign(new Error("Request body must be valid JSON"), { status: 400, code: "invalid_json" }); }
}

async function refreshConnectSession(session, platformClient) {
  const result = await platformClient.getConnectInvitation(session.connect_invitation_id, session.claim_token);
  session.status = result.connect_invitation.status;
  if (["approved", "connected"].includes(session.status) && !session.connection_token) {
    const exchanged = await platformClient.exchangeConnectInvitation(session.connect_invitation_id, session.claim_token);
    session.status = exchanged.connect_invitation.status;
    session.connection_id = exchanged.connection.connection_id;
    session.connection_token = exchanged.connection.connection_token;
  }
  return session;
}

function publicConnectSession(session) {
  return {
    session_id: session.session_id,
    connect_invitation_id: session.connect_invitation_id,
    pairing_session_id: session.pairing_session_id,
    connection_id: session.connection_id,
    status: session.status,
    connected: Boolean(session.connection_token),
    created_at: session.created_at
  };
}

function sendError(res, status, code, message, details = undefined) {
  return sendJson(res, status, { ok: false, error: { code, message, ...(details ? { details } : {}) } });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer"
  });
  res.end(body);
}

function isPublicPath(pathname) {
  return pathname === "/"
    || pathname === "/.well-known/Paytobe-domain-verification"
    || pathname === "/app.js"
    || pathname === "/styles.css"
    || pathname.startsWith("/assets/")
    || pathname.startsWith("/fonts/")
    || pathname.startsWith("/merchants/");
}

async function serveStatic(pathname, req, res, publicBaseUrl) {
  const requested = pathname === "/" || pathname.startsWith("/merchants/") ? "index.html" : pathname.slice(1);
  const absolute = path.resolve(publicDirectory, requested);
  if (!absolute.startsWith(`${publicDirectory}${path.sep}`)) return sendError(res, 404, "not_found", "Route not found");
  let body;
  try {
    body = await fs.readFile(absolute);
  } catch (error) {
    if (error.code === "ENOENT") return sendError(res, 404, "not_found", "Asset not found");
    throw error;
  }
  const type = contentType(absolute);
  if (requested === "index.html") {
    const origin = configOrigin(req, publicBaseUrl);
    body = Buffer.from(body.toString("utf8").replaceAll("__SITE_ORIGIN__", origin));
  }
  res.writeHead(200, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": requested === "index.html" ? "no-store" : "public, max-age=300",
    "content-security-policy": "default-src 'self'; img-src 'self'; font-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer"
  });
  res.end(body);
}

function configOrigin(req, publicBaseUrl) {
  if (publicBaseUrl) return publicBaseUrl;
  return `https://${req.headers.host || "agentfood.Paytobe.com"}`;
}

function contentType(filename) {
  const extension = path.extname(filename).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8"
  })[extension] || "application/octet-stream";
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule && process.env.AGENTFOOD_NO_AUTO_LISTEN !== "1") {
  const config = loadConfig();
  assertConfig(config);
  const store = new AgentFoodStore(config.storePath);
  const platformClient = config.siteOnly ? null : new PlatformClient(config.platform, { signer: createAgentCredentialSigner() });
  const server = createAgentFoodServer({ config, store, platformClient });
  server.listen(config.port, "0.0.0.0", () => {
    console.log(JSON.stringify({ level: "info", event: "agentfood.started", port: config.port, runtime_env: config.runtimeEnv }));
  });
}
