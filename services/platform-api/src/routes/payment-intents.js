// Legacy Payment Intent routes. Mounted at "/v1/payment-intents".

import express from "express";
import { resolveTargetDevice } from "../routing.js";
import { adaptVelarum } from "../velarum.js";
import {
  INTENT_STATUS_UPDATES,
  canTransition,
  dailyLimitFor,
  evaluateIntent,
  shouldRecordSpent,
  validateIntentStatusUpdate
} from "../risk.js";

// F1: terminal non-confirmed statuses that must RELEASE a held daily-cap
// reservation (the payment will never settle).
const RELEASE_ON_STATUS = new Set(["failed", "expired", "rejected"]);

export function createPaymentIntentsRouter(deps) {
  const {
    store,
    sendApiError,
    verifyOpenClaw,
    verifyAppQuery,
    verifyAppBody,
    notifyApp,
    notifyOpenClaw,
    confirmLater,
    platformCore
  } = deps;
  const router = express.Router();

  router.post("/", (req, res) => {
    const auth = verifyOpenClaw(req);
    if (!auth.ok) return sendApiError(res, auth.status, auth.code || "openclaw_unauthorized", auth.error);

    const body = req.body || {};
    const idempotencyKey = req.get("x-idempotency-key") || body.idempotency_key || "";

    // Resolve the target wallet device first so the idempotency lookup can be scoped
    // to it. An idempotency key is caller-supplied, so a replay must only ever return
    // an intent bound to the same device; otherwise it leaks another user's intent.
    const targetResolution = resolveTargetDevice({ legacy: true }, body, { defaultDeviceId: process.env.DEFAULT_APP_DEVICE_ID });
    if (!targetResolution.ok) {
      return sendApiError(res, targetResolution.status, targetResolution.code, targetResolution.message);
    }
    const target = targetResolution.target;

    if (idempotencyKey) {
      const existing = store.findByIdempotency(idempotencyKey, target);
      if (existing) return res.status(200).json({ ok: true, duplicate: true, intent: existing });
    }

    const now = platformCore.clock.now();
    const expires = body.expires_at ? new Date(body.expires_at) : new Date(now.getTime() + 5 * 60 * 1000);
    const intent = {
      protocol: "agentwallet.payment_intent.v1",
      ...body,
      intent_id: body.intent_id || platformCore.random.id("pi"),
      status: "pending",
      created_at: body.created_at || now.toISOString(),
      expires_at: expires.toISOString(),
      idempotency_key: idempotencyKey,
      target_app_device_id: target,
      history: [{ status: "pending", at: now.toISOString() }]
    };

    const velarum = adaptVelarum(intent);
    if (!velarum.ok) return sendApiError(res, 400, "invalid_velarum_payload", velarum.error);

    const risk = evaluateIntent(intent, store);
    intent.risk = {
      ...(intent.risk || {}),
      warnings: [...(intent.risk?.warnings || []), ...(velarum.warnings || []), ...risk.warnings],
      errors: risk.errors
    };
    if (!risk.ok) {
      return sendApiError(res, 422, "risk_policy_rejected", "Risk policy rejected payment intent", {
        details: { errors: risk.errors }
      });
    }

    // F1: atomically reserve this amount against the daily cap BEFORE accepting the
    // intent. evaluateIntent already did a read-only check, but only reserving and
    // recording in ONE lock stops N concurrent intents from all passing that check
    // against the same un-incremented total and then all confirming past the cap.
    const reservation = store.reserveDailyLimit(
      intent.intent_id,
      intent.payment?.asset,
      intent.payment?.amount,
      dailyLimitFor(process.env, intent.payment?.asset)
    );
    if (!reservation.ok) {
      return sendApiError(res, 422, "risk_policy_rejected", "Risk policy rejected payment intent", {
        details: { errors: [`Daily ${String(intent.payment?.asset || "").toUpperCase()} limit exceeded`] }
      });
    }

    store.putIntent(intent);
    notifyApp(target, { type: "payment_intent", intent_id: intent.intent_id, status: intent.status });
    res.status(201).json({ ok: true, intent });
  });

  router.get("/", (req, res) => {
    const auth = verifyAppQuery(req);
    if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
    store.expireStale();
    res.json({ ok: true, items: store.listForDevice(req.query.device_id) });
  });

  router.get("/:id", (req, res) => {
    const auth = verifyAppQuery(req);
    if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
    store.expireStale();
    const intent = store.intent(req.params.id);
    if (!intent || intent.target_app_device_id !== req.query.device_id) {
      return sendApiError(res, 404, "payment_intent_not_found", "Payment Intent not found");
    }
    res.json({ ok: true, intent: store.intent(req.params.id) });
  });

  router.post("/:id/status", (req, res) => {
    const auth = verifyAppBody(req);
    if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
    const intent = store.intent(req.params.id);
    if (!intent || intent.target_app_device_id !== req.body.device_id) {
      return sendApiError(res, 404, "payment_intent_not_found", "Payment Intent not found");
    }
    const status = req.body.status;
    if (!INTENT_STATUS_UPDATES.has(status) || !canTransition(status)) {
      return sendApiError(res, 400, "invalid_status", "Invalid status", { field: "status" });
    }
    // M5 (intent parity): block illegal device-reported transitions — pending->confirmed
    // (skipping signature/broadcast), reviving a failed intent, and re-reporting a
    // terminal status — so the F1 settle/release side effects never run twice.
    const transition = validateIntentStatusUpdate(intent, status);
    if (!transition.ok) {
      return sendApiError(res, transition.status, transition.code, transition.message, { details: transition.details });
    }
    const updated = store.updateStatus(intent.intent_id, status, {
      tx_hash: req.body.tx_hash || null,
      error: req.body.error || null
    });
    // F1: settle the held reservation into confirmed spend on success; release it
    // back to the cap on a terminal non-confirmed status. (A broadcasted intent is
    // resolved by confirmLater, which settles/releases there.)
    if (shouldRecordSpent(status)) {
      store.settleDailyReservation(intent.intent_id, intent.payment.asset, intent.payment.amount);
    } else if (RELEASE_ON_STATUS.has(status)) {
      store.releaseDailyReservation(intent.intent_id);
    }
    notifyOpenClaw(intent.source?.device_id, {
      type: "payment_status",
      intent_id: intent.intent_id,
      status,
      tx_hash: req.body.tx_hash || null,
      error: req.body.error || null
    });
    if (status === "broadcasted" && req.body.tx_hash) {
      // M3: fire-and-forget, but a rejection must never bubble up as an unhandled
      // process-level rejection — attach a catch that logs and moves on.
      confirmLater(updated, req.body.tx_hash).catch((error) => {
        console.error(`confirmLater failed for ${updated.intent_id}:`, error?.message || error);
      });
    }
    res.json({ ok: true, intent: updated });
  });

  return router;
}
