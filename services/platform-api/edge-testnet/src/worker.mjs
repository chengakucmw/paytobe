const CONNECT_KEY_PATTERN = /^velarumpay-connect:ck_[A-Za-z0-9_-]{43}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const ALLOWED_SCOPES = new Set([
  "payment.requests.create",
  "payment.requests.read",
  "transaction_contexts.create",
  "transaction_contexts.read",
  "wallet.addresses.read"
]);
const PAYMENT_TRANSITIONS = Object.freeze({
  pending: new Set(["signed", "broadcasted", "rejected", "expired", "failed"]),
  signed: new Set(["broadcasted", "failed", "expired", "rejected"]),
  broadcasted: new Set(["confirmed", "failed"]),
  confirmed: new Set(), failed: new Set(), expired: new Set(), rejected: new Set()
});
const SIGNED_BROADCAST_REPORT_GRACE_MS = 2 * 60 * 1000;
const CONTROLLED_WEBHOOK_RECEIVERS = Object.freeze({
  "/testing/webhooks/merchant-a": Object.freeze({ label: "merchant-a", challenge: "WEBHOOK_A_OWNERSHIP_CHALLENGE", secret: "WEBHOOK_A_SECRET" }),
  "/testing/webhooks/merchant-b": Object.freeze({ label: "merchant-b", challenge: "WEBHOOK_B_OWNERSHIP_CHALLENGE", secret: "WEBHOOK_B_SECRET" })
});

function edgePaymentTransition(request, nextStatus, nowMs = Date.now()) {
  const currentStatus = String(request?.status || "pending").toLowerCase();
  const expiresAtMs = Date.parse(request?.expires_at || 0);
  const expired = expiresAtMs <= nowMs;
  const signedBroadcastWithinGrace = nextStatus === "broadcasted"
    && currentStatus === "signed"
    && nowMs <= expiresAtMs + SIGNED_BROADCAST_REPORT_GRACE_MS;
  if (["signed", "broadcasted"].includes(nextStatus) && currentStatus !== nextStatus
      && expired && !signedBroadcastWithinGrace) {
    return { ok: false, status: 409, code: "payment_request_expired", message: "Expired Payment Request cannot be signed or broadcasted" };
  }
  if (currentStatus === nextStatus && ["signed", "broadcasted"].includes(currentStatus)) return { ok: true, duplicate: true };
  if (["confirmed", "expired", "rejected"].includes(currentStatus)) {
    return { ok: false, status: 409, code: "terminal_payment_request", message: "Terminal Payment Request status cannot be changed" };
  }
  if (!PAYMENT_TRANSITIONS[currentStatus]?.has(nextStatus)) {
    return { ok: false, status: 409, code: "invalid_status_transition", message: `Cannot move Payment Request from ${currentStatus} to ${nextStatus}` };
  }
  return { ok: true, duplicate: false };
}

function edgeWebhookDeliveryDecision(status = 0, errorCode = "") {
  if (errorCode) {
    return ["webhook_dns_rebinding", "webhook_non_public_address"].includes(errorCode)
      ? { kind: "failed", failure_code: errorCode }
      : { kind: "retry", failure_code: "webhook_network_error" };
  }
  const code = Number(status || 0);
  if (code >= 200 && code < 300) return { kind: "delivered" };
  if (code === 408 || code === 429 || code >= 500) return { kind: "retry", failure_code: `http_${code}` };
  return { kind: "failed", failure_code: `http_${code || "invalid"}` };
}

function json(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...headers
    }
  });
}

function apiError(status, code, message, details) {
  const requestId = crypto.randomUUID();
  return json(status, {
    ok: false,
    error: { code, message, request_id: requestId, ...(details ? { details } : {}) }
  }, { "x-request-id": requestId });
}

async function body(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 256 * 1024) throw Object.assign(new Error("Request body is too large"), { status: 413, code: "payload_too_large" });
  try { return await request.json(); }
  catch { throw Object.assign(new Error("Request body must be valid JSON"), { status: 400, code: "invalid_json" }); }
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function randomToken(prefix) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}_${base64url(bytes)}`;
}

function id(prefix) { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`; }

