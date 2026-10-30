import { createHash } from "node:crypto";

import { assertTenantScope, createTenantScope } from "../../ports/tenant-repository.js";
import { validatePaymentRequestStatusUpdate } from "../../domain/payment-request.js";

export const PAYMENT_REQUEST_ROUTE = "POST /v1/payment-requests";
export const SIGNED_BROADCAST_REPORT_GRACE_MS = 2 * 60 * 1000;

export class StorePaymentTenantRepository {
  constructor(store) {
    if (!store) throw new TypeError("Payment Request store is required");
    this.store = store;
  }

  scopeForConnection(connection, requestId) {
    if (!connection?.merchant_id || !connection?.agent_id) throw new TypeError("Canonical connection tenant binding is required");
    return createTenantScope(Object.freeze({
      merchant_id: connection.merchant_id,
      actor_id: connection.agent_id,
      request_id: String(requestId || "unknown")
    }));
  }

  get(scope, requestId) {
    assertTenantScope(scope);
    const value = this.store.paymentRequest(requestId);
    return value?.merchant_id === scope.merchant_id ? value : null;
  }

  findIdempotency(scope, route, key) {
    assertTenantScope(scope);
    if (!key) return null;
    return Object.values(this.store.state.paymentRequests).find((item) =>
      item.merchant_id === scope.merchant_id
      && item.actor_id === scope.actor_id
      && item.idempotency_route === route
      && item.idempotency_key === key) || null;
  }

  listForConnection(scope, connectionId, { limit = 50, cursor = "" } = {}) {
    assertTenantScope(scope);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    const after = decodeCursor(cursor, scope, "payment-list")?.value || "";
    const rows = Object.values(this.store.state.paymentRequests)
      .filter((item) => item.merchant_id === scope.merchant_id && item.connection_id === connectionId && item.request_id > after)
      .sort((a, b) => a.request_id.localeCompare(b.request_id));
    const more = rows.length > safeLimit;
    const items = rows.slice(0, safeLimit);
    return {
      items,
      next_cursor: more ? encodeCursor(scope, "payment-list", items.at(-1).request_id) : ""
    };
  }

  eventsForConnection(scope, connectionId, cursor = "") {
    assertTenantScope(scope);
    const after = decodeCursor(cursor, scope, "payment-events")?.value || 0;
    const items = this.store.state.events.filter((event) => {
      if (Number(event.seq) <= Number(after) || !String(event.type || "").startsWith("payment_request.")) return false;
      const request = this.requestForEvent(event);
      return request?.merchant_id === scope.merchant_id && request.connection_id === connectionId;
    }).map((event) => this.scopedEvent(scope, event));
    const latest = items.length ? Number(items.at(-1).seq) : Number(after);
    return {
      items,
      next_cursor: encodeCursor(scope, "payment-events", latest),
      latest_seq: latest,
      reset_required: false
    };
  }

  updateStatus(scope, requestId, status, patch) {
    const current = this.get(scope, requestId);
    if (!current) return null;
    return this.store.updatePaymentRequestStatus(requestId, status, patch);
  }

  findByTransactionHash(scope, transactionHash) {
    assertTenantScope(scope);
    return Object.values(this.store.state.paymentRequests).find((item) =>
      item.merchant_id === scope.merchant_id && item.tx_hash === transactionHash) || null;
  }

  requestForEvent(event) {
    const requestId = event.data?.request_id || event.request_id || event.intent_id;
    return requestId ? this.store.paymentRequest(requestId) : null;
  }

  scopedEvent(scope, event) {
    const request = this.requestForEvent(event);
    return {
      ...event,
      event_id: stablePaymentEventId(scope, event, request),
      merchant_id: scope.merchant_id,
      request
    };
  }
}

export function canonicalPaymentRequestHash(value, hash = defaultHash) {
  return hash(stableJson(value));
}

export function stablePaymentEventId(scope, event, request, hash = defaultHash) {
  assertTenantScope(scope);
  const data = event?.data || {};
  return `evt_${hash(stableJson({
    version: "Paytobe.payment_event.v1",
    merchant_id: scope.merchant_id,
    type: event?.type || "",
    request_id: data.request_id || event?.request_id || event?.intent_id || request?.request_id || "",
    status: data.status || request?.status || "",
    tx_hash: data.tx_hash || "",
    error: data.error || ""
  })).replace(/^sha256:/, "")}`;
}

export function decidePaymentStatusTransition(request, nextStatus, nowMs = Date.now()) {
  const expiresAtMs = Date.parse(request.expires_at || 0);
  const expired = expiresAtMs <= nowMs;
  const signedBroadcastWithinGrace = nextStatus === "broadcasted"
    && request.status === "signed"
    && nowMs <= expiresAtMs + SIGNED_BROADCAST_REPORT_GRACE_MS;
  if (["signed", "broadcasted"].includes(nextStatus) && request.status !== nextStatus
      && expired && !signedBroadcastWithinGrace) {
    return { ok: false, status: 409, code: "payment_request_expired", message: "Expired Payment Request cannot be signed or broadcasted" };
  }
  const transition = validatePaymentRequestStatusUpdate(request, nextStatus);
  if (!transition.ok) return transition;
  if (request.status === nextStatus) return { ok: true, duplicate: true };
  return { ok: true, duplicate: false };
}

export function encodeTenantCursor(scope, kind, value) {
  assertTenantScope(scope);
  return encodeCursor(scope, kind, value);
}

export function decodeTenantCursor(cursor, scope, kind) {
  assertTenantScope(scope);
  return decodeCursor(cursor, scope, kind);
}

function encodeCursor(scope, kind, value) {
  return Buffer.from(JSON.stringify({ v: 1, m: scope.merchant_id, k: kind, p: value }), "utf8").toString("base64url");
}

function decodeCursor(cursor, scope, kind) {
  if (!cursor) return { value: "" };
  try {
    const value = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (value.v !== 1 || value.m !== scope.merchant_id || value.k !== kind) throw new Error("mismatch");
    return { value: value.p };
  } catch {
    throw Object.assign(new TypeError("Cursor does not belong to this merchant"), { code: "invalid_tenant_cursor", status: 400 });
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function defaultHash(value) { return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`; }
