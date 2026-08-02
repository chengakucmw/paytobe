import { createHash } from "node:crypto";

import { signWebhookPayload } from "../../crypto.js";

export const WEBHOOK_RETRY_DELAYS_MS = Object.freeze([0, 60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000]);
const DELIVERY_TTL_MS = 24 * 60 * 60_000;

export class WebhookDeliveryService {
  constructor({ repository, transport, vault, clock, random, observability }) {
    for (const [name, value] of Object.entries({ repository, transport, vault, clock, random, observability })) {
      if (!value) throw new TypeError(`Webhook delivery ${name} dependency is required`);
    }
    this.repository = repository;
    this.transport = transport;
    this.vault = vault;
    this.clock = clock;
    this.random = random;
    this.observability = observability;
  }

  enqueue(scope, eventId) {
    const at = this.clock.nowIso();
    return this.repository.enqueueEvent(scope, eventId, () => this.random.id("delivery"), at);
  }

  async runOnce(workerId = "webhook-worker") {
    const now = this.clock.now();
    const claimed = this.repository.claimDue(workerId, now.toISOString(), new Date(now.getTime() + 30_000).toISOString());
    if (!claimed) return { ok: true, idle: true };
    let outcome;
    try {
      const secret = this.vault.decrypt(JSON.parse(claimed.secret_ciphertext),
        `${claimed.merchant_id}:${claimed.webhook_endpoint_id}:${claimed.current_secret_id}`);
      const rawBody = new TextEncoder().encode(claimed.payload_json);
      const timestamp = String(Math.floor(now.getTime() / 1000));
      const response = await this.transport.deliver({
        url: claimed.url,
        raw_body: rawBody,
        headers: {
          "content-type": "application/json",
          "user-agent": "VelarumPay-Webhook/1",
          "x-velarumpay-event-id": claimed.event_id,
          "x-velarumpay-delivery-id": claimed.delivery_id,
          "x-velarumpay-signature": signWebhookPayload(secret, timestamp, rawBody)
        }
      });
      outcome = classifyWebhookDelivery({ response_status: response.status, duration_ms: response.duration_ms });
    } catch (error) {
      outcome = classifyWebhookDelivery({ error });
    }

    const completionAt = this.clock.now();
    const next = outcome.kind === "retry" ? this.nextAttempt(claimed, completionAt) : null;
    if (outcome.kind === "retry" && !next) outcome = { ...outcome, kind: "failed", failure_code: "retry_window_exhausted" };
    const completed = this.repository.complete(claimed, outcome, completionAt.toISOString(), next);
    this.record(claimed, outcome);
    return { ok: outcome.kind === "delivered", idle: false, outcome: outcome.kind, delivery: completed, next_delivery_id: next?.delivery_id || null };
  }

  replay(scope, deliveryId) {
    const value = this.repository.replay(scope, deliveryId, this.random.id("delivery"), this.clock.nowIso());
    return value ? { ok: true, delivery: value } : { ok: false, status: 404, code: "resource_not_found", message: "Resource not found" };
  }

  list(scope, options) {
    return { ok: true, items: this.repository.list(scope, options) };
  }

  nextAttempt(claimed, now) {
    const nextAttempt = Number(claimed.attempt) + 1;
    const delay = WEBHOOK_RETRY_DELAYS_MS[nextAttempt - 1];
    if (delay === undefined) return null;
    const scheduled = new Date(now.getTime() + delay);
    if (scheduled.getTime() > Date.parse(claimed.occurred_at) + DELIVERY_TTL_MS) return null;
    const at = now.toISOString();
    return {
      delivery_id: this.random.id("delivery"),
      merchant_id: claimed.merchant_id,
      event_id: claimed.event_id,
      webhook_endpoint_id: claimed.webhook_endpoint_id,
      attempt: nextAttempt,
      status: "pending",
      scheduled_at: scheduled.toISOString(),
      next_attempt_at: scheduled.toISOString(),
      created_at: at,
      updated_at: at,
      replay_of_delivery_id: claimed.replay_of_delivery_id || null
    };
  }

  record(claimed, outcome) {
    const labels = { outcome: outcome.kind, failure_code: outcome.failure_code || "none", attempt: String(claimed.attempt) };
    this.observability.incrementCounter("velarumpay_webhook_delivery_attempts_total", labels);
    this.observability.observeSummary("velarumpay_webhook_delivery_duration_seconds", { outcome: outcome.kind }, Number(outcome.duration_ms || 0) / 1000);
    this.observability.recordAuditEvent("webhook.delivery_completed", outcome.kind === "delivered" ? "success" : "failure", {
      actor: { type: "platform_worker", id: "webhook_delivery" },
      resource: { type: "webhook_delivery", id: claimed.delivery_id },
      labels,
      details: { merchant_id: claimed.merchant_id, event_id: claimed.event_id, response_status: outcome.response_status || null }
    });
  }
}

export function classifyWebhookDelivery({ response_status, duration_ms = 0, error } = {}) {
  if (error) {
    const code = String(error.code || "webhook_network_error");
    if (["webhook_dns_rebinding", "webhook_non_public_address"].includes(code)) {
      return { kind: "failed", failure_code: code, duration_ms };
    }
    return { kind: "retry", failure_code: "webhook_network_error", duration_ms };
  }
  const status = Number(response_status || 0);
  const responseDigest = createHash("sha256").update(String(status)).digest("hex").slice(0, 16);
  if (status >= 200 && status < 300) return { kind: "delivered", response_status: status, response_digest: responseDigest, duration_ms };
  if (status === 408 || status === 429 || status >= 500) {
    return { kind: "retry", response_status: status, failure_code: `http_${status}`, response_digest: responseDigest, duration_ms };
  }
  return { kind: "failed", response_status: status, failure_code: `http_${status || "invalid"}`, response_digest: responseDigest, duration_ms };
}
