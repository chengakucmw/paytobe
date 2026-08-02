import express from "express";

import { roleAllows } from "../application/merchant-memberships/service.js";
import { createTenantScope } from "../ports/tenant-repository.js";

export function createAgentCredentialsRouter(deps) {
  const { agentCredentialService, verifyMerchantSession, requireMerchantStepUp, sendApiError, observability } = deps;
  const router = express.Router({ mergeParams: true });

  router.get("/:agentId/credentials", (req, res, next) => {
    const auth = verifyMerchantSession(req);
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (!roleAllows(auth.auth_context.role, "resources.read")) return sendApiError(res, 403, "forbidden", "Merchant role is not permitted");
    try {
      const result = agentCredentialService.list(createTenantScope(auth.auth_context), req.params.agentId);
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.post("/:agentId/credentials", (req, res, next) => {
    const auth = verifyMerchantSession(req, { csrf: true });
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (!roleAllows(auth.auth_context.role, "credentials.manage")) return sendApiError(res, 403, "forbidden", "Merchant role is not permitted");
    try {
      const result = agentCredentialService.register(createTenantScope(auth.auth_context), req.params.agentId, req.body || {});
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      record(observability, auth, "agent_credential.registered", result.credential);
      return res.status(201).json(result);
    } catch (error) {
      if (error instanceof TypeError) return sendApiError(res, 400, "invalid_request", error.message);
      return next(error);
    }
  });

  router.post("/:agentId/credentials/:credentialId/activate", (req, res, next) => {
    const auth = verifyMerchantSession(req, { csrf: true });
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (!roleAllows(auth.auth_context.role, "credentials.manage")) return sendApiError(res, 403, "forbidden", "Merchant role is not permitted");
    try {
      const result = agentCredentialService.activate(createTenantScope(auth.auth_context), req.params.agentId,
        req.params.credentialId, req.body || {});
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      record(observability, auth, "agent_credential.activated", result.credential);
      return res.json(result);
    } catch (error) {
      if (error instanceof TypeError) return sendApiError(res, 400, "invalid_request", error.message);
      return next(error);
    }
  });

  router.delete("/:agentId/credentials/:credentialId", (req, res, next) => {
    const auth = requireMerchantStepUp(req, "credential.revoke");
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (!roleAllows(auth.auth_context.role, "credentials.manage")) return sendApiError(res, 403, "forbidden", "Merchant role is not permitted");
    try {
      const result = agentCredentialService.revoke(createTenantScope(auth.auth_context), req.params.agentId,
        req.params.credentialId, req.body || {});
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      record(observability, auth, "agent_credential.revoked", result.credential);
      return res.json(result);
    } catch (error) {
      if (error instanceof TypeError) return sendApiError(res, 400, "invalid_request", error.message);
      return next(error);
    }
  });

  return router;
}

function record(observability, auth, action, credential) {
  observability.recordAuditEvent(action, "success", {
    actor: { type: "merchant_account", id: auth.auth_context.actor_id },
    resource: { type: "agent_credential", id: credential.credential_id },
    labels: { agent_id: credential.agent_id, status: credential.status }
  });
}
