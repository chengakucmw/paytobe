import express from "express";

import { roleAllows } from "../application/merchant-memberships/service.js";
import { createTenantScope } from "../ports/tenant-repository.js";

export function createAgentsRouter(deps) {
  const { agentService, verifyMerchantSession, sendApiError, observability } = deps;
  const router = express.Router();

  router.get("/", (req, res, next) => {
    const auth = verifyMerchantSession(req);
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (!roleAllows(auth.auth_context.role, "resources.read")) return sendApiError(res, 403, "forbidden", "Merchant role is not permitted");
    try {
      return res.json(agentService.list(createTenantScope(auth.auth_context), req.query || {}));
    } catch (error) {
      return next(error);
    }
  });

  router.post("/", (req, res, next) => {
    const auth = verifyMerchantSession(req, { csrf: true });
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (!roleAllows(auth.auth_context.role, "agents.manage")) return sendApiError(res, 403, "forbidden", "Merchant role is not permitted");
    try {
      const result = agentService.create(createTenantScope(auth.auth_context), req.body || {});
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      record(observability, auth, "agent.created", result.agent);
      return res.status(201).json(result);
    } catch (error) {
      if (error instanceof TypeError) return sendApiError(res, 400, "invalid_request", error.message);
      return next(error);
    }
  });

  router.get("/:id", (req, res, next) => {
    const auth = verifyMerchantSession(req);
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (!roleAllows(auth.auth_context.role, "resources.read")) return sendApiError(res, 403, "forbidden", "Merchant role is not permitted");
    try {
      const result = agentService.get(createTenantScope(auth.auth_context), req.params.id);
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.patch("/:id", (req, res, next) => {
    const auth = verifyMerchantSession(req, { csrf: true });
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (!roleAllows(auth.auth_context.role, "agents.manage")) return sendApiError(res, 403, "forbidden", "Merchant role is not permitted");
    try {
      const result = agentService.update(createTenantScope(auth.auth_context), req.params.id, req.body || {});
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      record(observability, auth, "agent.updated", result.agent);
      return res.json(result);
    } catch (error) {
      if (error instanceof TypeError) return sendApiError(res, 400, "invalid_request", error.message);
      return next(error);
    }
  });

  return router;
}

function record(observability, auth, action, agent) {
  observability.recordAuditEvent(action, "success", {
    actor: { type: "merchant_account", id: auth.auth_context.actor_id },
    resource: { type: "agent", id: agent.agent_id },
    labels: { status: agent.status, version: String(agent.version) }
  });
}
