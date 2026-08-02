import crypto from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { buildMainnetArtifacts } from "./artifacts.mjs";
import { buildMockOrder, publicCatalog } from "./catalog.mjs";
import { assertConfig, configHealth, loadConfig } from "./config.mjs";
import { compareDecimal } from "./money.mjs";
import { verifyWebhookSignature } from "../../../packages/sdk-js/src/index.js";
import { createAgentCredentialSigner, PlatformClient } from "./platform-client.mjs";
import { AgentFoodStore } from "./store.mjs";

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
      if (req.method === "POST" && url.pathname === "/v1/webhooks/velarumpay") {
        const rawBody = await readBody(req);
        const signature = String(req.headers["x-velarumpay-signature"] || "");
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
        const body = await readJson(req);
        const connectKey = String(body.connect_key || "").trim();
        if (!/^velarumpay-connect:ck_[A-Za-z0-9_-]{43}$/.test(connectKey)) {
          return sendError(res, 400, "invalid_connect_key", "A canonical VelarumPay Connect Key is required");
        }
        const claimed = await platformClient.claimConnectInvitation(connectKey);
        const sessionId = `afcs_${crypto.randomBytes(18).toString("base64url")}`;
        const session = {
          session_id: sessionId,
          connect_invitation_id: claimed.connect_invitation.connect_invitation_id,
          pairing_session_id: claimed.pairing_session.pairing_session_id,
          claim_token: claimed.claim_token,
          connection_id: null,
          connection_token: null,
          status: claimed.connect_invitation.status,
          created_at: new Date().toISOString()
        };
        connectSessions.set(sessionId, session);
        return sendJson(res, 201, {
          ok: true,
          connect_session: publicConnectSession(session),
          connect_invitation: claimed.connect_invitation,
          pairing_session: claimed.pairing_session,
          warnings: claimed.warnings || []
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
        if (order.platform_payment_request) {
          return sendJson(res, 200, { ok: true, duplicate: true, order, payment_request: order.platform_payment_request });
        }
        if (!config.stellar.enabled) return sendError(res, 503, "stellar_mainnet_disabled", "AgentFood Stellar mainnet is disabled");
        if (compareDecimal(order.settlement.amount, config.stellar.maxXlm) > 0) {
          return sendError(res, 409, "stellar_mainnet_amount_exceeded", "Stored payment amount exceeds the active AgentFood mainnet cap");
        }

        const connectSession = connectSessions.get(order.connect_session_id);
        if (!connectSession) return sendError(res, 409, "connection_required", "The order Connect session is unavailable");
        await refreshConnectSession(connectSession, platformClient);
        if (!connectSession.connection_token) {
          return sendError(res, 409, "connection_required", "Connect Invitation is awaiting wallet approval");
        }

        const artifacts = buildMainnetArtifacts(order, config);
        const contextResult = await platformClient.createTransactionContext(artifacts.context, connectSession.connection_token);
        const paymentResult = await platformClient.createPaymentRequest(artifacts.paymentRequest, connectSession.connection_token);
        const paymentRequest = paymentResult.payment_request;
        const updated = store.updateOrder(orderId, {
          status: paymentRequest?.risk?.signing_allowed === false ? "payment_request_blocked" : "payment_request_created",
          platform_transaction_context: {
            transaction_id: contextResult.context.transaction_id,
            status: contextResult.context.status
          },
          platform_payment_request: paymentRequest
        });
        if (paymentRequest?.risk?.signing_allowed === false) {
          return sendJson(res, 409, {
            ok: false,
            error: {
              code: "platform_payment_blocked",
              message: "VelarumPay created the request but blocked signing under its independent risk policy"
            },
            order: updated,
            payment_request: paymentRequest
          });
        }
        return sendJson(res, 201, { ok: true, duplicate: false, order: updated, payment_request: paymentRequest });
      }

      if (paymentMatch && req.method === "GET") {
        const orderId = decodeURIComponent(paymentMatch[1]);
        const order = store.order(orderId);
        if (!order) return sendError(res, 404, "order_not_found", "Mock order was not found");
        const requestId = order.platform_payment_request?.request_id;
        if (!requestId) return sendError(res, 404, "payment_request_not_found", "No Platform Payment Request exists for this mock order");
        const connectSession = connectSessions.get(order.connect_session_id);
        if (!connectSession?.connection_token) return sendError(res, 409, "connection_required", "The order Connect session is unavailable");
        const result = await platformClient.paymentRequest(requestId, connectSession.connection_token);
        const updated = store.updateOrder(orderId, {
          status: `payment_${result.payment_request.status}`,
          platform_payment_request: result.payment_request
        });
        return sendJson(res, 200, { ok: true, order: updated, payment_request: result.payment_request });
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

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule && process.env.AGENTFOOD_NO_AUTO_LISTEN !== "1") {
  const config = loadConfig();
  assertConfig(config);
  const store = new AgentFoodStore(config.storePath);
  const platformClient = new PlatformClient(config.platform, { signer: createAgentCredentialSigner() });
  const server = createAgentFoodServer({ config, store, platformClient });
  server.listen(config.port, "0.0.0.0", () => {
    console.log(JSON.stringify({ level: "info", event: "agentfood.started", port: config.port, runtime_env: config.runtimeEnv }));
  });
}
