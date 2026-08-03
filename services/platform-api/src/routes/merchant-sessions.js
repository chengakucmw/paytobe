import express from "express";

const COOKIE = "vp_merchant_session";

export function createMerchantSessionsRouter(deps) {
  const { merchantSessionService, verifyMerchantSession, sendApiError, observability } = deps;
  const router = express.Router();

  router.post("/", (req, res, next) => {
    try {
      const result = merchantSessionService.create(req.body || {});
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      res.cookie(COOKIE, result.session_token, cookieOptions(result.session.expires_at));
      observability.recordAuditEvent("merchant_session.created", "success", {
        actor: { type: "merchant_account", id: result.session.account_id },
        resource: { type: "merchant_session", id: result.session.session_id }
      });
      return res.status(201).json({ ok: true, session: publicSession(result.session, merchantSessionService), csrf_token: result.csrf_token });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/current", (req, res) => {
    const auth = verifyMerchantSession(req);
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    return res.json({ ok: true, session: publicSession(auth.session, merchantSessionService), auth_context: auth.auth_context });
  });

  router.delete("/current", (req, res) => {
    const auth = verifyMerchantSession(req, { csrf: true });
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    merchantSessionService.revoke(auth.session.session_id);
    res.clearCookie(COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "strict" });
    observability.recordAuditEvent("merchant_session.revoked", "success", {
      actor: { type: "merchant_account", id: auth.session.account_id },
      resource: { type: "merchant_session", id: auth.session.session_id }
    });
    return res.json({ ok: true });
  });

  router.post("/current/step-up", async (req, res, next) => {
    const auth = verifyMerchantSession(req, { csrf: true });
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    try {
      const result = req.body?.challenge_token
        ? merchantSessionService.completeStepUp(auth.session, req.body)
        : await merchantSessionService.startStepUp(auth.session);
      if (!result.ok) return sendApiError(res, result.status, result.code, result.message);
      if (result.step_up_at) {
        observability.recordAuditEvent("merchant_session.step_up_succeeded", "success", {
          actor: { type: "merchant_account", id: auth.session.account_id },
          resource: { type: "merchant_session", id: auth.session.session_id }
        });
        return res.json({ ok: true, step_up_at: result.step_up_at });
      }
      return res.status(202).json({ ok: true, accepted: true });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

function cookieOptions(expiresAt) {
  return { secure: true, httpOnly: true, sameSite: "strict", path: "/", expires: new Date(expiresAt) };
}

function publicSession(session, merchantSessionService) {
  return {
    session_id: session.session_id,
    merchant_id: session.merchant_id,
    account_id: session.account_id,
    role: session.role,
    status: session.status,
    expires_at: session.expires_at,
    idle_expires_at: session.idle_expires_at,
    step_up_at: session.step_up_at || null,
    step_up_fresh: merchantSessionService.isStepUpFresh(session)
  };
}
