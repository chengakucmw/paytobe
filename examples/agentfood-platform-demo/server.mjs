import fs from "node:fs/promises";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createVelarumArtifacts,
  extractConnectKey,
  merchants,
  recommendOrder
} from "./src/agent.mjs";
import { VelarumPayClient } from "../../packages/sdk-js/src/index.js";
import { createAgentCredentialSigner } from "../../services/agentfood/src/platform-client.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(directory, "public");
const platformBaseUrl = String(process.env.VELARUMPAY_API_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const port = Number(process.env.PORT || 8790);
const sessions = new Map();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw Object.assign(new Error("Request body is too large"), { status: 413 });
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 });
  }
}

async function claimConnectKey(connectKey, platformClient) {
  const claimed = requirePlatformSuccess(await platformClient.claimConnectInvitation(connectKey, platformClient.agentAuth.scopes));
  const sessionId = crypto.randomUUID();
  const state = {
    session_id: sessionId,
    connect_invitation_id: claimed.connect_invitation.connect_invitation_id,
    pairing_session_id: claimed.pairing_session.pairing_session_id,
    claim_token: claimed.claim_token,
    connection_id: null,
    connection_token: null,
    status: claimed.connect_invitation.status,
    created_at: new Date().toISOString()
  };
  sessions.set(sessionId, state);
  return {
    session_id: sessionId,
    connect_invitation: claimed.connect_invitation,
    pairing_session: claimed.pairing_session,
    warnings: claimed.warnings || []
  };
}

async function refreshConnection(state, platformClient) {
  const statusResult = requirePlatformSuccess(await platformClient.getConnectInvitation(state.connect_invitation_id, state.claim_token));
  state.status = statusResult.connect_invitation.status;
  if (["approved", "connected"].includes(state.status) && !state.connection_token) {
    const exchanged = requirePlatformSuccess(await platformClient.exchangeConnectInvitation(
      state.connect_invitation_id,
      state.claim_token,
      { setConnectionToken: false }
    ));
    state.status = exchanged.connect_invitation.status;
    state.connection_id = exchanged.connection.connection_id;
    state.connection_token = exchanged.connection.connection_token;
  }
  return {
    session_id: state.session_id,
    status: state.status,
    connect_invitation_id: state.connect_invitation_id,
    pairing_session_id: state.pairing_session_id,
    connection_id: state.connection_id,
    connected: Boolean(state.connection_token)
  };
}

async function createPaymentRequest(state, message, preferredMerchantId, req, platformClient) {
  if (!state.connection_token) throw Object.assign(new Error("Connect Invitation is not approved yet"), { status: 409, code: "connection_required" });
  const order = recommendOrder(message, preferredMerchantId);
  const origin = `http://${req.headers.host || `127.0.0.1:${port}`}`;
  const artifacts = createVelarumArtifacts(order, {
    connectionId: state.connection_id,
    demoBaseUrl: origin,
    recipientId: process.env.AGENTFOOD_RECIPIENT_ID || "agentfood-reference-recipient",
    recipientVersionId: process.env.AGENTFOOD_RECIPIENT_VERSION_ID || "agentfood-reference-recipient-v1"
  });
  const context = requirePlatformSuccess(await platformClient.createTransactionContext(artifacts.transactionContext, {
    connectionToken: state.connection_token
  }));
  const payment = requirePlatformSuccess(await platformClient.createPaymentRequest(artifacts.paymentRequest, {
    connectionToken: state.connection_token,
    idempotencyKey: artifacts.paymentRequest.idempotency_key
  }));
  return {
    type: "payment_request_created",
    message: `I prepared a ${order.total} XLM testnet demo order from ${order.merchant.name} and sent it to VelarumPay for review.`,
    order,
    transaction_context: context.context,
    payment_request: payment.payment_request,
    warnings: payment.warnings || []
  };
}

async function serveStatic(pathname, res) {
  const mapping = {
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/assets/agentfood-dishes-v2.jpg": ["assets/agentfood-dishes-v2.jpg", "image/jpeg"],
    "/assets/agentfood-social-v3.png": ["assets/agentfood-social-v3.png", "image/png"],
    "/fonts/Poppins-Regular.ttf": ["fonts/Poppins-Regular.ttf", "font/ttf"],
    "/fonts/Poppins-SemiBold.ttf": ["fonts/Poppins-SemiBold.ttf", "font/ttf"],
    "/fonts/Poppins-Bold.ttf": ["fonts/Poppins-Bold.ttf", "font/ttf"],
    "/fonts/DMSans-Variable.ttf": ["fonts/DMSans-Variable.ttf", "font/ttf"],
    "/fonts/JetBrainsMono-Variable.ttf": ["fonts/JetBrainsMono-Variable.ttf", "font/ttf"],
    "/fonts/OFL-Poppins.txt": ["fonts/OFL-Poppins.txt", "text/plain; charset=utf-8"],
    "/fonts/OFL-DM-Sans.txt": ["fonts/OFL-DM-Sans.txt", "text/plain; charset=utf-8"],
    "/fonts/OFL-JetBrains-Mono.txt": ["fonts/OFL-JetBrains-Mono.txt", "text/plain; charset=utf-8"]
  };
  const entry = mapping[pathname] || ["index.html", "text/html; charset=utf-8"];
  const body = await fs.readFile(path.join(publicDirectory, entry[0]));
  res.writeHead(200, {
    "content-type": entry[1],
    "content-length": body.length,
    "cache-control": pathname === "/" ? "no-store" : "public, max-age=300"
  });
  res.end(body);
}

