// Payment Request routes. Mounted at "/v1/payment-requests".
// NOTE: "/events" is declared before "/:id" so Express matches it first.

import express from "express";
import { resolveTargetDevice } from "../routing.js";
import { normalizePaymentRequestV1 } from "../Paytobe.js";
import { canTransition, dailyLimitFor, evaluatePaymentRequest, shouldRecordSpent } from "../risk.js";
import { buildPaymentRequestPayload } from "../domain/payloads.js";
import { bindRecipientPaymentRequest } from "../application/payment-requests/recipient-binding.js";
import { createTenantScope } from "../ports/tenant-repository.js";
import {
  canonicalPaymentRequestHash,
  decidePaymentStatusTransition,
  PAYMENT_REQUEST_ROUTE,
  StorePaymentTenantRepository
} from "../application/payment-requests/tenant-state.js";
import { paymentTenantEventProjection } from "../domain/projections.js";
import { paymentStatusWebhookEvent } from "../application/webhooks/outbox.js";
import {
  PAYMENT_REQUEST_STATUS_UPDATES,
  paymentRequestEventProjection,
  paymentRequestMetricLabels,
  paymentRequestProjection,
  paymentRequestStatusMessage,
  validatePaymentRequestStatusUpdate
} from "../domain/payment-request.js";

// F1: terminal non-confirmed statuses that must RELEASE a held daily-cap reservation.
const RELEASE_ON_STATUS = new Set(["failed", "expired", "rejected"]);
const RECOVERABLE_CONFIRMATION_ERROR = "Missing Stellar Horizon URL for confirmation";

function riskHasCode(risk, code) {
  return Array.isArray(risk?.errors) && risk.errors.some((item) => item?.code === code);
}

