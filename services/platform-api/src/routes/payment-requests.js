// Payment Request routes. Mounted at "/v1/payment-requests".
// NOTE: "/events" is declared before "/:id" so Express matches it first.

import express from "express";
import { resolveTargetDevice } from "../routing.js";
import { normalizePaymentRequestV1 } from "../velarum.js";
import { canTransition, evaluatePaymentRequest, shouldRecordSpent } from "../risk.js";
import { buildPaymentRequestPayload } from "../domain/payloads.js";
import {
  PAYMENT_REQUEST_STATUS_UPDATES,
  paymentRequestEventProjection,
  paymentRequestMetricLabels,
  paymentRequestProjection,
  paymentRequestStatusMessage,
  validatePaymentRequestStatusUpdate
} from "../domain/payment-request.js";

export function createPaymentRequestsRouter(deps) {
  const {
    store,
    observability,
    sendApiError,
    sendAuthFailure,
    authorizeConnection,
    verifyAppQuery,
    verifyAppBody,
    auditActorFromAuth,
    buildTransactionContextProjection,
    notifyApp,
    notifyOpenClaw
  } = deps;
  const router = express.Router();

  router.post("/", (req, res) => {
    const auth = authorizeConnection(req, "payment.requests.create", { allowLegacyOpenClaw: true });
    if (!auth.ok) return sendAuthFailure(res, auth);

    const body = req.body || {};
    const idempotencyKey = req.get("x-idempotency-key") || body.idempotency_key || "";
    if (idempotencyKey) {
      const existing = store.findPaymentRequestByIdempotency(idempotencyKey, auth.connection?.connection_id || body.connection_id || "");
      if (existing) {
        observability.recordAuditEvent("payment_request.idempotency_duplicate", "success", {
          actor: auditActorFromAuth(auth),
          resource: { type: "payment_request", id: existing.request_id },
          labels: paymentRequestMetricLabels(existing),
          details: {
            connection_id: existing.connection_id || null
          }
        });
        observability.incrementCounter("velarumpay_payment_request_duplicates_total", paymentRequestMetricLabels(existing));
        return res.status(200).json({ ok: true, duplicate: true, payment_request: paymentRequestProjection(existing) });
      }
    }

    const targetResolution = resolveTargetDevice(auth, body, { defaultDeviceId: process.env.DEFAULT_APP_DEVICE_ID });
    if (!targetResolution.ok) {
      return sendApiError(res, targetResolution.status, targetResolution.code, targetResolution.message);
    }
    const target = targetResolution.target;

    const payload = buildPaymentRequestPayload(body, auth.connection, idempotencyKey);
    const normalized = normalizePaymentRequestV1(payload);
    if (!normalized.ok) {
      return res.status(400).json({
        ok: false,
        error: normalized.error,
        errors: normalized.errors,
        warnings: normalized.warnings
      });
    }

    const context = buildTransactionContextProjection(normalized.value);
    // M-1: pass the store + env so daily-limit and whitelist gates are enforced
    // on this (main) path, not only on the legacy payment-intent path.
    const risk = evaluatePaymentRequest(normalized.value, context, store, process.env);
    const warnings = [...(normalized.warnings || []), ...context.warnings, ...risk.warnings];
    const request = store.putPaymentRequest({
      ...normalized.value,
      target_app_device_id: target,
      transaction_context_ref: context.ref,
      transaction_context_snapshot: context.snapshot || null,
      risk,
      warnings
    });
    if (auth.connection) store.touchConnection(auth.connection.connection_id);
    notifyApp(target, { type: "payment_request", request_id: request.request_id, status: request.status });
    observability.recordAuditEvent("payment_request.created", "success", {
      actor: auditActorFromAuth(auth),
      resource: { type: "payment_request", id: request.request_id },
      labels: paymentRequestMetricLabels(request),
      details: {
        connection_id: request.connection_id || null,
        transaction_id: request.transaction_id || null,
        target_app_device_id: target,
        warning_count: warnings.length,
        risk_error_count: Array.isArray(risk.errors) ? risk.errors.length : 0
      }
    });
    observability.incrementCounter("velarumpay_payment_requests_total", paymentRequestMetricLabels(request));
    res.status(201).json({
      ok: true,
      payment_request: paymentRequestProjection(request),
      warnings
    });
  });

  router.get("/", (req, res) => {
    store.expireStale();
    if (req.query.device_id || req.query.token) {
      const auth = verifyAppQuery(req);
      if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
      return res.json({
        ok: true,
        items: store.listPaymentRequestsForDevice(req.query.device_id).map(paymentRequestProjection)
      });
    }

    const auth = authorizeConnection(req, "payment.requests.read");
    if (!auth.ok) return sendAuthFailure(res, auth);
    store.touchConnection(auth.connection.connection_id);
    res.json({
      ok: true,
      items: store.listPaymentRequestsForConnection(auth.connection.connection_id).map(paymentRequestProjection)
    });
  });

  router.get("/events", (req, res) => {
    const auth = authorizeConnection(req, "payment.requests.read");
    if (!auth.ok) return sendAuthFailure(res, auth);
    const since = Number(req.query.since || 0);
    store.touchConnection(auth.connection.connection_id);
    res.json({
      ok: true,
      items: store
        .paymentRequestEventsForConnection(auth.connection.connection_id, Number.isFinite(since) ? since : 0)
        .map(paymentRequestEventProjection)
    });
  });

  router.get("/:id", (req, res) => {
    store.expireStale();
    const request = store.paymentRequest(req.params.id);
    if (req.query.device_id || req.query.token) {
      const auth = verifyAppQuery(req);
      if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
      if (!request || request.target_app_device_id !== req.query.device_id) {
        return sendApiError(res, 404, "payment_request_not_found", "Payment Request not found");
      }
      return res.json({ ok: true, payment_request: paymentRequestProjection(request) });
    }

    const auth = authorizeConnection(req, "payment.requests.read");
    if (!auth.ok) return sendAuthFailure(res, auth);
    if (!request) return sendApiError(res, 404, "payment_request_not_found", "Payment Request not found");
    if (request.connection_id !== auth.connection.connection_id) {
      return sendApiError(res, 403, "scope_denied", "Connection cannot read this Payment Request");
    }
    store.touchConnection(auth.connection.connection_id);
    res.json({ ok: true, payment_request: paymentRequestProjection(request) });
  });

  router.post("/:id/status", (req, res) => {
    const auth = verifyAppBody(req);
    if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);

    const request = store.paymentRequest(req.params.id);
    if (!request || request.target_app_device_id !== req.body.device_id) {
      return sendApiError(res, 404, "payment_request_not_found", "Payment Request not found");
    }

    const status = String(req.body.status || "");
    if (!PAYMENT_REQUEST_STATUS_UPDATES.has(status) || !canTransition(status)) {
      return sendApiError(res, 400, "invalid_status", "Payment Request status is not supported", {
        field: "status",
        details: {
          status,
          allowed_statuses: Array.from(PAYMENT_REQUEST_STATUS_UPDATES)
        }
      });
    }

    const transition = validatePaymentRequestStatusUpdate(request, status);
    if (!transition.ok) {
      return sendApiError(res, transition.status, transition.code, transition.message, {
        details: transition.details
      });
    }

    const updated = store.updatePaymentRequestStatus(request.request_id, status, {
      tx_hash: req.body.tx_hash || null,
      error: req.body.error || null
    });
    if (shouldRecordSpent(status)) store.addDailySpent(updated.payment.asset, updated.payment.amount);

    const message = paymentRequestStatusMessage(updated, {
      tx_hash: req.body.tx_hash || null,
      error: req.body.error || null
    });
    notifyOpenClaw(updated.connection_id || updated.source?.device_id, message);
    notifyApp(updated.target_app_device_id, {
      type: "payment_request",
      request_id: updated.request_id,
      status: updated.status
    });
    observability.recordAuditEvent("payment_request.status_updated", "success", {
      actor: { type: "wallet_device", id: req.body.device_id },
      resource: { type: "payment_request", id: updated.request_id },
      labels: paymentRequestMetricLabels(updated),
      details: {
        connection_id: updated.connection_id || null,
        transaction_id: updated.transaction_id || null,
        tx_hash: req.body.tx_hash || null,
        has_error: Boolean(req.body.error)
      }
    });
    observability.incrementCounter("velarumpay_payment_request_status_updates_total", paymentRequestMetricLabels(updated));

    res.json({ ok: true, payment_request: paymentRequestProjection(updated) });
  });

  return router;
}
