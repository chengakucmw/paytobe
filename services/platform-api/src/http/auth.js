// Authentication / authorization helpers for the HTTP routes.
//
// These need the store (token lookups), runtimeConfig (legacy OpenClaw policy)
// and observability (audit on failure), so they're produced by a factory wired
// once at startup. Call sites are unchanged: authorizeConnection(req, scope),
// verifyAppQuery(req), verifyAppBody(req), verifyOpenClaw(req), etc.

import { shouldAttemptLegacyOpenClaw, verifyOpenClawRequest } from "../security.js";

export function createAuth({ store, runtimeConfig, observability }) {
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
    return String(req.get("x-connection-token") || req.query.connection_token || req.body?.connection_token || "").trim();
  }

  function authorizeConnection(req, scope, options = {}) {
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
    const result = verifyOpenClawRequest(req, runtimeConfig);
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
    const deviceId = req.query.device_id;
    const token = req.query.token;
    if (!store.verifyDeviceToken(deviceId, token)) return { ok: false, status: 401, error: "Invalid app device token" };
    return { ok: true };
  }

  function verifyAppBody(req) {
    const deviceId = req.body.device_id;
    const token = req.body.token;
    if (!store.verifyDeviceToken(deviceId, token)) return { ok: false, status: 401, error: "Invalid app device token" };
    return { ok: true };
  }

  return {
    auditActorFromAuth,
    connectionTokenFromRequest,
    authorizeConnection,
    verifyOpenClaw,
    verifyAppQuery,
    verifyAppBody
  };
}
