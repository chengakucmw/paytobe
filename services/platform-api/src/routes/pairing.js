// Pairing-session routes. Mounted at "/v1/pairing".

import express from "express";
import { connectIdentityReview } from "../application/connections/binding.js";
import { pairingSessionResponse, connectionPublicResponse, connectionResponse } from "../domain/projections.js";
import {
  normalizeAgentIdentity,
  normalizeApprovedScopes,
  normalizePairingTtl,
  normalizeRequestedScopes
} from "../domain/scopes.js";

const DEFAULT_CONNECTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createPairingRouter(deps) {
  const {
    store,
    observability,
    sendApiError,
    uniquePairingCode,
    resolvePairingSession,
    recordPairingExpired,
    verifyAppBody,
    platformCore
  } = deps;
  const router = express.Router();

  router.post("/sessions", (req, res) => {
    const body = req.body || {};
    const agent = normalizeAgentIdentity(body.agent_identity || body.agent || {});
    if (!agent.ok) {
      return sendApiError(res, 400, "invalid_agent_identity", agent.error, { field: agent.field });
    }

    const scopes = normalizeRequestedScopes(body.requested_scopes);
    if (!scopes.ok) {
      return sendApiError(res, 400, scopes.code, scopes.error, { field: "requested_scopes" });
    }

    const ttl = normalizePairingTtl(body.expires_in_seconds);
    if (!ttl.ok) {
      return sendApiError(res, 400, "invalid_expiration", ttl.error, { field: "expires_in_seconds" });
    }

    const pairingSessionId = platformCore.random.id("pair");
    let pairingCode;
    try {
      pairingCode = uniquePairingCode();
    } catch {
      // M4: every retry collided with a live session — fail loudly rather than
      // hand back a code we know is already in use.
      return sendApiError(res, 503, "pairing_code_unavailable", "Could not allocate a unique pairing code, please retry");
    }
    const expiresAt = platformCore.clock.after(ttl.seconds * 1000);
    const pairingUri = `Paytobe://pair?session=${encodeURIComponent(pairingSessionId)}&code=${encodeURIComponent(pairingCode)}`;
    const session = store.createPairingSession(pairingSessionId, pairingCode, {
      pairing_uri: pairingUri,
      agent_identity: agent.value,
      requested_scopes: scopes.value,
      expires_at: expiresAt
    });
    observability.recordAuditEvent("pairing_session.created", "success", {
      actor: { type: "agent", id: agent.value.agent_id, name: agent.value.agent_name },
      resource: { type: "pairing_session", id: session.pairing_session_id },
      labels: { status: session.status },
      details: {
        requested_scope_count: session.requested_scopes.length,
        expires_at: session.expires_at
      }
    });
    observability.incrementCounter("Paytobe_pairing_sessions_total", { result: "created" });

    res.status(201).json({
      ok: true,
      pairing_session: session,
      warnings: scopes.warnings
    });
  });

  router.get("/sessions/:id", (req, res) => {
    store.expirePairingSessions();
    const session = resolvePairingSession(req.params.id, { pairing_code: req.query.code });
    if (!session) return sendApiError(res, 404, "pairing_session_not_found", "Pairing session not found");
    res.json({
      ok: true,
      pairing_session: pairingSessionResponse(session)
    });
  });

  router.post("/sessions/:id/approve", (req, res) => {
    store.expireConnectInvitations();
    store.expirePairingSessions();
    const walletAuth = verifyAppBody(req);
    if (!walletAuth.ok) {
      return sendApiError(res, walletAuth.status, "invalid_app_device_token", walletAuth.error);
    }

    const session = resolvePairingSession(req.params.id, req.body || {});
    if (!session) return sendApiError(res, 404, "pairing_session_not_found", "Pairing session not found");
    if (session.target_app_device_id && session.target_app_device_id !== req.body.device_id) {
      return sendApiError(res, 403, "pairing_target_mismatch", "Pairing session belongs to another wallet device");
    }
    if (session.status !== "pending") {
      if (session.status === "expired") return sendApiError(res, 410, "pairing_session_expired", "Pairing session expired");
      return sendApiError(res, 409, "pairing_session_not_pending", "Pairing session is not pending", {
        details: { status: session.status }
      });
    }
    if (store.isPairingSessionExpired(session)) {
      store.updatePairingSession(session.pairing_session_id, { status: "expired" });
      recordPairingExpired(session, { actorDeviceId: req.body?.device_id });
      return sendApiError(res, 410, "pairing_session_expired", "Pairing session expired");
    }

    if (session.connect_invitation_id) {
      const review = connectIdentityReview(store, session);
      if (!review.approval_allowed) {
        return sendApiError(res, 409, "connect_identity_not_approvable", "Merchant or Agent identity cannot be approved", {
          details: { state: review.state, reason_code: review.reason_code }
        });
      }
    }

    const scopes = normalizeApprovedScopes(req.body?.approved_scopes, session.requested_scopes);
    if (!scopes.ok) {
      return sendApiError(res, scopes.status || 400, scopes.code, scopes.error, { field: "approved_scopes" });
    }

    const connection = store.createConnection(platformCore.random.id("conn"), platformCore.random.opaqueToken("conn_tok", 32), {
      pairing_session_id: session.pairing_session_id,
      agent_identity: session.agent_identity,
      auth_binding: session.auth_binding,
      scopes: scopes.value,
      approved_by_device_id: req.body.device_id,
      expires_at: platformCore.clock.after(DEFAULT_CONNECTION_TTL_MS)
    });
    store.updatePairingSession(session.pairing_session_id, {
      status: "approved",
      approved_at: platformCore.clock.nowIso(),
      approved_scopes: scopes.value,
      connection_id: connection.connection_id
    });
    if (session.connect_invitation_id) {
      store.updateConnectInvitation(session.connect_invitation_id, {
        status: "approved",
        approved_at: platformCore.clock.nowIso(),
        approved_scopes: scopes.value,
        connection_id: connection.connection_id
      });
    }
    observability.recordAuditEvent("pairing_session.approved", "success", {
      actor: { type: "wallet_device", id: req.body.device_id },
      resource: { type: "pairing_session", id: session.pairing_session_id },
      labels: { status: "approved" },
      details: {
        connection_id: connection.connection_id,
        agent_id: connection.agent_id,
        approved_scope_count: scopes.value.length,
        expires_at: connection.expires_at
      }
    });
    observability.incrementCounter("Paytobe_pairing_sessions_total", { result: "approved" });
    observability.incrementCounter("Paytobe_connections_total", { status: connection.status });

    res.status(201).json({
      ok: true,
      connection: session.connect_invitation_id
        ? connectionPublicResponse(connection)
        : connectionResponse(connection),
      pairing_session: store.pairingSession(session.pairing_session_id)
    });
  });

  router.post("/sessions/:id/reject", (req, res) => {
    store.expireConnectInvitations();
    store.expirePairingSessions();
    const walletAuth = verifyAppBody(req);
    if (!walletAuth.ok) {
      return sendApiError(res, walletAuth.status, "invalid_app_device_token", walletAuth.error);
    }

    const session = resolvePairingSession(req.params.id, req.body || {});
    if (!session) return sendApiError(res, 404, "pairing_session_not_found", "Pairing session not found");
    if (session.target_app_device_id && session.target_app_device_id !== req.body.device_id) {
      return sendApiError(res, 403, "pairing_target_mismatch", "Pairing session belongs to another wallet device");
    }
    if (session.status !== "pending") {
      if (session.status === "expired") return sendApiError(res, 410, "pairing_session_expired", "Pairing session expired");
      return sendApiError(res, 409, "pairing_session_not_pending", "Pairing session is not pending", {
        details: { status: session.status }
      });
    }
    if (store.isPairingSessionExpired(session)) {
      store.updatePairingSession(session.pairing_session_id, { status: "expired" });
      recordPairingExpired(session, { actorDeviceId: req.body?.device_id });
      return sendApiError(res, 410, "pairing_session_expired", "Pairing session expired");
    }

    const updated = store.updatePairingSession(session.pairing_session_id, {
      status: "rejected",
      rejected_at: platformCore.clock.nowIso(),
      rejected_by_device_id: req.body.device_id
    });
    if (session.connect_invitation_id) {
      store.updateConnectInvitation(session.connect_invitation_id, {
        status: "rejected",
        rejected_at: platformCore.clock.nowIso(),
        rejected_by_device_id: req.body.device_id
      });
    }
    observability.recordAuditEvent("pairing_session.rejected", "success", {
      actor: { type: "wallet_device", id: req.body.device_id },
      resource: { type: "pairing_session", id: updated.pairing_session_id },
      labels: { status: updated.status },
      details: {
        agent_id: updated.agent_identity?.agent_id || "",
        requested_scope_count: Array.isArray(updated.requested_scopes) ? updated.requested_scopes.length : 0
      }
    });
    observability.incrementCounter("Paytobe_pairing_sessions_total", { result: "rejected" });
    res.json({ ok: true, pairing_session: updated });
  });

  return router;
}
