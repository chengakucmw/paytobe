import express from "express";

import { roleAllows } from "../application/merchant-memberships/service.js";
import { createTenantScope } from "../ports/tenant-repository.js";

export function createWebhookEndpointsRouter(deps) {
  const { webhookEndpointService, verifyMerchantSession, requireMerchantStepUp, sendApiError } = deps;
  const router = express.Router();

  router.get("/", (req, res) => {
    const auth = authorize(req, res, deps, false);
    if (!auth) return;
    return res.json(webhookEndpointService.list(createTenantScope(auth.auth_context)));
  });

  router.post("/", async (req, res, next) => {
    const auth = authorize(req, res, deps, true);
    if (!auth) return;
    try {
      const result = await webhookEndpointService.create(createTenantScope(auth.auth_context), req.body || {});
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      return res.status(201).json(result);
    } catch (error) {
      if (error?.code === "webhook_secret_encryption_unavailable") {
        return sendApiError(res, 503, error.code, "Webhook secret encryption is unavailable");
      }
      if (error instanceof TypeError) return sendApiError(res, 400, "invalid_webhook_endpoint", error.message);
      if (String(error?.code || "").startsWith("webhook_")) return sendApiError(res, 422, error.code, "Webhook Endpoint validation failed");
      return next(error);
    }
  });

  router.get("/:id", (req, res) => {
    const auth = authorize(req, res, deps, false);
    if (!auth) return;
    const result = webhookEndpointService.get(createTenantScope(auth.auth_context), req.params.id);
    if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
    return res.json(result);
  });

  router.post("/:id/verify", async (req, res, next) => {
    const auth = authorize(req, res, deps, true);
    if (!auth) return;
    try {
      const result = await webhookEndpointService.verify(createTenantScope(auth.auth_context), req.params.id);
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      return res.json(result);
    } catch (error) { return next(error); }
  });

  router.post("/:id/rotate-secret", (req, res, next) => {
    const auth = authorize(req, res, deps, true, true);
    if (!auth) return;
    try {
      const result = webhookEndpointService.rotateSecret(createTenantScope(auth.auth_context), req.params.id);
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      return res.json(result);
    } catch (error) {
      if (error?.code === "webhook_secret_encryption_unavailable") {
        return sendApiError(res, 503, error.code, "Webhook secret encryption is unavailable");
      }
      return next(error);
    }
  });

  router.delete("/:id", (req, res) => {
    const auth = authorize(req, res, deps, true, true);
    if (!auth) return;
    const result = webhookEndpointService.revoke(createTenantScope(auth.auth_context), req.params.id);
    if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
    return res.json(result);
  });

  return router;
}

function authorize(req, res, deps, csrf, stepUp = false) {
  const auth = stepUp
    ? deps.requireMerchantStepUp(req, "webhook.secret_rotate")
    : deps.verifyMerchantSession(req, { csrf });
  if (!auth.ok) {
    deps.sendApiError(res, auth.status, auth.code, auth.message);
    return null;
  }
  if (!roleAllows(auth.auth_context.role, "webhooks.manage")) {
    deps.sendApiError(res, 403, "forbidden", "Merchant role is not permitted");
    return null;
  }
  return auth;
}