export function createDemoServer(options = {}) {
  const platformClient = options.platformClient || defaultPlatformClient();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/catalog") {
        return sendJson(res, 200, { ok: true, demo: true, platform_api_url: platformBaseUrl, merchants });
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/connect/")) {
        const sessionId = decodeURIComponent(url.pathname.slice("/api/connect/".length));
        const state = sessions.get(sessionId);
        if (!state) return sendJson(res, 404, { ok: false, error: { code: "session_not_found", message: "Demo session not found" } });
        return sendJson(res, 200, { ok: true, connection: await refreshConnection(state, platformClient) });
      }
      if (req.method === "POST" && url.pathname === "/api/chat") {
        const body = await readJson(req);
        const message = String(body.message || "").trim();
        if (!message) return sendJson(res, 400, { ok: false, error: { code: "message_required", message: "A message is required" } });
        const connectKey = extractConnectKey(message);
        if (connectKey) {
          const claimed = await claimConnectKey(connectKey, platformClient);
          return sendJson(res, 201, {
            ok: true,
            type: "connect_invitation_claimed",
            message: "Connect Key recognized. Review the Agent identity and requested scopes in VelarumPay, then approve or reject the invitation.",
            ...claimed
          });
        }
        const state = sessions.get(String(body.session_id || ""));
        if (!state) return sendJson(res, 409, { ok: false, error: { code: "connection_required", message: "Send a fresh Connect Key before requesting an order" } });
        if (!state.connection_token) await refreshConnection(state, platformClient);
        const result = await createPaymentRequest(state, message, String(body.preferred_merchant_id || ""), req, platformClient);
        return sendJson(res, 201, { ok: true, ...result });
      }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/app.js" || url.pathname === "/styles.css" || url.pathname.startsWith("/assets/") || url.pathname.startsWith("/fonts/"))) {
        return serveStatic(url.pathname, res);
      }
      if (req.method === "GET" && url.pathname.startsWith("/merchants/")) {
        const merchantId = url.pathname.slice("/merchants/".length);
        if (!merchants.some((merchant) => merchant.id === merchantId)) {
          return sendJson(res, 404, { ok: false, error: { code: "merchant_not_found", message: "Demo merchant not found" } });
        }
        return serveStatic("/", res);
      }
      return sendJson(res, 404, { ok: false, error: { code: "not_found", message: "Route not found" } });
    } catch (error) {
      return sendJson(res, error.status || 500, {
        ok: false,
        error: {
          code: error.code || "demo_error",
          message: error.status && error.status < 500 ? error.message : "The demo could not complete this request",
          details: error.details || undefined
        }
      });
    }
  });
}

function defaultPlatformClient() {
  return new VelarumPayClient({
    baseUrl: platformBaseUrl,
    agentAuth: {
      agentId: process.env.AGENTFOOD_AGENT_ID || "agentfood-testnet",
      clientId: process.env.AGENTFOOD_AGENT_CLIENT_ID || "agentfood-reference-demo",
      kid: process.env.AGENTFOOD_AGENT_CREDENTIAL_KID || "agentfood-reference-key",
      audience: process.env.AGENTFOOD_AGENT_ASSERTION_AUDIENCE,
      scopes: [
        "payment.requests.create",
        "payment.requests.read",
        "transaction_contexts.create",
        "transaction_contexts.read"
      ],
      signer: createAgentCredentialSigner()
    }
  });
}

function requirePlatformSuccess(result) {
  if (result?.ok !== false) return result;
  throw Object.assign(new Error(result.error?.message || "Platform API rejected the request"), {
    status: result.status >= 400 && result.status < 500 ? result.status : 502,
    code: result.error?.code || "platform_api_error",
    details: result
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createDemoServer().listen(port, "127.0.0.1", () => {
    console.log(`AgentFood reference demo listening on http://127.0.0.1:${port}`);
    console.log(`Platform API: ${platformBaseUrl}`);
  });
}
