import express from "express";

import { roleAllows } from "../application/merchant-memberships/service.js";
import { createTenantScope } from "../ports/tenant-repository.js";

export function createRecipientsRouter(deps) {
  const { recipientService, verifyMerchantSession, requireMerchantStepUp, sendApiError, observability } = deps;
  const router = express.Router();

  router.get("/", authorize("resources.read", async (req, res, auth) => {
    res.json(await recipientService.list(createTenantScope(auth.auth_context), req.query || {}));
  }));

  router.post("/", authorize("recipients.manage", async (req, res, auth) => {
    const result = await recipientService.create(createTenantScope(auth.auth_context), req.body || {});
    if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
    record(observability, auth, "recipient.created", result.recipient);
    return res.status(201).json(result);
  }, { csrf: true }));

  router.get("/:id", authorize("resources.read", async (req, res, auth) => {
    const result = await recipientService.get(createTenantScope(auth.auth_context), req.params.id);
    if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
    return res.json(result);
  }));

  router.patch("/:id", authorize("recipients.manage", async (req, res, auth) => {
    const result = await recipientService.update(createTenantScope(auth.auth_context), req.params.id, req.body || {});
    if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
    record(observability, auth, "recipient.updated", result.recipient);
    return res.json(result);
  }, { csrf: true }));

  router.get("/:id/versions", authorize("resources.read", async (req, res, auth) => {
    const result = await recipientService.listVersions(createTenantScope(auth.auth_context), req.params.id, req.query || {});
    if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
    return res.json(result);
  }));

  router.post("/:id/versions", authorize("recipients.manage", async (req, res, auth) => {
    const result = await recipientService.createVersion(createTenantScope(auth.auth_context), req.params.id, req.body || {});
    if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
    record(observability, auth, "recipient.version_created", result.recipient);
    return res.status(201).json(result);
  }, { csrf: true }));

  router.get("/:id/versions/:versionId", authorize("resources.read", async (req, res, auth) => {
    const result = await recipientService.getVersion(createTenantScope(auth.auth_context), req.params.id, req.params.versionId);
    if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
    return res.json(result);
  }));

  router.post("/:id/verify", authorize("recipients.manage", async (req, res, auth) => {
    const result = await recipientService.verify(createTenantScope(auth.auth_context), req.params.id, req.body || {});
    if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
    record(observability, auth, "recipient.verified", result.recipient);
    return res.json(result);
  }, { csrf: true }));

  router.post("/:id/versions/:versionId/activate", authorize("recipients.manage", async (req, res, auth) => {
    const result = await recipientService.activate(createTenantScope(auth.auth_context), req.params.id, {
      ...(req.body || {}),
      recipient_version_id: req.params.versionId
    });
    if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
    record(observability, auth, "recipient.activated", result.recipient);
    return res.json(result);
  }, { csrf: true, stepUp: "recipient.facts_change" }));

  function authorize(permission, handler, options = {}) {
    return async (req, res, next) => {
      const auth = options.stepUp ? requireMerchantStepUp(req, options.stepUp) : verifyMerchantSession(req, options);
      if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
      if (!roleAllows(auth.auth_context.role, permission)) return sendApiError(res, 403, "forbidden", "Merchant role is not permitted");
      try {
        return await handler(req, res, auth);
      } catch (error) {
        if (error instanceof TypeError) return sendApiError(res, 400, "invalid_recipient", error.message);
        return next(error);
      }
    };
  }

  return router;
}

function record(observability, auth, action, recipient) {
  observability.recordAuditEvent(action, "success", {
    actor: { type: "merchant_account", id: auth.auth_context.actor_id },
    resource: { type: "recipient", id: recipient.recipient_id },
    labels: { status: recipient.status, version: String(recipient.version) }
  });
}
