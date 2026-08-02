import express from "express";
import { createTenantScope } from "../ports/tenant-repository.js";

export function createMerchantsRouter(deps) {
  const { merchantService, verifyMerchantSession, requireMerchantStepUp, sendApiError, observability } = deps;
  const router = express.Router();

  router.post("/", (req, res, next) => {
    try {
      const result = merchantService.create(req.body || {});
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      observability.recordAuditEvent("merchant.created", "success", {
        actor: { type: "merchant_account", id: result.membership.account_id },
        resource: { type: "merchant", id: result.merchant.merchant_id },
        labels: { status: result.merchant.status }
      });
      return res.status(201).json({ ok: true, merchant: result.merchant, membership: result.membership, session_grant: result.session_grant });
    } catch (error) {
      if (error instanceof TypeError) return sendApiError(res, 400, "invalid_request", error.message);
      return next(error);
    }
  });

  router.get("/:id", (req, res) => {
    const auth = verifyMerchantSession(req);
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    const merchant = merchantService.get(createTenantScope(auth.auth_context), req.params.id);
    if (!merchant) return sendApiError(res, 404, "resource_not_found", "Resource not found");
    return res.json({ ok: true, merchant });
  });

  router.patch("/:id", (req, res, next) => {
    const auth = ["suspended", "closed"].includes(req.body?.status)
      ? requireMerchantStepUp(req, "merchant.suspend")
      : verifyMerchantSession(req, { csrf: true });
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (!['owner', 'admin'].includes(auth.auth_context.role)) return sendApiError(res, 403, "forbidden", "Merchant role is not permitted");
    try {
      const result = merchantService.update(createTenantScope(auth.auth_context), req.params.id, req.body || {}, {
        allowSensitive: ["suspended", "closed"].includes(req.body?.status)
      });
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      observability.recordAuditEvent("merchant.updated", "success", {
        actor: { type: "merchant_account", id: auth.auth_context.actor_id },
        resource: { type: "merchant", id: result.merchant.merchant_id },
        labels: { status: result.merchant.status }
      });
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
