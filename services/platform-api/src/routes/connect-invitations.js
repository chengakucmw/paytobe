// Wallet-created, one-time Connect Invitation routes.
// Mounted at "/v1/connect-invitations".

import express from "express";
import { authenticatedConnectClaim } from "../application/connect/claim.js";
import { connectIdentityReview } from "../application/connections/binding.js";
import { createTenantScope } from "../ports/tenant-repository.js";
import {
  connectInvitationResponse,
  connectionPublicResponse,
  connectionResponse,
  pairingSessionResponse
} from "../domain/projections.js";
import {
  normalizeAgentIdentity,
  normalizeApprovedScopes,
  normalizePairingTtl,
  normalizeRequestedScopes
} from "../domain/scopes.js";

const CONNECT_KEY_PATTERN = /^Paytobe-connect:ck_[A-Za-z0-9_-]{43}$/;
const DEFAULT_CONNECTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function claimTokenFromRequest(req) {
  const authorization = req.get("authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return String(req.get("x-connect-claim-token") || "").trim();
}

function ownedInvitation(store, invitationId, deviceId) {
  const invitation = store.connectInvitation(invitationId);
  if (!invitation || invitation.target_app_device_id !== deviceId) return null;
  return invitation;
}

export function createConnectInvitationsRouter(deps) {
  const {
    store,
    observability,
    sendApiError,
    verifyAppBody,
    verifyAppQuery,
    verifyAgentAccessToken,
    agentService,
    notifyApp,
    pushService,
    platformCore
  } = deps;
  const router = express.Router();

  router.get("/", (req, res) => {
    store.expireConnectInvitations();
    const deviceId = String(req.get("x-app-device-id") || "").trim();
    const deviceToken = String(req.get("x-app-device-token") || "").trim();
    const auth = verifyAppBody({ body: { device_id: deviceId, token: deviceToken } });
    if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
    const items = store.listConnectInvitationsForDevice(deviceId)
      .slice(0, 20)
      .map((invitation) => connectInvitationResponse(invitation, connectIdentityReview(store, invitation)));
    return res.json({ ok: true, items });
  });

  router.post("/", (req, res) => {
    const auth = verifyAppBody(req);
    if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
    const ttl = normalizePairingTtl(req.body?.expires_in_seconds);
    if (!ttl.ok) {
      return sendApiError(res, 400, "invalid_expiration", ttl.error, { field: "expires_in_seconds" });
    }

    const connectKey = platformCore.random.connectKey();
    const invitation = store.createConnectInvitation(platformCore.random.id("cinv"), connectKey, {
      target_app_device_id: req.body.device_id,
      expires_at: platformCore.clock.after(ttl.seconds * 1000)
    });
    if (!invitation) {
      return sendApiError(res, 503, "connect_key_unavailable", "Could not allocate a Connect Key, please retry");
    }
    observability.recordAuditEvent("connect_invitation.created", "success", {
      actor: { type: "wallet_device", id: req.body.device_id },
      resource: { type: "connect_invitation", id: invitation.connect_invitation_id },
      labels: { status: invitation.status },
      details: { expires_at: invitation.expires_at }
    });
    observability.incrementCounter("Paytobe_connect_invitations_total", { result: "created" });
    res.status(201).json({
      ok: true,
      connect_key: invitation.connect_key,
      connect_invitation: connectInvitationResponse(invitation, connectIdentityReview(store, invitation))
    });
  });

  router.post("/claim", async (req, res, next) => {
    store.expireConnectInvitations();
    const auth = verifyAgentAccessToken(req);
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    const connectKey = String(req.body?.connect_key || "").trim();
    if (!CONNECT_KEY_PATTERN.test(connectKey)) {
      return sendApiError(res, 409, "connect_key_unavailable", "Connect Key is invalid, expired, or already used");
    }
    try {
      const found = await agentService.get(createTenantScope(auth.auth_context), auth.auth_context.agent_id);
      const claim = authenticatedConnectClaim(auth.auth_context, found.ok ? found.agent : null, req.body || {}, auth.token || {});
      if (!claim.ok) return sendApiError(res, claim.status, claim.code, claim.message, { field: claim.field });
      return completeClaim({ req, res, connectKey, agent: claim.agent_identity, scopes: claim.scopes,
        identityAssurance: "registered", binding: claim.binding });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/claim/legacy", (req, res) => {
    store.expireConnectInvitations();
    const connectKey = String(req.body?.connect_key || "").trim();
    if (!CONNECT_KEY_PATTERN.test(connectKey)) {
      return sendApiError(res, 409, "connect_key_unavailable", "Connect Key is invalid, expired, or already used");
    }
    const agent = normalizeAgentIdentity(req.body?.agent_identity || req.body?.agent || {});
    if (!agent.ok) return sendApiError(res, 400, "invalid_agent_identity", agent.error, { field: agent.field });
    const scopes = normalizeRequestedScopes(req.body?.requested_scopes);
    if (!scopes.ok) return sendApiError(res, 400, scopes.code, scopes.error, { field: "requested_scopes" });
    observability.recordAuditEvent("legacy_connect_claim.used", "warning", {
      actor: { type: "self_declared_agent", id: agent.value.agent_id },
      resource: { type: "http_route", id: "/v1/connect-invitations/claim/legacy" },
      labels: { deprecated: "true" },
      details: {}
    });
    return completeClaim({ req, res, connectKey, agent: agent.value, scopes, identityAssurance: "unverified", binding: null,
      warnings: [{ code: "legacy_connect_claim_deprecated", message: "Self-declared Connect claim is deprecated and grants no approval or signing authority", details: {} }] });
  });

  function completeClaim({ res, connectKey, agent, scopes, identityAssurance, binding, warnings = [] }) {
    const claimToken = platformCore.random.opaqueToken("claim_tok");
    const claimed = store.claimConnectInvitationAndCreatePairingSession(connectKey, claimToken, platformCore.random.id("pair"), {
      agent_identity: agent,
      identity_assurance: identityAssurance,
      requested_scopes: scopes.value,
      auth_binding: binding
    });
    if (!claimed) return sendApiError(res, 409, "connect_key_unavailable", "Connect Key is invalid, expired, or already used");
    notifyApp(claimed.connect_invitation.target_app_device_id, {
      type: "connect_invitation.claimed",
      connect_invitation_id: claimed.connect_invitation.connect_invitation_id,
      pairing_session_id: claimed.pairing_session.pairing_session_id,
      status: claimed.connect_invitation.status
    });
    pushService?.notifyConnectInvitation(claimed.connect_invitation.target_app_device_id, {
      event_id: claimed.connect_invitation.connect_invitation_id
    });
    observability.recordAuditEvent("connect_invitation.claimed", "success", {
      actor: { type: "agent", id: agent.agent_id, name: agent.agent_name },
      resource: { type: "connect_invitation", id: claimed.connect_invitation.connect_invitation_id },
      labels: { status: claimed.connect_invitation.status, identity_assurance: identityAssurance },
      details: { requested_scope_count: scopes.value.length }
    });
    observability.incrementCounter("Paytobe_connect_invitations_total", { result: "claimed" });
    return res.status(201).json({
      ok: true,
      claim_token: claimed.claim_token,
      connect_invitation: connectInvitationResponse(claimed.connect_invitation, connectIdentityReview(store, claimed.connect_invitation)),
      pairing_session: pairingSessionResponse(claimed.pairing_session),
      warnings: [...scopes.warnings, ...warnings]
    });
  }

  router.get("/:id", (req, res) => {
    store.expireConnectInvitations();
    let invitation = null;
    const headerDeviceId = String(req.get("x-app-device-id") || "").trim();
    const headerDeviceToken = String(req.get("x-app-device-token") || "").trim();
    if (headerDeviceId || headerDeviceToken) {
      const auth = verifyAppBody({ body: { device_id: headerDeviceId, token: headerDeviceToken } });
      if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
      invitation = ownedInvitation(store, req.params.id, headerDeviceId);
    } else if (req.query.device_id || req.query.token) {
      const auth = verifyAppQuery(req);
      if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
      invitation = ownedInvitation(store, req.params.id, req.query.device_id);
    } else {
      const claimToken = claimTokenFromRequest(req);
      const claimedInvitation = store.connectInvitationByClaimToken(claimToken);
      if (claimedInvitation?.connect_invitation_id === req.params.id) invitation = claimedInvitation;
    }
    if (!invitation) return sendApiError(res, 404, "connect_invitation_not_found", "Connect Invitation not found");
    res.json({ ok: true, connect_invitation: connectInvitationResponse(invitation, connectIdentityReview(store, invitation)) });
  });

  router.post("/:id/approve", (req, res) => {
    const auth = verifyAppBody(req);
    if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
    if (Object.keys(req.body || {}).some((field) => !["device_id", "token"].includes(field))) {
      return sendApiError(res, 400, "invalid_request", "Connect approval accepts invitation ID and device authentication only");
    }
    store.expireConnectInvitations();
    store.expirePairingSessions();
    const invitation = ownedInvitation(store, req.params.id, req.body.device_id);
    if (!invitation) return sendApiError(res, 404, "connect_invitation_not_found", "Connect Invitation not found");
    if (invitation.status !== "claimed") {
      const status = invitation.status === "expired" ? 410 : 409;
      return sendApiError(res, status, "connect_invitation_not_pending", "Connect Invitation is not awaiting approval", {
        details: { status: invitation.status }
      });
    }
    const session = store.pairingSession(invitation.pairing_session_id);
    if (!session || session.status !== "pending" || session.target_app_device_id !== req.body.device_id) {
      return sendApiError(res, 409, "connect_facts_mismatch", "Connect review facts no longer match");
    }
    const review = connectIdentityReview(store, session);
    if (!review.approval_allowed) {
      return sendApiError(res, 409, "connect_identity_not_approvable", "Merchant or Agent identity cannot be approved", {
        details: { state: review.state, reason_code: review.reason_code }
      });
    }
    const scopes = normalizeApprovedScopes(session.requested_scopes, session.requested_scopes);
    if (!scopes.ok) return sendApiError(res, scopes.status || 400, scopes.code, scopes.error, { field: "requested_scopes" });
    const connection = store.createConnection(platformCore.random.id("conn"), platformCore.random.opaqueToken("conn_tok", 32), {
      pairing_session_id: session.pairing_session_id,
      agent_identity: session.agent_identity,
      auth_binding: session.auth_binding,
      scopes: scopes.value,
      approved_by_device_id: req.body.device_id,
      expires_at: platformCore.clock.after(DEFAULT_CONNECTION_TTL_MS)
    });
    const approvedAt = platformCore.clock.nowIso();
    store.updatePairingSession(session.pairing_session_id, {
      status: "approved", approved_at: approvedAt, approved_scopes: scopes.value, connection_id: connection.connection_id
    });
    const approved = store.updateConnectInvitation(invitation.connect_invitation_id, {
      status: "approved", approved_at: approvedAt, approved_scopes: scopes.value, connection_id: connection.connection_id
    });
    observability.recordAuditEvent("connect_invitation.approved", "success", {
      actor: { type: "wallet_device", id: req.body.device_id },
      resource: { type: "connect_invitation", id: invitation.connect_invitation_id },
      labels: { status: "approved", identity_state: review.state },
      details: { connection_id: connection.connection_id, approved_scope_count: scopes.value.length }
    });
    observability.incrementCounter("Paytobe_connect_invitations_total", { result: "approved" });
    return res.status(201).json({
      ok: true,
      connect_invitation: connectInvitationResponse(approved, connectIdentityReview(store, approved)),
      connection: connectionPublicResponse(connection)
    });
  });

  router.post("/:id/reject", (req, res) => {
    const auth = verifyAppBody(req);
    if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
    if (Object.keys(req.body || {}).some((field) => !["device_id", "token"].includes(field))) {
      return sendApiError(res, 400, "invalid_request", "Connect rejection accepts invitation ID and device authentication only");
    }
    store.expireConnectInvitations();
    const invitation = ownedInvitation(store, req.params.id, req.body.device_id);
    if (!invitation) return sendApiError(res, 404, "connect_invitation_not_found", "Connect Invitation not found");
    if (invitation.status !== "claimed") {
      return sendApiError(res, invitation.status === "expired" ? 410 : 409,
        "connect_invitation_not_pending", "Connect Invitation is not awaiting rejection");
    }
    const rejectedAt = platformCore.clock.nowIso();
    const session = store.pairingSession(invitation.pairing_session_id);
    if (session?.status === "pending") {
      store.updatePairingSession(session.pairing_session_id, {
        status: "rejected", rejected_at: rejectedAt, rejected_by_device_id: req.body.device_id
      });
    }
    const rejected = store.updateConnectInvitation(invitation.connect_invitation_id, {
      status: "rejected", rejected_at: rejectedAt, rejected_by_device_id: req.body.device_id
    });
    observability.recordAuditEvent("connect_invitation.rejected", "success", {
      actor: { type: "wallet_device", id: req.body.device_id },
      resource: { type: "connect_invitation", id: invitation.connect_invitation_id },
      labels: { status: "rejected" }, details: {}
    });
    return res.json({ ok: true, connect_invitation: connectInvitationResponse(rejected, connectIdentityReview(store, rejected)) });
  });

  router.delete("/:id", (req, res) => {
    const auth = verifyAppBody(req);
    if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
    const invitation = ownedInvitation(store, req.params.id, req.body.device_id);
    if (!invitation) return sendApiError(res, 404, "connect_invitation_not_found", "Connect Invitation not found");
    if (!["waiting", "claimed"].includes(invitation.status)) {
      return sendApiError(res, 409, "connect_invitation_not_cancellable", "Connect Invitation can no longer be cancelled", {
        details: { status: invitation.status }
      });
    }
    const cancelled = store.cancelConnectInvitation(invitation.connect_invitation_id, req.body.device_id);
    if (cancelled?.unchanged) {
      return sendApiError(res, 409, "connect_invitation_not_cancellable", "Connect Invitation can no longer be cancelled", {
        details: { status: cancelled.status }
      });
    }
    observability.recordAuditEvent("connect_invitation.cancelled", "success", {
      actor: { type: "wallet_device", id: req.body.device_id },
      resource: { type: "connect_invitation", id: cancelled.connect_invitation_id },
      labels: { status: cancelled.status }
    });
    res.json({ ok: true, connect_invitation: connectInvitationResponse(cancelled, connectIdentityReview(store, cancelled)) });
  });

  router.post("/:id/exchange", (req, res) => {
    store.expireConnectInvitations();
    const claimToken = claimTokenFromRequest(req);
    const invitation = store.connectInvitationByClaimToken(claimToken);
    if (!invitation || invitation.connect_invitation_id !== req.params.id) {
      return sendApiError(res, 401, "invalid_connect_claim_token", "Connect claim token is invalid");
    }
    if (invitation.status === "expired") {
      return sendApiError(res, 410, "connect_invitation_expired", "Connect Invitation expired");
    }
    if (invitation.status === "rejected" || invitation.status === "cancelled") {
      return sendApiError(res, 409, "connect_invitation_not_approved", "Connect Invitation was not approved", {
        details: { status: invitation.status }
      });
    }
    if (invitation.status === "claimed") {
      return sendApiError(res, 409, "connect_invitation_pending", "Connect Invitation is awaiting wallet approval");
    }
    if (!["approved", "connected"].includes(invitation.status) || !invitation.connection_id) {
      return sendApiError(res, 409, "connect_invitation_not_exchangeable", "Connect Invitation cannot be exchanged");
    }
    const connection = store.connection(invitation.connection_id);
    if (!connection || connection.status !== "active") {
      return sendApiError(res, 409, "connection_not_active", "Connection is not active");
    }

    const exchangedAt = platformCore.clock.nowIso();
    const rotated = store.rotateConnectionToken(connection.connection_id, platformCore.random.opaqueToken("conn_tok"));
    const connected = store.updateConnectInvitation(invitation.connect_invitation_id, {
      status: "connected",
      connected_at: invitation.connected_at || exchangedAt,
      last_exchanged_at: exchangedAt,
      exchange_count: Number(invitation.exchange_count || 0) + 1
    });
    observability.recordAuditEvent("connect_invitation.exchanged", "success", {
      actor: { type: "agent", id: connected.agent_identity?.agent_id || "" },
      resource: { type: "connect_invitation", id: connected.connect_invitation_id },
      labels: { status: connected.status },
      details: { connection_id: rotated.connection_id, exchange_count: connected.exchange_count }
    });
    observability.incrementCounter("Paytobe_connect_invitations_total", { result: "connected" });
    res.json({
      ok: true,
      connect_invitation: connectInvitationResponse(connected, connectIdentityReview(store, connected)),
      connection: connectionResponse(rotated)
    });
  });

  return router;
}