// Flip an otherwise-allowed risk result to a daily-cap block. Used when the atomic
// reservation loses a race the read-only cap check did not see (a concurrent request
// took the last of the headroom first).
function blockRiskOnDailyLimit(risk, asset, amount, limit) {
  const blocker = {
    code: "daily_limit_exceeded",
    message: `Daily ${asset} limit exceeded.`,
    severity: "blocker",
    field: "payment.amount",
    details: { asset, amount: amount ?? null, limit }
  };
  return {
    ...risk,
    ok: false,
    level: "danger",
    review_status: "blocked",
    signing_allowed: false,
    errors: [...(risk?.errors || []), blocker]
  };
}

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
    notifyOpenClaw,
    pushService,
    platformCore,
    recipientService,
    webhookOutbox,
    webhookDeliveryService,
    confirmPaymentRequestLater,
    scheduleWebhookDelivery
  } = deps;
  const router = express.Router();
  const tenantRepository = new StorePaymentTenantRepository(store);
  const pendingConfirmations = new Set();

  function applyStatusUpdate(request, status, patch, actor) {
    const scope = request.merchant_id ? createTenantScope(Object.freeze({
      merchant_id: request.merchant_id,
      actor_id: actor.id,
      request_id: actor.request_id
    })) : null;
    let updated;
    if (scope && webhookOutbox) {
      const occurredAt = platformCore.clock.nowIso();
      const event = paymentStatusWebhookEvent(scope, request, status, patch, {
        eventId: platformCore.random.id("event"),
        occurredAt
      });
      const committed = webhookOutbox.commitPaymentStatus(scope, request.request_id, status, patch, event);
      if (!committed) return null;
      // The outbox transaction is authoritative for the status + immutable webhook
      // event. Refresh the Store cache, then append the wallet REST event in a
      // separate durable mutation so app synchronization observes the transition.
      store.reloadSqliteState();
      store.mutate(() => {
        store.event("payment_request.status", request.request_id, {
          request_id: request.request_id,
          transaction_id: request.transaction_id || null,
          connection_id: request.connection_id || null,
          target_app_device_id: request.target_app_device_id || null,
          status,
          tx_hash: patch.tx_hash || null,
          error: patch.error || null
        });
        return true;
      });
      updated = store.paymentRequest(request.request_id);
      const deliveries = webhookDeliveryService?.enqueue(scope, event.event_id) || [];
      if (deliveries.length > 0) scheduleWebhookDelivery?.();
    } else {
      updated = scope
        ? tenantRepository.updateStatus(scope, request.request_id, status, patch)
        : store.updatePaymentRequestStatus(request.request_id, status, patch);
    }
    if (!updated) return null;

    if (shouldRecordSpent(status)) {
      store.settleDailyReservation(request.request_id, updated.payment.asset, updated.payment.amount);
    } else if (RELEASE_ON_STATUS.has(status)) {
      store.releaseDailyReservation(request.request_id);
    }

    const message = paymentRequestStatusMessage(updated, patch);
    notifyOpenClaw(updated.connection_id || updated.source?.device_id, message);
    const eventSeq = store.eventWindow().latest_seq;
    notifyApp(updated.target_app_device_id, {
      type: "payment_request",
      request_id: updated.request_id,
      status: updated.status,
      event_seq: eventSeq
    });
    pushService?.notifyPaymentRequest(updated.target_app_device_id, {
      request_id: updated.request_id,
      event_seq: eventSeq
    });
    observability.recordAuditEvent("payment_request.status_updated", "success", {
      actor: actor.audit,
      resource: { type: "payment_request", id: updated.request_id },
      labels: paymentRequestMetricLabels(updated),
      details: {
        connection_id: updated.connection_id || null,
        transaction_id: updated.transaction_id || null,
        tx_hash: patch.tx_hash || null,
        has_error: Boolean(patch.error)
      }
    });
    observability.incrementCounter("Paytobe_payment_request_status_updates_total", paymentRequestMetricLabels(updated));
    return updated;
  }

  function scheduleConfirmation(request) {
    const txHash = request?.tx_hash;
    const recoverableFailure = request?.status === "failed" && request.error === RECOVERABLE_CONFIRMATION_ERROR;
    if ((request?.status !== "broadcasted" && !recoverableFailure) || !txHash || !confirmPaymentRequestLater) return null;
    const key = `${request.request_id}:${txHash}`;
    if (pendingConfirmations.has(key)) return null;
    pendingConfirmations.add(key);
    return confirmPaymentRequestLater(request, txHash, (nextStatus, confirmationPatch) => {
      const current = store.paymentRequest(request.request_id);
      if (!current) return null;
      const recovering = current.status === "failed" && current.error === RECOVERABLE_CONFIRMATION_ERROR;
      if (recovering) {
        if (nextStatus !== "confirmed") return current;
        return applyStatusUpdate(current, nextStatus, confirmationPatch, {
          id: "platform:confirmation_recovery",
          request_id: platformCore.random.id("request"),
          audit: { type: "platform_worker", id: "chain_confirmation_recovery" }
        });
      }
      const next = decidePaymentStatusTransition(current, nextStatus, platformCore.clock.now().getTime());
      if (!next.ok || next.duplicate) return current;
      return applyStatusUpdate(current, nextStatus, confirmationPatch, {
        id: "platform:confirmation",
        request_id: platformCore.random.id("request"),
        audit: { type: "platform_worker", id: "chain_confirmation" }
      });
    }).catch((error) => {
      observability.recordAuditEvent("payment_request.confirmation_update_failed", "failure", {
        actor: { type: "platform_worker", id: "chain_confirmation" },
        resource: { type: "payment_request", id: request.request_id },
        labels: { code: error?.code || "confirmation_update_failed" }
      });
      return null;
    }).finally(() => {
      pendingConfirmations.delete(key);
    });
  }

  async function reconcilePendingConfirmations() {
    const confirmations = Object.values(store.state.paymentRequests)
      .filter((request) => request.tx_hash && (
        request.status === "broadcasted"
        || (request.status === "failed" && request.error === RECOVERABLE_CONFIRMATION_ERROR)
      ))
      .map(scheduleConfirmation)
      .filter(Boolean);
    return Promise.allSettled(confirmations);
  }

  router.post("/", async (req, res) => {
    const auth = authorizeConnection(req, "payment.requests.create", { allowLegacyOpenClaw: true });
    if (!auth.ok) return sendAuthFailure(res, auth);

    const body = req.body || {};
    const idempotencyKey = req.get("x-idempotency-key") || body.idempotency_key || "";
    if (idempotencyKey && auth.connection?.binding_version !== "Paytobe.connection_binding.v1") {
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
        observability.incrementCounter("Paytobe_payment_request_duplicates_total", paymentRequestMetricLabels(existing));
        return res.status(200).json({ ok: true, duplicate: true, payment_request: paymentRequestProjection(existing) });
      }
    }

    const targetResolution = resolveTargetDevice(auth, body, { defaultDeviceId: process.env.DEFAULT_APP_DEVICE_ID });
    if (!targetResolution.ok) {
      return sendApiError(res, targetResolution.status, targetResolution.code, targetResolution.message);
    }
    const target = targetResolution.target;

    let acceptedBody = body;
    let recipientBinding = null;
    let tenantScope = null;
    let idempotencyRequestHash = "";
    if (auth.connection?.binding_version === "Paytobe.connection_binding.v1") {
      const scope = createTenantScope(Object.freeze({
        merchant_id: auth.connection.merchant_id,
        actor_id: auth.connection.agent_id,
        request_id: String(req.request_id || req.id || platformCore.random.id("request"))
      }));
      recipientBinding = await bindRecipientPaymentRequest({ recipientService, scope, input: body });
      if (!recipientBinding.ok) {
        return sendApiError(res, recipientBinding.status, recipientBinding.code, recipientBinding.message, {
          details: recipientBinding.details
        });
      }
      acceptedBody = recipientBinding.value;
      tenantScope = scope;
      idempotencyRequestHash = canonicalPaymentRequestHash(acceptedBody);
      if (idempotencyKey) {
        const existing = tenantRepository.findIdempotency(scope, PAYMENT_REQUEST_ROUTE, idempotencyKey);
        if (existing) {
          if (existing.idempotency_request_hash !== idempotencyRequestHash) {
            return sendApiError(res, 409, "idempotency_conflict", "Idempotency key was already used with a different canonical Payment Request");
          }
          observability.recordAuditEvent("payment_request.idempotency_duplicate", "success", {
            actor: auditActorFromAuth(auth),
            resource: { type: "payment_request", id: existing.request_id },
            labels: paymentRequestMetricLabels(existing),
            details: { merchant_id: scope.merchant_id, actor_id: scope.actor_id, route: PAYMENT_REQUEST_ROUTE }
          });
          return res.status(200).json({ ok: true, duplicate: true, payment_request: paymentRequestProjection(existing) });
        }
      }
    }

    const payload = buildPaymentRequestPayload(acceptedBody, auth.connection, idempotencyKey, platformCore);
    // Use the injected platform clock for both payload creation and validation.
    // Mixing the controlled clock with Date.now() makes otherwise valid requests
    // become expired when deterministic tests or migrations replay older fixtures.
    const normalized = normalizePaymentRequestV1(payload, { now: platformCore.clock.now() });
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
    let risk = evaluatePaymentRequest(normalized.value, context, store, process.env);
    // F1: for an otherwise-allowed request, hold an ATOMIC reservation against the
    // daily cap so concurrent creations can't all pass the read-only check and then
    // all confirm. If the reservation loses a race, flip this request to blocked.
    // Settled on confirm, released on failed/expired/rejected (status route +
    // expireStale). An already-blocked request reserves nothing.
    if (store && risk.ok && !riskHasCode(risk, "daily_limit_exceeded")) {
      const reserveAsset = String(normalized.value.payment?.asset || "").toUpperCase();
      if (reserveAsset) {
        const limit = dailyLimitFor(process.env, reserveAsset);
        const reservation = store.reserveDailyLimit(
          normalized.value.request_id,
          reserveAsset,
          normalized.value.payment?.amount,
          limit
        );
        if (!reservation.ok) {
          risk = blockRiskOnDailyLimit(risk, reserveAsset, normalized.value.payment?.amount, limit);
        }
      }
    }
    const warnings = [...(normalized.warnings || []), ...context.warnings, ...risk.warnings];
    const request = store.putPaymentRequest({
      ...normalized.value,
      ...(tenantScope ? {
        merchant_id: tenantScope.merchant_id,
        actor_id: tenantScope.actor_id,
        idempotency_route: PAYMENT_REQUEST_ROUTE,
        idempotency_request_hash: idempotencyRequestHash
      } : {}),
      target_app_device_id: target,
      transaction_context_ref: context.ref,
      transaction_context_snapshot: context.snapshot || null,
      risk,
      warnings
    });
    if (auth.connection) store.touchConnection(auth.connection.connection_id);
    const eventSeq = store.eventWindow().latest_seq;
    notifyApp(target, { type: "payment_request", request_id: request.request_id, status: request.status, event_seq: eventSeq });
    pushService?.notifyPaymentRequest(target, { request_id: request.request_id, event_seq: eventSeq });
    observability.recordAuditEvent("payment_request.created", "success", {
      actor: auditActorFromAuth(auth),
      resource: { type: "payment_request", id: request.request_id },
      labels: paymentRequestMetricLabels(request),
      details: {
        connection_id: request.connection_id || null,
        transaction_id: request.transaction_id || null,
        target_app_device_id: target,
        warning_count: warnings.length,
        risk_error_count: Array.isArray(risk.errors) ? risk.errors.length : 0,
        recipient_id: request.recipient_id || null,
        recipient_version_id: request.recipient_version_id || null,
        recipient_facts_hash: request.recipient_facts_hash || null
      }
    });
    observability.incrementCounter("Paytobe_payment_requests_total", paymentRequestMetricLabels(request));
    res.status(201).json({
      ok: true,
      payment_request: paymentRequestProjection(request),
      warnings
    });
  });

  router.get("/", (req, res) => {
    store.expireStale();
    if (hasAppCredentials(req)) {
      const auth = verifyAppQuery(req);
      if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
      return res.json({
        ok: true,
        items: store.listPaymentRequestsForDevice(auth.device_id).map(paymentRequestProjection)
      });
    }

    const auth = authorizeConnection(req, "payment.requests.read");
    if (!auth.ok) return sendAuthFailure(res, auth);
    store.touchConnection(auth.connection.connection_id);
    if (auth.connection.binding_version === "Paytobe.connection_binding.v1") {
      try {
        const scope = tenantRepository.scopeForConnection(auth.connection, req.request_id || req.id);
        const page = tenantRepository.listForConnection(scope, auth.connection.connection_id, req.query || {});
        return res.json({ ok: true, items: page.items.map(paymentRequestProjection), next_cursor: page.next_cursor });
      } catch (error) {
        return sendApiError(res, error.status || 400, error.code || "invalid_tenant_cursor", error.message);
      }
    }
    res.json({
      ok: true,
      items: store.listPaymentRequestsForConnection(auth.connection.connection_id).map(paymentRequestProjection)
    });
  });

  router.get("/events", (req, res) => {
    const since = parseEventCursor(req.query.since);
    if (hasAppCredentials(req)) {
      const auth = verifyAppQuery(req);
      if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
      const window = store.eventWindow(since);
      return res.json({
        ok: true,
        ...window,
        items: window.reset_required
          ? []
        : store.paymentRequestEventsForDevice(auth.device_id, since).map((event) => paymentRequestEventProjection(
          event,
          store.paymentRequest(event.data?.request_id || event.request_id || event.intent_id)
        ))
      });
    }
    const auth = authorizeConnection(req, "payment.requests.read");
    if (!auth.ok) return sendAuthFailure(res, auth);
    store.touchConnection(auth.connection.connection_id);
    if (auth.connection.binding_version === "Paytobe.connection_binding.v1") {
      try {
        const scope = tenantRepository.scopeForConnection(auth.connection, req.request_id || req.id);
        const window = tenantRepository.eventsForConnection(scope, auth.connection.connection_id, req.query.cursor || "");
        return res.json({
          ok: true,
          latest_seq: window.latest_seq,
          next_cursor: window.next_cursor,
          reset_required: window.reset_required,
          items: window.items.map((event) => paymentTenantEventProjection(event, paymentRequestEventProjection))
        });
      } catch (error) {
        return sendApiError(res, error.status || 400, error.code || "invalid_tenant_cursor", error.message);
      }
    }
    const window = store.eventWindow(since);
    res.json({
      ok: true,
      ...window,
      items: window.reset_required
        ? []
        : store.paymentRequestEventsForConnection(auth.connection.connection_id, since).map((event) => paymentRequestEventProjection(
          event,
          store.paymentRequest(event.data?.request_id || event.request_id || event.intent_id)
        ))
    });
  });

  router.get("/:id", (req, res) => {
    store.expireStale();
    let request = store.paymentRequest(req.params.id);
    if (hasAppCredentials(req)) {
      const auth = verifyAppQuery(req);
      if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
      if (!request || request.target_app_device_id !== auth.device_id) {
        return sendApiError(res, 404, "payment_request_not_found", "Payment Request not found");
      }
      return res.json({ ok: true, payment_request: paymentRequestProjection(request) });
    }

    const auth = authorizeConnection(req, "payment.requests.read");
    if (!auth.ok) return sendAuthFailure(res, auth);
    if (auth.connection.binding_version === "Paytobe.connection_binding.v1") {
      const scope = tenantRepository.scopeForConnection(auth.connection, req.request_id || req.id);
      request = tenantRepository.get(scope, req.params.id);
    }
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

    const transition = decidePaymentStatusTransition(request, status, platformCore.clock.now().getTime());
    if (!transition.ok) {
      return sendApiError(res, transition.status, transition.code, transition.message, {
        details: transition.details
      });
    }

    if (transition.duplicate) {
      scheduleConfirmation(request);
      return res.status(200).json({ ok: true, duplicate: true, payment_request: paymentRequestProjection(request) });
    }

    const patch = {
      tx_hash: req.body.tx_hash || null,
      error: req.body.error || null
    };
    const updated = applyStatusUpdate(request, status, patch, {
      id: `wallet:${req.body.device_id}`,
      request_id: String(req.request_id || req.id || request.request_id),
      audit: { type: "wallet_device", id: req.body.device_id }
    });
    if (!updated) return sendApiError(res, 404, "payment_request_not_found", "Payment Request not found");

    res.json({ ok: true, payment_request: paymentRequestProjection(updated) });
    scheduleConfirmation(updated);
  });

  router.reconcilePendingConfirmations = reconcilePendingConfirmations;
  return router;
}

function parseEventCursor(value) {
  const cursor = Number(value || 0);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

function hasAppCredentials(req) {
  return Boolean(
    req.query.device_id
    || req.query.token
    || req.get?.("x-app-device-id")
    || req.get?.("x-app-device-token")
  );
}