async function hash(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalPaymentInput(payload) {
  const value = structuredClone(payload || {});
  for (const field of ["request_id", "connection_id", "connection_token", "created_at", "updated_at", "status", "event_history",
    "merchant_id", "actor_id", "idempotency_route", "idempotency_scope", "idempotency_request_hash"]) delete value[field];
  return value;
}

async function edgePaymentScope(connection, payload) {
  const merchantId = String(connection.merchant_id || connection.tenant_id || "");
  const actorId = String(connection.agent_id || connection.agent_identity?.agent_id || connection.client_id || "");
  const route = "POST /v1/payment-requests";
  const key = String(payload.idempotency_key || "");
  const scopedKey = `idem_${(await hash(stableJson([merchantId, actorId, route, key]))).replace(/^sha256:/, "")}`;
  return {
    merchant_id: merchantId,
    actor_id: actorId,
    route,
    key,
    scoped_key: scopedKey,
    request_hash: await hash(stableJson(canonicalPaymentInput(payload)))
  };
}

async function edgePaymentEvent(scope, type, payment, patch = {}, at = new Date().toISOString()) {
  const facts = {
    version: "velarum.payment_event.v1",
    merchant_id: scope.merchant_id,
    type,
    request_id: payment.request_id,
    status: patch.status || payment.status || "",
    tx_hash: patch.tx_hash || "",
    error: patch.error || ""
  };
  return Object.freeze({
    event_id: `evt_${(await hash(stableJson(facts))).replace(/^sha256:/, "")}`,
    merchant_id: scope.merchant_id,
    actor_id: scope.actor_id,
    type,
    request_id: payment.request_id,
    status: facts.status,
    tx_hash: facts.tx_hash || null,
    error: facts.error || null,
    at
  });
}

function encodeEdgeCursor(owner, key) {
  return base64url(new TextEncoder().encode(JSON.stringify({ v: 1, o: owner, k: key })));
}

function decodeEdgeCursor(cursor, owner) {
  if (!cursor) return "";
  try {
    const text = atob(String(cursor).replaceAll("-", "+").replaceAll("_", "/"));
    const value = JSON.parse(text);
    if (value.v !== 1 || value.o !== owner || typeof value.k !== "string") throw new Error("mismatch");
    return value.k;
  } catch {
    throw Object.assign(new Error("Event cursor does not belong to this tenant"), { status: 400, code: "invalid_tenant_cursor" });
  }
}

function edgeEventPage(payments, owner, cursor = "") {
  const after = decodeEdgeCursor(cursor, owner);
  const events = payments.flatMap((payment) => Array.isArray(payment.event_history) ? payment.event_history : [])
    .sort((a, b) => `${a.at}:${a.event_id}`.localeCompare(`${b.at}:${b.event_id}`));
  const items = events.filter((event) => `${event.at}:${event.event_id}` > after);
  const last = items.at(-1);
  return {
    items,
    next_cursor: encodeEdgeCursor(owner, last ? `${last.at}:${last.event_id}` : after),
    reset_required: false
  };
}

async function sameSecret(left, right) {
  if (!left || !right) return false;
  return (await hash(left)) === (await hash(right));
}

function bearer(request, alternateHeader = "") {
  const match = String(request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return String(match?.[1] || (alternateHeader ? request.headers.get(alternateHeader) : "") || "").trim();
}

function scopes(value, fallback = ["payment.requests.create", "payment.requests.read"]) {
  const input = Array.isArray(value) ? value : fallback;
  const normalized = [...new Set(input.map((item) => String(item).trim()).filter(Boolean))];
  return normalized.length && normalized.every((item) => ALLOWED_SCOPES.has(item)) ? normalized : null;
}

function parse(value, fallback) {
  try { return value == null || value === "" ? fallback : JSON.parse(value); }
  catch { return fallback; }
}

function invitationFromRow(row) {
  if (!row) return null;
  return {
    connect_invitation_id: row.connect_invitation_id,
    connect_key_hash: row.connect_key_hash,
    claim_token_hash: row.claim_token_hash || "",
    target_app_device_id: row.target_app_device_id,
    tenant_id: row.tenant_id || "",
    client_id: row.client_id || "",
    status: row.status,
    agent_identity: parse(row.agent_identity_json, null),
    identity_assurance: row.identity_assurance || null,
    requested_scopes: parse(row.requested_scopes_json, []),
    pairing_session_id: row.pairing_session_id || "",
    connection_id: row.connection_id || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
    claimed_at: row.claimed_at || null,
    approved_at: row.approved_at || null,
    connected_at: row.connected_at || null,
    rejected_at: row.rejected_at || null,
    cancelled_at: row.cancelled_at || null,
    expired_at: row.expired_at || null,
    expires_at: row.expires_at,
    exchange_count: Number(row.exchange_count || 0)
  };
}

function connectionFromRow(row) {
  if (!row) return null;
  const scopesValue = parse(row.scopes_json, []);
  const identity = parse(row.agent_identity_json, {});
  return {
    connection_id: row.connection_id,
    connection_token_hash: row.connection_token_hash || "",
    target_app_device_id: row.target_app_device_id,
    tenant_id: row.tenant_id,
    client_id: row.client_id,
    pairing_session_id: row.pairing_session_id,
    agent_identity: identity,
    binding_version: identity.binding_version || "",
    merchant_id: identity.merchant_id || row.merchant_id || row.tenant_id,
    agent_id: identity.agent_id || row.client_id,
    credential_id: identity.credential_id || "",
    audience: identity.audience || "",
    scopes: scopesValue,
    approved_scopes: scopesValue,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_activity_at: row.updated_at,
    expires_at: row.expires_at
  };
}

function clientFromRow(row) {
  if (!row) return null;
  return {
    client_id: row.client_id,
    tenant_id: row.tenant_id,
    display_name: row.display_name,
    runtime: row.runtime,
    source_domain: row.source_domain,
    status: row.status,
    token_hash: row.token_hash
  };
}

class D1Store {
  constructor(db) { this.db = db; }

  async registerDevice(deviceId, tokenHash, at) {
    const existing = await this.db.prepare("SELECT * FROM app_devices WHERE device_id = ?").bind(deviceId).first();
    if (existing) {
      if (existing.token_hash !== tokenHash) return { conflict: true };
      await this.db.prepare("UPDATE app_devices SET last_seen_at = ? WHERE device_id = ?").bind(at, deviceId).run();
      return { device_id: deviceId, registered_at: existing.registered_at, last_seen_at: at };
    }
    await this.db.prepare("INSERT INTO app_devices (device_id, token_hash, registered_at, last_seen_at) VALUES (?, ?, ?, ?)")
      .bind(deviceId, tokenHash, at, at).run();
    return { device_id: deviceId, registered_at: at, last_seen_at: at };
  }

  async verifyDevice(deviceId, tokenHash) {
    const row = await this.db.prepare("SELECT token_hash FROM app_devices WHERE device_id = ?").bind(deviceId).first();
    return Boolean(row && row.token_hash === tokenHash);
  }

  async createClient(value) {
    await this.db.batch([
      this.db.prepare(`INSERT INTO tenants (tenant_id, display_name, status, created_at, updated_at)
        VALUES (?, ?, 'active', ?, ?)
        ON CONFLICT(tenant_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`)
        .bind(value.tenant_id, value.tenant_name, value.at, value.at),
      this.db.prepare(`INSERT INTO agent_clients (client_id, tenant_id, display_name, runtime, source_domain, token_hash, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
        .bind(value.client_id, value.tenant_id, value.display_name, value.runtime, value.source_domain, value.token_hash, value.at, value.at)
    ]);
    return value;
  }

  async clientByTokenHash(tokenHash) {
    return clientFromRow(await this.db.prepare("SELECT * FROM agent_clients WHERE token_hash = ? AND status = 'active'").bind(tokenHash).first());
  }

  async createInvitation(value) {
    await this.db.prepare(`INSERT INTO connect_invitations (
      connect_invitation_id, connect_key_hash, target_app_device_id, status,
      requested_scopes_json, created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, 'waiting', '[]', ?, ?, ?)`)
      .bind(value.connect_invitation_id, value.connect_key_hash, value.target_app_device_id, value.created_at, value.updated_at, value.expires_at).run();
    return this.invitationById(value.connect_invitation_id);
  }

  async invitationById(value) { return invitationFromRow(await this.db.prepare("SELECT * FROM connect_invitations WHERE connect_invitation_id = ?").bind(value).first()); }
  async invitationByClaimHash(value) { return invitationFromRow(await this.db.prepare("SELECT * FROM connect_invitations WHERE claim_token_hash = ?").bind(value).first()); }
  async invitationByPairingId(value) { return invitationFromRow(await this.db.prepare("SELECT * FROM connect_invitations WHERE pairing_session_id = ?").bind(value).first()); }

  async expireInvitation(invitation, at) {
    if (!invitation || !["waiting", "claimed"].includes(invitation.status) || invitation.expires_at > at) return invitation;
    await this.db.prepare("UPDATE connect_invitations SET status = 'expired', expired_at = ?, updated_at = ? WHERE connect_invitation_id = ? AND status IN ('waiting','claimed')")
      .bind(at, at, invitation.connect_invitation_id).run();
    return this.invitationById(invitation.connect_invitation_id);
  }

  async claimInvitation(keyHash, claimHash, client, requestedScopes, pairingId, at) {
    const identity = canonicalEdgeIdentity(client);
    const result = await this.db.prepare(`UPDATE connect_invitations
      SET status = 'claimed', claim_token_hash = ?, tenant_id = ?, client_id = ?, agent_identity_json = ?,
          identity_assurance = 'registered', requested_scopes_json = ?, pairing_session_id = ?, claimed_at = ?, updated_at = ?
      WHERE connect_key_hash = ? AND status = 'waiting' AND expires_at > ?`)
      .bind(claimHash, client.tenant_id, client.client_id, JSON.stringify(identity), JSON.stringify(requestedScopes), pairingId, at, at, keyHash, at).run();
    if (Number(result.meta?.changes || 0) !== 1) return null;
    return invitationFromRow(await this.db.prepare("SELECT * FROM connect_invitations WHERE connect_key_hash = ?").bind(keyHash).first());
  }

  async cancelInvitation(invitationId, deviceId, at) {
    const result = await this.db.prepare(`UPDATE connect_invitations SET status = 'cancelled', cancelled_at = ?, updated_at = ?
      WHERE connect_invitation_id = ? AND target_app_device_id = ? AND status IN ('waiting','claimed')`)
      .bind(at, at, invitationId, deviceId).run();
    return Number(result.meta?.changes || 0) === 1 ? this.invitationById(invitationId) : null;
  }

  async approveInvitation(invitation, approvedScopes, connectionId, at, expiresAt) {
    const identity = { ...invitation.agent_identity, approved_by_device_id: invitation.target_app_device_id, connection_id: connectionId };
    const connection = {
      connection_id: connectionId, target_app_device_id: invitation.target_app_device_id,
      tenant_id: invitation.tenant_id, client_id: invitation.client_id,
      pairing_session_id: invitation.pairing_session_id, agent_identity: identity,
      scopes: approvedScopes, status: "active", created_at: at, updated_at: at, expires_at: expiresAt
    };
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO connections (
        connection_id, target_app_device_id, tenant_id, client_id, pairing_session_id,
        agent_identity_json, scopes_json, status, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
        .bind(connectionId, invitation.target_app_device_id, invitation.tenant_id, invitation.client_id, invitation.pairing_session_id,
          JSON.stringify(identity), JSON.stringify(approvedScopes), at, at, expiresAt),
      this.db.prepare(`UPDATE connect_invitations SET status = 'approved', connection_id = ?, approved_at = ?, updated_at = ?
        WHERE connect_invitation_id = ? AND status = 'claimed'`).bind(connectionId, at, at, invitation.connect_invitation_id)
    ]);
    if (Number(results[1].meta?.changes || 0) !== 1) return null;
    return { invitation: await this.invitationById(invitation.connect_invitation_id), connection };
  }

  async rejectInvitation(invitation, at) {
    const result = await this.db.prepare("UPDATE connect_invitations SET status = 'rejected', rejected_at = ?, updated_at = ? WHERE connect_invitation_id = ? AND status = 'claimed'")
      .bind(at, at, invitation.connect_invitation_id).run();
    return Number(result.meta?.changes || 0) === 1 ? this.invitationById(invitation.connect_invitation_id) : null;
  }

  async exchangeInvitation(invitation, tokenHash, at) {
    const connection = await this.connectionById(invitation.connection_id);
    if (!connection || connection.status !== "active" || !["approved", "connected"].includes(invitation.status)) return null;
    await this.db.batch([
      this.db.prepare("UPDATE connections SET connection_token_hash = ?, updated_at = ? WHERE connection_id = ? AND status = 'active'")
        .bind(tokenHash, at, connection.connection_id),
      this.db.prepare(`UPDATE connect_invitations SET status = 'connected', connected_at = COALESCE(connected_at, ?),
        updated_at = ?, exchange_count = exchange_count + 1 WHERE connect_invitation_id = ? AND status IN ('approved','connected')`)
        .bind(at, at, invitation.connect_invitation_id)
    ]);
    return { invitation: await this.invitationById(invitation.connect_invitation_id), connection: await this.connectionById(connection.connection_id) };
  }

  async connectionById(value) { return connectionFromRow(await this.db.prepare("SELECT * FROM connections WHERE connection_id = ?").bind(value).first()); }
  async connectionByTokenHash(value) { return connectionFromRow(await this.db.prepare(`SELECT c.* FROM connections c
    JOIN agent_clients ac ON ac.client_id = c.client_id AND ac.tenant_id = c.tenant_id AND ac.status = 'active'
    JOIN tenants t ON t.tenant_id = c.tenant_id AND t.status = 'active'
    JOIN app_devices d ON d.device_id = c.target_app_device_id
    WHERE c.connection_token_hash = ?`).bind(value).first()); }
  async listConnections(deviceId) { return (await this.db.prepare("SELECT * FROM connections WHERE target_app_device_id = ? ORDER BY created_at DESC").bind(deviceId).all()).results.map(connectionFromRow); }

  async updateConnection(connectionId, deviceId, status, at) {
    const result = await this.db.prepare(`UPDATE connections SET status = ?, updated_at = ?,
      connection_token_hash = CASE WHEN ? = 'revoked' THEN NULL ELSE connection_token_hash END
      WHERE connection_id = ? AND target_app_device_id = ?`).bind(status, at, status, connectionId, deviceId).run();
    return Number(result.meta?.changes || 0) === 1 ? this.connectionById(connectionId) : null;
  }

  async upsertContext(connection, payload, at) {
    await this.db.prepare(`INSERT INTO transaction_contexts (transaction_id, connection_id, tenant_id, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(transaction_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
      WHERE transaction_contexts.connection_id = excluded.connection_id`)
      .bind(payload.transaction_id, connection.connection_id, connection.tenant_id, JSON.stringify(payload), payload.created_at || at, at).run();
    return payload;
  }

  async createPayment(connection, payload, at) {
    const result = await this.createPaymentScoped(connection, payload, at);
    return result.payment;
  }

  async createPaymentScoped(connection, payload, at) {
    const scope = await edgePaymentScope(connection, payload);
    const existing = await this.db.prepare(`SELECT payload_json FROM payment_requests
      WHERE merchant_id = ? AND client_id = ? AND idempotency_key = ? LIMIT 1`)
      .bind(scope.merchant_id, connection.client_id, scope.scoped_key).first();
    if (existing) {
      const payment = parse(existing.payload_json, {});
      return payment.idempotency_request_hash === scope.request_hash
        ? { outcome: "duplicate", payment }
        : { outcome: "conflict", payment: null };
    }
    const event = await edgePaymentEvent(scope, "payment_request.created", payload, { status: "pending" }, at);
    const stored = {
      ...payload,
      merchant_id: scope.merchant_id,
      actor_id: scope.actor_id,
      idempotency_route: scope.route,
      idempotency_scope: scope.scoped_key,
      idempotency_request_hash: scope.request_hash,
      event_history: [event]
    };
    await this.db.prepare(`INSERT INTO payment_requests (
      request_id, connection_id, tenant_id, client_id, target_app_device_id, idempotency_key,
      status, payload_json, created_at, updated_at, merchant_id, tenant_attribution
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'explicit_merchant_id')`)
      .bind(payload.request_id, connection.connection_id, connection.tenant_id, connection.client_id,
        connection.target_app_device_id, scope.scoped_key, payload.status, JSON.stringify(stored), payload.created_at || at, at,
        scope.merchant_id).run();
    return { outcome: "created", payment: stored };
  }

  async listPayments(deviceId) {
    return (await this.db.prepare("SELECT payload_json FROM payment_requests WHERE target_app_device_id = ? ORDER BY created_at DESC").bind(deviceId).all()).results
      .map((row) => parse(row.payload_json, {}));
  }

  async paymentById(value) {
    const row = await this.db.prepare("SELECT * FROM payment_requests WHERE request_id = ?").bind(value).first();
    return row ? { request_id: row.request_id, target_app_device_id: row.target_app_device_id, payload: parse(row.payload_json, {}) } : null;
  }

  async paymentByIdForTenant(connection, value) {
    const merchantId = String(connection.merchant_id || connection.tenant_id || "");
    const row = await this.db.prepare(`SELECT * FROM payment_requests
      WHERE merchant_id = ? AND client_id = ? AND request_id = ?`).bind(merchantId, connection.client_id, value).first();
    return row ? { request_id: row.request_id, target_app_device_id: row.target_app_device_id, payload: parse(row.payload_json, {}) } : null;
  }

  async listPaymentsForTenant(connection) {
    const merchantId = String(connection.merchant_id || connection.tenant_id || "");
    return (await this.db.prepare(`SELECT payload_json FROM payment_requests
      WHERE merchant_id = ? AND client_id = ? ORDER BY created_at DESC`).bind(merchantId, connection.client_id).all()).results
      .map((row) => parse(row.payload_json, {}));
  }

  async paymentEventsForTenant(connection, cursor = "") {
    const merchantId = String(connection.merchant_id || connection.tenant_id || "");
    return edgeEventPage(await this.listPaymentsForTenant(connection), `merchant:${merchantId}:actor:${connection.client_id}`, cursor);
  }

  async paymentEventsForDevice(deviceId, cursor = "") {
    return edgeEventPage(await this.listPayments(deviceId), `wallet:${deviceId}`, cursor);
  }

  async findPaymentByTransactionHash(connection, transactionHash) {
    const payments = await this.listPaymentsForTenant(connection);
    return payments.find((payment) => payment.tx_hash === transactionHash) || null;
  }

  async updatePayment(requestId, deviceId, status, patch, at) {
    const current = await this.paymentById(requestId);
    if (!current || current.target_app_device_id !== deviceId) return null;
    if (current.payload.status === status) return { outcome: "duplicate", payment: current.payload };
    const scope = { merchant_id: current.payload.merchant_id, actor_id: `wallet:${deviceId}` };
    const event = await edgePaymentEvent(scope, "payment_request.status", current.payload, { ...patch, status }, at);
    const payload = { ...current.payload, status, updated_at: at, ...patch,
      event_history: [...(current.payload.event_history || []), event] };
    await this.db.prepare(`UPDATE payment_requests SET status = ?, payload_json = ?, updated_at = ?
      WHERE merchant_id = ? AND request_id = ? AND target_app_device_id = ?`)
      .bind(status, JSON.stringify(payload), at, current.payload.merchant_id, requestId, deviceId).run();
    return { outcome: "updated", payment: payload };
  }
}

class MemoryStore {
  constructor() {
    this.devices = new Map(); this.clients = new Map(); this.invitations = new Map();
    this.connections = new Map(); this.contexts = new Map(); this.payments = new Map();
  }
  async registerDevice(deviceId, tokenHash, at) { const current = this.devices.get(deviceId); if (current && current.token_hash !== tokenHash) return { conflict: true }; const row = current || { device_id: deviceId, token_hash: tokenHash, registered_at: at }; row.last_seen_at = at; this.devices.set(deviceId, row); return { ...row, token_hash: undefined }; }
  async verifyDevice(deviceId, tokenHash) { return this.devices.get(deviceId)?.token_hash === tokenHash; }
  async createClient(value) { this.clients.set(value.token_hash, { ...value, status: "active" }); return value; }
  async clientByTokenHash(value) { return this.clients.get(value) || null; }
  async createInvitation(value) { const row = { ...value, status: "waiting", requested_scopes: [], exchange_count: 0 }; this.invitations.set(value.connect_invitation_id, row); return structuredClone(row); }
  async invitationById(value) { const row = this.invitations.get(value); return row ? structuredClone(row) : null; }
  async invitationByClaimHash(value) { const row = [...this.invitations.values()].find((item) => item.claim_token_hash === value); return row ? structuredClone(row) : null; }
  async invitationByPairingId(value) { const row = [...this.invitations.values()].find((item) => item.pairing_session_id === value); return row ? structuredClone(row) : null; }
  async expireInvitation(invitation, at) { if (invitation && ["waiting", "claimed"].includes(invitation.status) && invitation.expires_at <= at) Object.assign(this.invitations.get(invitation.connect_invitation_id), { status: "expired", expired_at: at, updated_at: at }); return this.invitationById(invitation.connect_invitation_id); }
  async claimInvitation(keyHash, claimHash, client, requestedScopes, pairingId, at) { const row = [...this.invitations.values()].find((item) => item.connect_key_hash === keyHash); if (!row || row.status !== "waiting" || row.expires_at <= at) return null; if (![...this.clients.values()].some((item) => item.client_id === client.client_id)) this.clients.set(`runtime:${client.client_id}`, { ...client, status: "active" }); const identity = canonicalEdgeIdentity(client); Object.assign(row, { status: "claimed", claim_token_hash: claimHash, tenant_id: client.tenant_id, client_id: client.client_id, agent_identity: identity, identity_assurance: "registered", requested_scopes: requestedScopes, pairing_session_id: pairingId, claimed_at: at, updated_at: at }); return structuredClone(row); }
  async cancelInvitation(invitationId, deviceId, at) { const row = this.invitations.get(invitationId); if (!row || row.target_app_device_id !== deviceId || !["waiting", "claimed"].includes(row.status)) return null; Object.assign(row, { status: "cancelled", cancelled_at: at, updated_at: at }); return structuredClone(row); }
  async approveInvitation(invitation, approvedScopes, connectionId, at, expiresAt) { const row = this.invitations.get(invitation.connect_invitation_id); if (!row || row.status !== "claimed") return null; const identity = { ...row.agent_identity, approved_by_device_id: row.target_app_device_id, connection_id: connectionId }; const connection = { connection_id: connectionId, target_app_device_id: row.target_app_device_id, tenant_id: row.tenant_id, client_id: row.client_id, pairing_session_id: row.pairing_session_id, agent_identity: identity, scopes: approvedScopes, approved_scopes: approvedScopes, status: "active", created_at: at, updated_at: at, expires_at: expiresAt }; this.connections.set(connectionId, connection); Object.assign(row, { status: "approved", connection_id: connectionId, approved_at: at, updated_at: at }); return { invitation: structuredClone(row), connection: structuredClone(connection) }; }
  async rejectInvitation(invitation, at) { const row = this.invitations.get(invitation.connect_invitation_id); if (!row || row.status !== "claimed") return null; Object.assign(row, { status: "rejected", rejected_at: at, updated_at: at }); return structuredClone(row); }
  async exchangeInvitation(invitation, tokenHash, at) { const row = this.invitations.get(invitation.connect_invitation_id); const connection = this.connections.get(invitation.connection_id); if (!row || !connection || !["approved", "connected"].includes(row.status) || connection.status !== "active") return null; Object.assign(connection, { connection_token_hash: tokenHash, updated_at: at }); Object.assign(row, { status: "connected", connected_at: row.connected_at || at, updated_at: at, exchange_count: Number(row.exchange_count || 0) + 1 }); return { invitation: structuredClone(row), connection: structuredClone(connection) }; }
  async connectionByTokenHash(value) { const row = [...this.connections.values()].find((item) => item.connection_token_hash === value); if (!row || !this.devices.has(row.target_app_device_id) || ![...this.clients.values()].some((client) => client.client_id === row.client_id && client.tenant_id === row.tenant_id && client.status === "active")) return null; return structuredClone(row); }
  async listConnections(deviceId) { return [...this.connections.values()].filter((item) => item.target_app_device_id === deviceId).map((item) => structuredClone(item)); }
  async updateConnection(connectionId, deviceId, status, at) { const row = this.connections.get(connectionId); if (!row || row.target_app_device_id !== deviceId) return null; Object.assign(row, { status, updated_at: at, ...(status === "revoked" ? { connection_token_hash: "" } : {}) }); return structuredClone(row); }
  async upsertContext(connection, payload) { this.contexts.set(payload.transaction_id, { connection, payload: structuredClone(payload) }); return payload; }
  async createPayment(connection, payload, at = new Date().toISOString()) { const result = await this.createPaymentScoped(connection, payload, at); return result.payment; }
  async createPaymentScoped(connection, payload, at = new Date().toISOString()) { const scope = await edgePaymentScope(connection, payload); const existing = [...this.payments.values()].find((item) => item.payload.merchant_id === scope.merchant_id && item.payload.actor_id === scope.actor_id && item.payload.idempotency_scope === scope.scoped_key); if (existing) return existing.payload.idempotency_request_hash === scope.request_hash ? { outcome: "duplicate", payment: structuredClone(existing.payload) } : { outcome: "conflict", payment: null }; const event = await edgePaymentEvent(scope, "payment_request.created", payload, { status: "pending" }, at); const stored = { ...structuredClone(payload), merchant_id: scope.merchant_id, actor_id: scope.actor_id, idempotency_route: scope.route, idempotency_scope: scope.scoped_key, idempotency_request_hash: scope.request_hash, event_history: [event] }; this.payments.set(`${scope.merchant_id}:${payload.request_id}`, { connection_id: connection.connection_id, client_id: connection.client_id, target_app_device_id: connection.target_app_device_id, payload: stored }); return { outcome: "created", payment: structuredClone(stored) }; }
  async listPayments(deviceId) { return [...this.payments.values()].filter((item) => item.target_app_device_id === deviceId).map((item) => structuredClone(item.payload)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))); }
  async paymentById(value) { const row = [...this.payments.values()].find((item) => item.payload.request_id === value); return row ? { request_id: value, ...structuredClone(row) } : null; }
  async paymentByIdForTenant(connection, value) { const merchantId = connection.merchant_id || connection.tenant_id; const row = this.payments.get(`${merchantId}:${value}`); return row && row.client_id === connection.client_id ? { request_id: value, ...structuredClone(row) } : null; }
  async listPaymentsForTenant(connection) { const merchantId = connection.merchant_id || connection.tenant_id; return [...this.payments.values()].filter((item) => item.payload.merchant_id === merchantId && item.client_id === connection.client_id).map((item) => structuredClone(item.payload)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))); }
  async paymentEventsForTenant(connection, cursor = "") { const merchantId = connection.merchant_id || connection.tenant_id; return edgeEventPage(await this.listPaymentsForTenant(connection), `merchant:${merchantId}:actor:${connection.client_id}`, cursor); }
  async paymentEventsForDevice(deviceId, cursor = "") { return edgeEventPage(await this.listPayments(deviceId), `wallet:${deviceId}`, cursor); }
  async findPaymentByTransactionHash(connection, transactionHash) { return (await this.listPaymentsForTenant(connection)).find((payment) => payment.tx_hash === transactionHash) || null; }
  async updatePayment(requestId, deviceId, status, patch, at) { const entry = [...this.payments.entries()].find(([, item]) => item.payload.request_id === requestId && item.target_app_device_id === deviceId); if (!entry) return null; const [key, row] = entry; if (row.payload.status === status) return { outcome: "duplicate", payment: structuredClone(row.payload) }; const scope = { merchant_id: row.payload.merchant_id, actor_id: `wallet:${deviceId}` }; const event = await edgePaymentEvent(scope, "payment_request.status", row.payload, { ...patch, status }, at); row.payload = { ...row.payload, status, updated_at: at, ...patch, event_history: [...(row.payload.event_history || []), event] }; this.payments.set(key, row); return { outcome: "updated", payment: structuredClone(row.payload) }; }
}

function invitationView(invitation) {
  return {
    connect_invitation_id: invitation.connect_invitation_id,
    status: invitation.status,
    agent_identity: invitation.agent_identity || null,
    identity_assurance: invitation.identity_assurance || null,
    requested_scopes: invitation.requested_scopes || [],
    pairing_session_id: invitation.pairing_session_id || null,
    connection_id: invitation.connection_id || null,
    created_at: invitation.created_at, updated_at: invitation.updated_at,
    claimed_at: invitation.claimed_at || null, approved_at: invitation.approved_at || null,
    connected_at: invitation.connected_at || null, rejected_at: invitation.rejected_at || null,
    cancelled_at: invitation.cancelled_at || null, expired_at: invitation.expired_at || null,
    expires_at: invitation.expires_at
  };
}

function pairingView(invitation) {
  return {
    pairing_session_id: invitation.pairing_session_id,
    pairing_code: "",
    pairing_uri: `velarumpay://pair?pairing_session_id=${encodeURIComponent(invitation.pairing_session_id)}`,
    agent_identity: invitation.agent_identity,
    identity_assurance: invitation.identity_assurance,
    requested_scopes: invitation.requested_scopes || [],
    connect_invitation_id: invitation.connect_invitation_id,
    status: invitation.status === "claimed" ? "pending" : invitation.status,
    created_at: invitation.claimed_at || invitation.created_at,
    updated_at: invitation.updated_at,
    expires_at: invitation.expires_at
  };
}

function connectionView(connection, token = "") {
  return {
    connection_id: connection.connection_id,
    ...(token ? { connection_token: token } : {}),
    pairing_session_id: connection.pairing_session_id,
    tenant_id: connection.tenant_id,
    client_id: connection.client_id,
    scopes: connection.scopes,
    approved_scopes: connection.scopes,
    agent_identity: connection.agent_identity,
    status: connection.status,
    created_at: connection.created_at,
    updated_at: connection.updated_at,
    last_activity_at: connection.updated_at,
    expires_at: connection.expires_at
  };
}

async function verifyDevice(store, deviceId, token) {
  return Boolean(deviceId && token && await store.verifyDevice(String(deviceId), await hash(String(token))));
}

async function controlledWebhookReceiver(request, env, route) {
  const config = CONTROLLED_WEBHOOK_RECEIVERS[route];
  if (!config) return null;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (method === "GET" && url.searchParams.get("velarumpay_challenge") === "1") {
    const challenge = String(env?.[config.challenge] || "").trim();
    return challenge ? json(200, { challenge }) : apiError(503, "webhook_receiver_unconfigured", "Webhook receiver ownership challenge is not configured");
  }
  if (method !== "POST") return apiError(405, "method_not_allowed", "Webhook receiver accepts POST deliveries only");
  const secret = String(env?.[config.secret] || "").trim();
  if (!secret) return apiError(503, "webhook_receiver_unconfigured", "Webhook receiver signing secret is not configured");
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > 256 * 1024) return apiError(413, "payload_too_large", "Webhook payload is too large");
  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > 256 * 1024) return apiError(413, "payload_too_large", "Webhook payload is too large");
  const signature = String(request.headers.get("x-velarumpay-signature") || "");
  const valid = await verifyControlledWebhookSignature(secret, rawBody, signature);
  let eventType = "";
  try { eventType = String(JSON.parse(new TextDecoder().decode(rawBody))?.type || "").slice(0, 120); } catch { /* signature result remains authoritative */ }
  console.info(JSON.stringify({
    level: valid ? "info" : "warn",
    event: "controlled_webhook.delivery",
    receiver: config.label,
    signature_valid: valid,
    event_id: String(request.headers.get("x-velarumpay-event-id") || "").slice(0, 160),
    delivery_id: String(request.headers.get("x-velarumpay-delivery-id") || "").slice(0, 160),
    event_type: eventType,
    payload_digest: await hash(rawBody),
    occurred_at: new Date().toISOString()
  }));
  return valid ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
    : apiError(401, "webhook_signature_invalid", "Webhook signature is invalid");
}

async function verifyControlledWebhookSignature(secret, rawBody, signatureHeader) {
  const parts = Object.fromEntries(String(signatureHeader || "").split(",").map((part) => {
    const [key, ...value] = part.trim().split("=");
    return [key, value.join("=")];
  }));
  if (!/^\d{10,16}$/.test(parts.t || "") || !/^[0-9a-f]{64}$/i.test(parts.v1 || "")) return false;
  if (Math.abs(Date.now() - Number(parts.t) * 1000) > 5 * 60_000) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const timestamp = new TextEncoder().encode(`${parts.t}.`);
  const payload = new Uint8Array(timestamp.byteLength + rawBody.byteLength);
  payload.set(timestamp);
  payload.set(rawBody, timestamp.byteLength);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
  const received = Uint8Array.from(parts.v1.match(/../g).map((value) => Number.parseInt(value, 16)));
  let difference = expected.byteLength ^ received.byteLength;
  for (let index = 0; index < Math.min(expected.byteLength, received.byteLength); index += 1) difference |= expected[index] ^ received[index];
  return difference === 0;
}

async function authenticateAgent(request, env, store) {
  const token = bearer(request, "x-agent-client-token");
  if (!TOKEN_PATTERN.test(token)) return null;
  return store.clientByTokenHash(await hash(token));
}

function canonicalEdgeIdentity(client) {
  return {
    binding_version: "velarum.connection_binding.v1",
    merchant_id: client.merchant_id || client.tenant_id,
    tenant_id: client.tenant_id,
    agent_id: client.agent_id || client.client_id,
    client_id: client.client_id,
    credential_id: client.credential_id || `registered_client:${client.client_id}`,
    audience: "velarumpay-platform-api",
    agent_name: client.display_name,
    runtime: client.runtime,
    source: client.source_domain,
    verified: true
  };
}

async function connectionAuth(store, request, requiredScope, fallback = "") {
  if (new URL(request.url).searchParams.has("connection_token")) {
    return { error: apiError(400, "token_transport_forbidden", "Connection tokens are not accepted in URL queries") };
  }
  const token = bearer(request) || fallback;
  if (!token) return { error: apiError(401, "unauthorized_connection", "Connection token is required") };
  const connection = await store.connectionByTokenHash(await hash(token));
  if (!connection || connection.status !== "active") return { error: apiError(401, "unauthorized_connection", "Connection token is invalid or inactive") };
  const identity = connection.agent_identity || {};
  if (identity.binding_version === "velarum.connection_binding.v1"
      && (identity.merchant_id !== connection.tenant_id || identity.client_id !== connection.client_id
        || !identity.agent_id || !identity.credential_id || identity.audience !== "velarumpay-platform-api"
        || identity.approved_by_device_id !== connection.target_app_device_id
        || identity.connection_id !== connection.connection_id)) {
    return { error: apiError(401, "unauthorized_connection", "Connection token binding is invalid") };
  }
  if (connection.expires_at && connection.expires_at <= new Date().toISOString()) return { error: apiError(401, "unauthorized_connection", "Connection token expired") };
  if (!connection.scopes.includes(requiredScope)) return { error: apiError(403, "scope_denied", `Missing required scope: ${requiredScope}`) };
  return { connection };
}

async function handle(request, env, store) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === "GET" && path === "/") return json(200, { ok: true, service: "VelarumPay Connect Platform", environment: "testnet", api: "/v1" });
  if (method === "GET" && path === "/health") return json(200, { ok: true, service: "velarumpay-connect-platform", environment: "testnet", persistence: env.DB ? "d1" : "memory", multi_tenant: true, agent_identity: "registered" });

  const controlledReceiver = await controlledWebhookReceiver(request, env, path);
  if (controlledReceiver) return controlledReceiver;

  if (method === "POST" && path === "/v1/admin/agent-clients") {
    if (!env.PLATFORM_ADMIN_TOKEN || !await sameSecret(bearer(request), env.PLATFORM_ADMIN_TOKEN)) return apiError(401, "admin_auth_required", "Platform administrator authentication is required");
    const payload = await body(request);
    const tenantId = String(payload.tenant_id || "").trim().toLowerCase();
    const tenantName = String(payload.tenant_name || payload.display_name || "").trim();
    const displayName = String(payload.agent_name || payload.display_name || "").trim();
    const runtime = String(payload.runtime || "external").trim();
    const sourceDomain = String(payload.source_domain || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(tenantId) || !tenantName || !displayName || !sourceDomain) return apiError(400, "invalid_agent_client", "tenant_id, tenant_name, agent_name, and source_domain are required");
    const clientToken = randomToken("agent");
    const at = new Date().toISOString();
    const clientId = id("client");
    await store.createClient({ tenant_id: tenantId, tenant_name: tenantName.slice(0, 120), client_id: clientId, display_name: displayName.slice(0, 120), runtime: runtime.slice(0, 80), source_domain: sourceDomain.slice(0, 160), token_hash: await hash(clientToken), at });
    return json(201, { ok: true, agent_client: { client_id: clientId, tenant_id: tenantId, display_name: displayName, runtime, source_domain: sourceDomain, status: "active" }, client_token: clientToken });
  }

  if (method === "POST" && path === "/v1/devices/app") {
    const payload = await body(request);
    const deviceId = String(payload.device_id || "").trim();
    const token = String(payload.token || "").trim();
    if (!deviceId || !TOKEN_PATTERN.test(token)) return apiError(400, "invalid_app_device_registration", "device_id and a valid token are required");
    const device = await store.registerDevice(deviceId, await hash(token), new Date().toISOString());
    if (device.conflict) return apiError(409, "app_device_exists", "App device already registered with different credentials");
    return json(200, { ok: true, device });
  }

  const pushMatch = path.match(/^\/v1\/devices\/app\/([^/]+)\/push-token$/);
  if (pushMatch && ["PUT", "DELETE"].includes(method)) {
    const payload = await body(request);
    const deviceId = decodeURIComponent(pushMatch[1]);
    if (deviceId !== String(payload.device_id || "") || !await verifyDevice(store, deviceId, payload.token)) return apiError(401, "invalid_app_device_token", "Invalid app device token");
    return json(202, { ok: true, push: { provider: "fcm", status: "not_configured", rest_sync_required: true } });
  }

  if (method === "POST" && path === "/v1/connect-invitations") {
    const payload = await body(request);
    const deviceId = String(payload.device_id || "").trim();
    if (!await verifyDevice(store, deviceId, payload.token)) return apiError(401, "invalid_app_device_token", "Invalid app device token");
    const ttl = Number(payload.expires_in_seconds || 300);
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 600) return apiError(400, "invalid_expiration", "expires_in_seconds must be between 60 and 600");
    const key = `velarumpay-connect:${randomToken("ck")}`;
    const at = new Date().toISOString();
    const invitation = await store.createInvitation({ connect_invitation_id: id("cinv"), connect_key_hash: await hash(key), target_app_device_id: deviceId, created_at: at, updated_at: at, expires_at: new Date(Date.now() + ttl * 1000).toISOString() });
    return json(201, { ok: true, connect_key: key, connect_invitation: invitationView(invitation) });
  }

  if (method === "POST" && path === "/v1/connect-invitations/claim") {
    const client = await authenticateAgent(request, env, store);
    if (!client) return apiError(401, "agent_client_auth_required", "A registered Agent client token is required");
    const payload = await body(request);
    if (["merchant_id", "tenant_id", "agent_id", "client_id", "credential_id", "agent_identity", "agent"]
      .some((field) => Object.hasOwn(payload, field))) {
      return apiError(400, "self_declared_identity_forbidden", "Connect claim identity must come from Agent authentication");
    }
    if (Object.keys(payload).some((field) => !["connect_key", "requested_scopes"].includes(field))) {
      return apiError(400, "invalid_request", "Connect claim contains an unsupported field");
    }
    const key = String(payload.connect_key || "").trim();
    if (!CONNECT_KEY_PATTERN.test(key)) return apiError(409, "connect_key_unavailable", "Connect Key is invalid, expired, or already used");
    const requestedScopes = scopes(payload.requested_scopes);
    if (!requestedScopes) return apiError(400, "unsupported_scope", "One or more requested scopes are unsupported");
    const claimToken = randomToken("claim");
    const at = new Date().toISOString();
    const invitation = await store.claimInvitation(await hash(key), await hash(claimToken), client, requestedScopes, id("pair"), at);
    if (!invitation) return apiError(409, "connect_key_unavailable", "Connect Key is invalid, expired, or already used");
    return json(201, { ok: true, claim_token: claimToken, connect_invitation: invitationView(invitation), pairing_session: pairingView(invitation), identity: { assurance: "registered", tenant_id: client.tenant_id, client_id: client.client_id } });
  }

  const invitationMatch = path.match(/^\/v1\/connect-invitations\/([^/]+)$/);
  if (invitationMatch && method === "GET") {
    let invitation = await store.invitationById(decodeURIComponent(invitationMatch[1]));
    if (!invitation) return apiError(404, "connect_invitation_not_found", "Connect Invitation not found");
    const deviceId = url.searchParams.get("device_id") || "";
    const token = url.searchParams.get("token") || "";
    if (deviceId || token) {
      if (invitation.target_app_device_id !== deviceId || !await verifyDevice(store, deviceId, token)) return apiError(404, "connect_invitation_not_found", "Connect Invitation not found");
    } else {
      const claimToken = bearer(request, "x-connect-claim-token");
      if (!claimToken || invitation.claim_token_hash !== await hash(claimToken)) return apiError(404, "connect_invitation_not_found", "Connect Invitation not found");
    }
    invitation = await store.expireInvitation(invitation, new Date().toISOString());
    return json(200, { ok: true, connect_invitation: invitationView(invitation) });
  }

  if (invitationMatch && method === "DELETE") {
    const payload = await body(request);
    const invitationId = decodeURIComponent(invitationMatch[1]);
    const invitation = await store.invitationById(invitationId);
    if (!invitation || invitation.target_app_device_id !== String(payload.device_id || "") || !await verifyDevice(store, payload.device_id, payload.token)) return apiError(404, "connect_invitation_not_found", "Connect Invitation not found");
    const cancelled = await store.cancelInvitation(invitationId, invitation.target_app_device_id, new Date().toISOString());
    if (!cancelled) return apiError(409, "connect_invitation_not_cancellable", "Connect Invitation can no longer be cancelled");
    return json(200, { ok: true, connect_invitation: invitationView(cancelled) });
  }

  const exchangeMatch = path.match(/^\/v1\/connect-invitations\/([^/]+)\/exchange$/);
  if (exchangeMatch && method === "POST") {
    const claimToken = bearer(request, "x-connect-claim-token");
    let invitation = claimToken ? await store.invitationByClaimHash(await hash(claimToken)) : null;
    if (!invitation || invitation.connect_invitation_id !== decodeURIComponent(exchangeMatch[1])) return apiError(401, "invalid_connect_claim_token", "Connect claim token is invalid");
    invitation = await store.expireInvitation(invitation, new Date().toISOString());
    if (invitation.status === "claimed") return apiError(409, "connect_invitation_pending", "Connect Invitation is awaiting wallet approval");
    if (invitation.status === "expired") return apiError(410, "connect_invitation_expired", "Connect Invitation expired");
    if (["rejected", "cancelled"].includes(invitation.status)) return apiError(409, "connect_invitation_not_approved", "Connect Invitation was not approved", { status: invitation.status });
    const connectionToken = randomToken("conn");
    const exchanged = await store.exchangeInvitation(invitation, await hash(connectionToken), new Date().toISOString());
    if (!exchanged) return apiError(409, "connect_invitation_not_exchangeable", "Connect Invitation cannot be exchanged");
    return json(200, { ok: true, connect_invitation: invitationView(exchanged.invitation), connection: connectionView(exchanged.connection, connectionToken) });
  }

  const pairingMatch = path.match(/^\/v1\/pairing\/sessions\/([^/]+)$/);
  if (pairingMatch && method === "GET") {
    let invitation = await store.invitationByPairingId(decodeURIComponent(pairingMatch[1]));
    if (!invitation) return apiError(404, "pairing_session_not_found", "Pairing session not found");
    invitation = await store.expireInvitation(invitation, new Date().toISOString());
    return json(200, { ok: true, pairing_session: pairingView(invitation) });
  }

  const pairingAction = path.match(/^\/v1\/pairing\/sessions\/([^/]+)\/(approve|reject)$/);
  if (pairingAction && method === "POST") {
    const payload = await body(request);
    const invitation = await store.invitationByPairingId(decodeURIComponent(pairingAction[1]));
    if (!invitation || invitation.target_app_device_id !== String(payload.device_id || "") || !await verifyDevice(store, payload.device_id, payload.token)) return apiError(403, "pairing_target_mismatch", "Pairing session belongs to another wallet");
    if (invitation.status !== "claimed") return apiError(409, "pairing_session_closed", "Pairing session is no longer pending");
    const at = new Date().toISOString();
    if (pairingAction[2] === "reject") return json(200, { ok: true, pairing_session: pairingView(await store.rejectInvitation(invitation, at)) });
    const approvedScopes = scopes(payload.approved_scopes, []);
    if (!approvedScopes || approvedScopes.some((scope) => !invitation.requested_scopes.includes(scope))) return apiError(400, "invalid_approved_scopes", "Approved scopes must be a non-empty subset of requested scopes");
    const approved = await store.approveInvitation(invitation, approvedScopes, id("conn"), at, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());
    if (!approved) return apiError(409, "pairing_session_closed", "Pairing session is no longer pending");
    return json(201, { ok: true, pairing_session: pairingView(approved.invitation), connection: connectionView(approved.connection) });
  }

  if (method === "GET" && path === "/v1/connections") {
    const deviceId = url.searchParams.get("device_id") || "";
    if (!await verifyDevice(store, deviceId, url.searchParams.get("token") || "")) return apiError(401, "invalid_app_device_token", "Invalid app device token");
    return json(200, { ok: true, items: (await store.listConnections(deviceId)).map((item) => connectionView(item)) });
  }

  const connectionMatch = path.match(/^\/v1\/connections\/([^/]+)$/);
  if (connectionMatch && ["PATCH", "DELETE"].includes(method)) {
    const payload = await body(request);
    const deviceId = String(payload.device_id || "");
    if (!await verifyDevice(store, deviceId, payload.token)) return apiError(401, "invalid_app_device_token", "Invalid app device token");
    const status = method === "DELETE" ? "revoked" : String(payload.status || "");
    if (!["active", "paused", "revoked"].includes(status)) return apiError(400, "invalid_connection_status", "Connection status must be active, paused, or revoked");
    const connection = await store.updateConnection(decodeURIComponent(connectionMatch[1]), deviceId, status, new Date().toISOString());
    if (!connection) return apiError(404, "connection_not_found", "Connection not found");
    return json(200, { ok: true, connection: connectionView(connection) });
  }

  if (method === "POST" && path === "/v1/transaction-contexts") {
    const payload = await body(request);
    const auth = await connectionAuth(store, request, "transaction_contexts.create", String(payload.connection_token || ""));
    if (auth.error) return auth.error;
    if (payload.protocol !== "velarum.transaction_context.v1" || !payload.transaction_id) return apiError(400, "invalid_transaction_context", "A valid velarum.transaction_context.v1 payload is required");
    payload.connection_id = auth.connection.connection_id;
    return json(201, { ok: true, context: await store.upsertContext(auth.connection, payload, new Date().toISOString()) });
  }

  if (method === "POST" && path === "/v1/payment-requests") {
    const payload = await body(request);
    const auth = await connectionAuth(store, request, "payment.requests.create", String(payload.connection_token || ""));
    if (auth.error) return auth.error;
    if (payload.protocol !== "velarum.payment_request.v1" || !payload.request_id || !payload.idempotency_key || payload.policy?.requires_user_approval !== true) return apiError(400, "invalid_payment_request", "A valid user-approved velarum.payment_request.v1 payload is required");
    if (payload.payment?.network !== "stellar_testnet" || payload.payment?.rail !== "stellar_xlm" || payload.payment?.stellar_testnet !== true) return apiError(400, "testnet_only", "This Platform build accepts Stellar testnet Payment Requests only");
    if (!/^\d+(?:\.\d{1,7})?$/.test(String(payload.payment?.amount || "")) || Number(payload.payment.amount) <= 0) return apiError(400, "invalid_amount", "Payment amount must be a positive decimal");
    payload.connection_id = auth.connection.connection_id;
    payload.status = "pending";
    const created = await store.createPaymentScoped(auth.connection, payload, new Date().toISOString());
    if (created.outcome === "conflict") return apiError(409, "idempotency_conflict", "Idempotency key was already used with a different canonical Payment Request");
    return json(created.outcome === "duplicate" ? 200 : 201, {
      ok: true,
      ...(created.outcome === "duplicate" ? { duplicate: true } : {}),
      payment_request: created.payment,
      warnings: created.payment.risk?.warnings || []
    });
  }

  if (method === "GET" && path === "/v1/payment-requests/events") {
    if (bearer(request)) {
      const auth = await connectionAuth(store, request, "payment.requests.read");
      if (auth.error) return auth.error;
      const page = await store.paymentEventsForTenant(auth.connection, url.searchParams.get("cursor") || "");
      return json(200, { ok: true, ...page });
    }
    const deviceId = String(request.headers.get("x-app-device-id") || "");
    const token = String(request.headers.get("x-app-device-token") || "");
    if (!await verifyDevice(store, deviceId, token)) return apiError(401, "invalid_app_device_token", "Invalid app device token");
    const page = await store.paymentEventsForDevice(deviceId, url.searchParams.get("cursor") || "");
    return json(200, { ok: true, ...page });
  }

  if (method === "GET" && path === "/v1/payment-requests") {
    if (bearer(request)) {
      const auth = await connectionAuth(store, request, "payment.requests.read");
      if (auth.error) return auth.error;
      return json(200, { ok: true, items: await store.listPaymentsForTenant(auth.connection) });
    }
    const deviceId = url.searchParams.get("device_id") || "";
    if (!await verifyDevice(store, deviceId, url.searchParams.get("token") || "")) return apiError(401, "invalid_app_device_token", "Invalid app device token");
    return json(200, { ok: true, items: await store.listPayments(deviceId) });
  }

  const paymentStatusMatch = path.match(/^\/v1\/payment-requests\/([^/]+)\/status$/);
  if (paymentStatusMatch && method === "POST") {
    const payload = await body(request);
    const deviceId = String(payload.device_id || "");
    if (!await verifyDevice(store, deviceId, payload.token)) return apiError(401, "invalid_app_device_token", "Invalid app device token");
    const requestId = decodeURIComponent(paymentStatusMatch[1]);
    const current = await store.paymentById(requestId);
    if (!current || current.target_app_device_id !== deviceId) return apiError(404, "payment_request_not_found", "Payment Request not found");
    const nextStatus = String(payload.status || "").toLowerCase();
    const currentStatus = String(current.payload.status || "pending").toLowerCase();
    const transition = edgePaymentTransition(current.payload, nextStatus);
    if (!transition.ok) return apiError(transition.status, transition.code, transition.message);
    if (transition.duplicate) return json(200, { ok: true, duplicate: true, payment_request: current.payload });
    const updated = await store.updatePayment(requestId, deviceId, nextStatus, { ...(payload.tx_hash ? { tx_hash: String(payload.tx_hash) } : {}), ...(payload.error ? { error: String(payload.error) } : {}) }, new Date().toISOString());
    return json(200, { ok: true, ...(updated.outcome === "duplicate" ? { duplicate: true } : {}), payment_request: updated.payment });
  }

  const paymentMatch = path.match(/^\/v1\/payment-requests\/([^/]+)$/);
  if (paymentMatch && method === "GET") {
    if (bearer(request)) {
      const auth = await connectionAuth(store, request, "payment.requests.read");
      if (auth.error) return auth.error;
      const payment = await store.paymentByIdForTenant(auth.connection, decodeURIComponent(paymentMatch[1]));
      if (!payment) return apiError(404, "payment_request_not_found", "Payment Request not found");
      return json(200, { ok: true, payment_request: payment.payload });
    }
    const deviceId = url.searchParams.get("device_id") || String(request.headers.get("x-app-device-id") || "");
    const token = url.searchParams.get("token") || String(request.headers.get("x-app-device-token") || "");
    if (!await verifyDevice(store, deviceId, token)) return apiError(401, "invalid_app_device_token", "Invalid app device token");
    const payment = await store.paymentById(decodeURIComponent(paymentMatch[1]));
    if (!payment || payment.target_app_device_id !== deviceId) return apiError(404, "payment_request_not_found", "Payment Request not found");
    return json(200, { ok: true, payment_request: payment.payload });
  }

  return apiError(404, "not_found", "Route not found");
}

export function createTestWorker(environment = {}) {
  const store = new MemoryStore();
  return { fetch: (request) => handle(request, environment, store) };
}

export { D1Store, MemoryStore, edgePaymentTransition, edgeWebhookDeliveryDecision };

export default {
  async fetch(request, env = {}) {
    if (!env.DB) return apiError(503, "database_unavailable", "Connect Platform database is unavailable");
    try {
      return await handle(request, env, new D1Store(env.DB));
    }
    catch (error) {
      console.error(JSON.stringify({ level: "error", event: "connect_platform_request_failed", code: error.code || "internal_error", path: new URL(request.url).pathname }));
      return apiError(error.status || 500, error.code || "internal_error", error.status && error.status < 500 ? error.message : "The Connect Platform could not complete this request");
    }
  }
};
