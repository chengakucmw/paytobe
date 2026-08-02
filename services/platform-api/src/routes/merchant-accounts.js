import express from "express";

const GENERIC_REGISTRATION_RESPONSE = Object.freeze({
  ok: true,
  accepted: true,
  message: "If the address can be registered, a verification email will be sent."
});

export function createMerchantAccountsRouter(deps) {
  const { merchantAccountService, observability, sendApiError } = deps;
  const router = express.Router();

  router.post("/registrations", async (req, res, next) => {
    try {
      await merchantAccountService.register(req.body || {});
      observability.recordAuditEvent("merchant_account.registration_requested", "success", {
        actor: { type: "anonymous" },
        resource: { type: "merchant_account", id: "undisclosed" }
      });
      return res.status(202).json(GENERIC_REGISTRATION_RESPONSE);
    } catch (error) {
      if (error instanceof TypeError) return sendApiError(res, 400, "invalid_email", "Email is invalid", { field: "email" });
      return next(error);
    }
  });

  router.post("/email-verifications", (req, res, next) => {
    try {
      const result = merchantAccountService.verify(req.body || {});
      if (!result.ok) return sendApiError(res, 400, result.code, result.message, { field: "token" });
      observability.recordAuditEvent("merchant_account.email_verified", "success", {
        actor: { type: "merchant_account", id: result.account.account_id },
        resource: { type: "merchant_account", id: result.account.account_id }
      });
      return res.json({ ok: true, account: result.account, session_grant: result.session_grant });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
