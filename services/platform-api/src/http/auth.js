// Authentication / authorization helpers for the HTTP routes.
//
// These need the store (token lookups), runtimeConfig (legacy OpenClaw policy)
// and observability (audit on failure), so they're produced by a factory wired
// once at startup. Call sites are unchanged: authorizeConnection(req, scope),
// verifyAppQuery(req), verifyAppBody(req), verifyOpenClaw(req), etc.

import { shouldAttemptLegacyOpenClaw, verifyOpenClawRequest } from "../security.js";
import {
  CONNECTION_TOKEN_AUDIENCE,
  rejoinConnectionState,
  validateConnectionBinding
} from "../application/connections/binding.js";

export function createAuth({ store, runtimeConfig, observability, replayGuard, merchantSessionService, agentAuthService }) {
  function auditActorFromAuth(auth) {
    if (auth?.connection) {
      return {
        type: "connection",
        id: auth.connection.connection_id,
        agent_id: auth.connection.agent_id || auth.connection.agent_identity?.agent_id || ""
      };
    }
    if (auth?.legacy) return { type: "legacy_openclaw" };
    return { type: "unknown" };
  }

  function connectionTokenFromRequest(req) {
    const authorization = req.get("authorization") || "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
    return String(req.get("x-connection-token") || "").trim();
  }

  function authorizeConnection(req, scope, options = {}) {
    if (req.query?.connection_token || req.body?.connection_token) {
      return { ok: false, status: 400, code: "token_transport_forbidden", message: "Connection tokens are accepted only in authorization headers" };
    }
    const token = connectionTokenFromRequest(req);
    if (!token) {
      if (options.allowLegacyOpenClaw && shouldAttemptLegacyOpenClaw(req, runtimeConfig)) {
        const legacy = verifyOpenClaw(req);
        if (legacy.ok) return { ok: true, legacy: true };
        return {
          ok: false,
          status: legacy.status,
          code: legacy.status === 401 ? "unauthorized_connection" : legacy.code || "legacy_auth_failed",
          message: legacy.error
        };
      }
      return {
        ok: false,
        status: 401,
        code: "unauthorized_connection",
        message: "Connection token is required"
      };
    }

    const connection = store.connectionByToken(token);
    if (!connection) {
      return { ok: false, status: 401, code: "unauthorized_connection", message: "Connection token is invalid" };
    }
    if (connection.status !== "active") {
      return { ok: false, status: 401, code: "unauthorized_connection", message: "Connection is not active" };
    }
    if (connection.expires_at && Date.parse(connection.expires_at) <= Date.now()) {
      return { ok: false, status: 401, code: "unauthorized_connection", message: "Connection token expired" };
    }

    const supplied = {
      merchant_id: req.body?.merchant_id || req.query?.merchant_id,
      agent_id: req.body?.agent_id || req.query?.agent_id,
      client_id: req.body?.client_id || req.query?.client_id,
      credential_id: req.body?.credential_id || req.query?.credential_id,
      approved_by_device_id: req.body?.target_app_device_id || req.body?.device_id || req.query?.device_id,
      connection_id: req.body?.connection_id || req.query?.connection_id
    };
    const binding = validateConnectionBinding(connection, {
      audience: options.audience || CONNECTION_TOKEN_AUDIENCE,
      supplied
    });
    if (!binding.ok) return binding;
    const current = rejoinConnectionState(store, connection);
    if (!current.ok) return current;

    const requestedConnectionId = req.body?.connection_id || req.query?.connection_id;
    if (requestedConnectionId && requestedConnectionId !== connection.connection_id) {
      return { ok: false, status: 401, code: "unauthorized_connection", message: "Connection token does not match connection_id" };
    }

    if (!connection.scopes.includes(scope)) {
      return { ok: false, status: 403, code: "scope_denied", message: `Missing required scope: ${scope}` };
    }
    return { ok: true, connection };
  }

  function verifyOpenClaw(req) {
    const result = verifyOpenClawRequest(req, runtimeConfig, { replayGuard });
    if (!result.ok) {
      observability.recordAuditEvent("legacy_openclaw.auth_failed", "failure", {
        actor: { type: "legacy_openclaw" },
        resource: { type: "http_route", id: req.path || req.url || "" },
        labels: { code: result.code || "openclaw_unauthorized" }
      });
    }
    return result;
  }

  function verifyAppQuery(req) {
    const deviceId = req.get?.("x-app-device-id") || req.query.device_id;
    const token = req.get?.("x-app-device-token") || req.query.token;
    if (!store.verifyDeviceToken(deviceId, token)) return { ok: false, status: 401, error: "Invalid app device token" };
    return { ok: true, device_id: deviceId };
  }

  function verifyAppBody(req) {
    const deviceId = req.body.device_id;
    const token = req.body.token;
    if (!store.verifyDeviceToken(deviceId, token)) return { ok: false, status: 401, error: "Invalid app device token" };
    return { ok: true };
  }

  function verifyMerchantSession(req, options = {}) {
    if (!merchantSessionService) return { ok: false, status: 503, code: "merchant_session_unavailable", message: "Merchant sessions are unavailable" };
    return merchantSessionService.authenticate({
      session_token: cookie(req, "vp_merchant_session"),
      csrf_token: String(req.get?.("x-csrf-token") || ""),
      origin: String(req.get?.("origin") || ""),
      require_csrf: Boolean(options.csrf)
    });
  }

  function requireMerchantStepUp(req, operation) {
    const auth = verifyMerchantSession(req, { csrf: true });
    if (!auth.ok) return auth;
    if (!merchantSessionService.isStepUpFresh(auth.session)) {
      return { ok: false, status: 403, code: "step_up_required", message: `Recent step-up authentication is required for ${operation}` };
    }
    return auth;
  }

  function verifyAgentAccessToken(req, requiredScopes = []) {
    if (!agentAuthService) return { ok: false, status: 503, code: "unauthenticated", message: "Agent authentication is unavailable" };
    const authorization = String(req.get?.("authorization") || "");
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    return agentAuthService.authenticate(match?.[1] || "", String(req.request_id || req.id || "unknown"), requiredScopes);
  }

  return {
    auditActorFromAuth,
    connectionTokenFromRequest,
    authorizeConnection,
    verifyOpenClaw,
    verifyAppQuery,
    verifyAppBody,
    verifyMerchantSession,
    requireMerchantStepUp,
    verifyAgentAccessToken
  };
}

function cookie(req, name) {
  const header = String(req.get?.("cookie") || "");
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}
