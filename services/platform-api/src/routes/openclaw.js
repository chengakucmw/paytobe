// Legacy OpenClaw event-stream route. Mounted at "/v1/openclaw".

import express from "express";

export function createOpenClawRouter(deps) {
  const { store, sendApiError, verifyOpenClaw } = deps;
  const router = express.Router();

  router.get("/events", (req, res) => {
    const auth = verifyOpenClaw(req);
    if (!auth.ok) return sendApiError(res, auth.status, auth.code || "openclaw_unauthorized", auth.error);
    const since = Number(req.query.since || 0);
    res.json({ ok: true, items: store.eventsSince(since) });
  });

  return router;
}
