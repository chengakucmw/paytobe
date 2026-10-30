// Transaction Context routes. Mounted at "/v1/transaction-contexts".

import express from "express";
import { normalizeTransactionContextV1 } from "../Paytobe.js";
import { buildTransactionContextPayload } from "../domain/payloads.js";

export function createTransactionContextsRouter(deps) {
  const { store, observability, sendApiError, sendAuthFailure, authorizeConnection, verifyAppQuery, auditActorFromAuth } = deps;
  const router = express.Router();

  router.post("/", (req, res) => {
    const auth = authorizeConnection(req, "transaction_contexts.create", { allowLegacyOpenClaw: true });
    if (!auth.ok) return sendAuthFailure(res, auth);

    const normalized = normalizeTransactionContextV1(buildTransactionContextPayload(req.body || {}, auth.connection));
    if (!normalized.ok) {
      return res.status(400).json({
        ok: false,
        error: normalized.error,
        errors: normalized.errors
      });
    }

    const context = store.putTransactionContext(normalized.value);
    if (auth.connection) store.touchConnection(auth.connection.connection_id);
    observability.recordAuditEvent("transaction_context.upserted", "success", {
      actor: auditActorFromAuth(auth),
      resource: { type: "transaction_context", id: context.transaction_id },
      labels: { status: context.status || "unknown" },
      details: {
        connection_id: context.connection_id || null,
        evidence_count: Array.isArray(context.evidence) ? context.evidence.length : 0
      }
    });
    res.status(201).json({
      ok: true,
      context,
      warnings: normalized.warnings
    });
  });

  router.get("/:transaction_id", (req, res) => {
    const context = store.transactionContext(req.params.transaction_id);
    if (!context) return res.status(404).json({ ok: false, error: "Transaction Context not found" });

    if (req.query.device_id || req.query.token) {
      const walletAuth = verifyAppQuery(req);
      if (!walletAuth.ok) return res.status(walletAuth.status).json({ ok: false, error: walletAuth.error });
      // A valid device token only proves which device is calling, not that the
      // device is entitled to THIS context. Bind the read to the device that
      // approved the context's connection so an arbitrary device cannot read
      // another wallet's Transaction Context (bug H6).
      if (!store.deviceCanReadTransactionContext(req.query.device_id, context)) {
        return sendApiError(res, 403, "scope_denied", "This device cannot read this Transaction Context");
      }
      return res.json({ ok: true, context });
    }

    const auth = authorizeConnection(req, "transaction_contexts.read", { allowLegacyOpenClaw: true });
    if (!auth.ok) return sendAuthFailure(res, auth);
    if (auth.connection && context.connection_id !== auth.connection.connection_id) {
      return sendApiError(res, 403, "scope_denied", "Connection cannot read this Transaction Context");
    }
    if (auth.connection) store.touchConnection(auth.connection.connection_id);
    res.json({ ok: true, context });
  });

  return router;
}
