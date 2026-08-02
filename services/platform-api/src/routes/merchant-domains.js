import express from "express";
import { roleAllows } from "../application/merchant-memberships/service.js";
import { createTenantScope } from "../ports/tenant-repository.js";

export function createMerchantDomainsRouter(deps) {
  const { merchantDomainService, verifyMerchantSession, requireMerchantStepUp, sendApiError, observability } = deps;
  const router = express.Router();

  router.post("/", (req, res, next) => {
    const auth = verifyMerchantSession(req, { csrf: true });
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (!roleAllows(auth.auth_context.role, "domains.manage")) return sendApiError(res, 403, "forbidden", "Merchant role is not permitted");
    try {
      const result = merchantDomainService.create(createTenantScope(auth.auth_context), req.body || {});
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      return res.status(201).json(result);
    } catch (error) {
      if (error instanceof TypeError) return sendApiError(res, 400, "invalid_domain", error.message, { field: "domain" });
      return next(error);
    }
  });

  router.post("/:id/verify", async (req, res, next) => {
    const auth = verifyMerchantSession(req, { csrf: true });
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (!roleAllows(auth.auth_context.role, "domains.manage")) return sendApiError(res, 403, "forbidden", "Merchant role is not permitted");
    try {
      const result = await merchantDomainService.verify(createTenantScope(auth.auth_context), req.params.id);
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      observability.recordAuditEvent("merchant_domain.verified", "success", {
        actor: { type: "merchant_account", id: auth.auth_context.actor_id },
        resource: { type: "merchant_domain", id: result.merchant_domain.domain_id }
      });
      return res.json(result);
    } catch (error) { return next(error); }
  });

  router.post("/:id/reverification", (req, res) => {
    const auth = requireMerchantStepUp(req, "domain.replace");
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (!roleAllows(auth.auth_context.role, "domains.manage")) return sendApiError(res, 403, "forbidden", "Merchant role is not permitted");
    const result = merchantDomainService.beginReverification(createTenantScope(auth.auth_context), req.params.id);
    if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
    return res.json(result);
  });

  return router;
}
