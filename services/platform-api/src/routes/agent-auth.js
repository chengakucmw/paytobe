import express from "express";

export function createAgentAuthRouter(deps) {
  const { agentAuthService, sendApiError, observability } = deps;
  const router = express.Router();

  router.post("/token", (req, res, next) => {
    try {
      const requestId = String(res.getHeader?.("x-request-id") || "unknown");
      const result = agentAuthService.exchange(req.body || {}, requestId);
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      observability.recordAuditEvent("agent_auth.token_issued", "success", {
        actor: { type: "agent", id: result.auth_context.agent_id },
        resource: { type: "agent_access_token", id: result.auth_context.credential_id },
        labels: { client_id: result.auth_context.client_id, scope_count: String(result.scope.length) }
      });
      res.set("cache-control", "no-store");
      res.set("pragma", "no-cache");
      return res.json(result);
    } catch (error) {
      if (error instanceof TypeError) return sendApiError(res, 400, "invalid_request", "Client assertion request is invalid");
      return next(error);
    }
  });

  return router;
}
