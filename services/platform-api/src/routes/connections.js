// Connection management routes. Mounted at "/v1/connections".

import express from "express";
import { connectionPublicResponse, connectionResponse } from "../domain/projections.js";

export function createConnectionsRouter(deps) {
  const { store, observability, sendApiError, verifyAppQuery, verifyAppBody, notifyOpenClaw, platformCore } = deps;
  const router = express.Router();

  router.get("/", (req, res) => {
    const auth = verifyAppQuery(req);
    if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
    res.json({
      ok: true,
      items: store.listConnectionsForDevice(req.query.device_id).map(connectionPublicResponse)
    });
  });

  router.patch("/:id", (req, res) => {
    const auth = verifyAppBody(req);
    if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
    const connection = store.connection(req.params.id);
    if (!connection || connection.approved_by_device_id !== req.body.device_id) {
      return sendApiError(res, 404, "connection_not_found", "Connection not found");
    }
    const status = String(req.body.status || "").trim().toLowerCase();
    if (!["active", "paused"].includes(status)) {
      return sendApiError(res, 400, "invalid_connection_status", "Connection status must be active or paused", {
        field: "status"
      });
    }
    if (connection.status === "revoked") {
      return sendApiError(res, 409, "connection_revoked", "Revoked connections cannot be reactivated");
    }
    const updated = store.updateConnectionStatus(connection.connection_id, status);
    observability.recordAuditEvent("connection.status_updated", "success", {
      actor: { type: "wallet_device", id: req.body.device_id },
      resource: { type: "connection", id: updated.connection_id },
      labels: { status: updated.status },
      details: {
        agent_id: updated.agent_id,
        pairing_session_id: updated.pairing_session_id
      }
    });
    observability.incrementCounter("velarumpay_connection_status_updates_total", { status: updated.status });
    res.json({ ok: true, connection: connectionPublicResponse(updated) });
  });

  router.delete("/:id", (req, res) => {
    const body = req.body || {};
    const auth = verifyAppBody({ body });
    if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
    const connection = store.connection(req.params.id);
    if (!connection || connection.approved_by_device_id !== body.device_id) {
      return sendApiError(res, 404, "connection_not_found", "Connection not found");
    }
    const revokedAt = platformCore.clock.nowIso();
    const updated = store.updateConnectionStatus(connection.connection_id, "revoked", {
      revoked_at: revokedAt,
      revoked_by_device_id: body.device_id
    });
    notifyOpenClaw(updated.connection_id, {
      type: "connection.revoked",
      connection_id: updated.connection_id,
      status: updated.status,
      revoked_at: revokedAt
    });
    observability.recordAuditEvent("connection.revoked", "success", {
      actor: { type: "wallet_device", id: body.device_id },
      resource: { type: "connection", id: updated.connection_id },
      labels: { status: updated.status },
      details: {
        agent_id: updated.agent_id,
        pairing_session_id: updated.pairing_session_id
      }
    });
    observability.incrementCounter("velarumpay_connection_status_updates_total", { status: updated.status });
    res.json({ ok: true, connection: connectionPublicResponse(updated) });
  });

  router.post("/:id/rotate-token", (req, res) => {
    const auth = verifyAppBody(req);
    if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
    const connection = store.connection(req.params.id);
    if (!connection || connection.approved_by_device_id !== req.body.device_id) {
      return sendApiError(res, 404, "connection_not_found", "Connection not found");
    }
    if (connection.status === "revoked") {
      return sendApiError(res, 409, "connection_revoked", "Revoked connection tokens cannot be rotated");
    }
    const rotated = store.rotateConnectionToken(connection.connection_id, platformCore.random.opaqueToken("conn_tok", 32));
    notifyOpenClaw(connection.connection_id, {
      type: "connection.token_rotated",
      connection_id: connection.connection_id,
      status: connection.status
    });
    observability.recordAuditEvent("connection.token_rotated", "success", {
      actor: { type: "wallet_device", id: req.body.device_id },
      resource: { type: "connection", id: rotated.connection_id },
      labels: { status: rotated.status },
      details: {
        agent_id: rotated.agent_id,
        pairing_session_id: rotated.pairing_session_id
      }
    });
    res.json({ ok: true, connection: connectionResponse(rotated) });
  });

  return router;
}
