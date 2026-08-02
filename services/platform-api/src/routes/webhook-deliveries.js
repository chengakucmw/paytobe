import express from "express";

import { roleAllows } from "../application/merchant-memberships/service.js";
import { createTenantScope } from "../ports/tenant-repository.js";

export function createWebhookDeliveriesRouter(deps) {
  const { webhookDeliveryService, verifyMerchantSession, requireMerchantStepUp, sendApiError } = deps;
  const router = express.Router();

  router.get("/", (req, res) => {
    const auth = verifyMerchantSession(req);
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (!roleAllows(auth.auth_context.role, "webhooks.manage")) return sendApiError(res, 403, "forbidden", "Merchant role is not permitted");
    return res.json(webhookDeliveryService.list(createTenantScope(auth.auth_context), req.query || {}));
  });

  router.post("/:id/replay", (req, res) => {
    const auth = requireMerchantStepUp(req, "webhook.secret_rotate");
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (!roleAllows(auth.auth_context.role, "webhooks.manage")) return sendApiError(res, 403, "forbidden", "Merchant role is not permitted");
    const result = webhookDeliveryService.replay(createTenantScope(auth.auth_context), req.params.id);
    if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
    return res.status(201).json(result);
  });

  return router;
}
