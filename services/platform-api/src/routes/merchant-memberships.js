import express from "express";
import { createTenantScope } from "../ports/tenant-repository.js";

export function createMerchantMembershipsRouter(deps) {
  const { merchantMembershipService, verifyMerchantSession, requireMerchantStepUp, sendApiError, observability } = deps;
  const router = express.Router();

  router.post("/merchants/:merchantId/membership-invitations", (req, res, next) => {
    const auth = verifyMerchantSession(req, { csrf: true });
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (auth.auth_context.merchant_id !== req.params.merchantId) return sendApiError(res, 404, "resource_not_found", "Resource not found");
    try {
      const result = merchantMembershipService.invite(createTenantScope(auth.auth_context), actor(auth), req.body || {});
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      observability.recordAuditEvent("merchant_membership.invited", "success", {
        actor: { type: "merchant_account", id: auth.auth_context.actor_id },
        resource: { type: "membership_invitation", id: result.invitation.invitation_id }
      });
      return res.status(201).json(result);
    } catch (error) {
      if (error instanceof TypeError) return sendApiError(res, 400, "invalid_request", error.message);
      return next(error);
    }
  });

  router.post("/merchant-membership-invitations/accept", (req, res, next) => {
    try {
      const result = merchantMembershipService.accept(req.body || {});
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      return res.status(201).json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.get("/merchants/:merchantId/memberships", (req, res) => {
    const auth = verifyMerchantSession(req);
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (auth.auth_context.merchant_id !== req.params.merchantId) return sendApiError(res, 404, "resource_not_found", "Resource not found");
    const result = merchantMembershipService.list(createTenantScope(auth.auth_context), actor(auth));
    if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
    return res.json(result);
  });

  router.patch("/merchants/:merchantId/memberships/:id", (req, res) => {
    const auth = requireMerchantStepUp(req, "member.role_promote");
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (auth.auth_context.merchant_id !== req.params.merchantId) return sendApiError(res, 404, "resource_not_found", "Resource not found");
    const result = merchantMembershipService.changeRole(createTenantScope(auth.auth_context), actor(auth), req.params.id, req.body || {}, {
      allowSensitive: true
    });
    if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
    observability.recordAuditEvent("merchant_membership.role_changed", "success", {
      actor: { type: "merchant_account", id: auth.auth_context.actor_id },
      resource: { type: "merchant_membership", id: result.membership.membership_id },
      labels: { role: result.membership.role }
    });
    return res.json(result);
  });

  router.delete("/merchants/:merchantId/memberships/:id", (req, res) => {
    const auth = verifyMerchantSession(req, { csrf: true });
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (auth.auth_context.merchant_id !== req.params.merchantId) return sendApiError(res, 404, "resource_not_found", "Resource not found");
    const result = merchantMembershipService.remove(createTenantScope(auth.auth_context), actor(auth), req.params.id, req.body || {});
    if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
    observability.recordAuditEvent("merchant_membership.removed", "success", {
      actor: { type: "merchant_account", id: auth.auth_context.actor_id },
      resource: { type: "merchant_membership", id: result.membership.membership_id },
      labels: { status: result.membership.status }
    });
    return res.json(result);
  });

  return router;
}

function actor(auth) {
  return { account_id: auth.auth_context.actor_id, role: auth.auth_context.role };
}
