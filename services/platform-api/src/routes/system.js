// System routes: /health, /metrics, /v1/audit/events. Mounted at "/".

import express from "express";
import { runtimeHealth } from "../security.js";

export function createSystemRouter(deps) {
  const { store, observability, runtimeConfig, runtimeValidation, sendApiError, refreshRuntimeMetrics } = deps;
  const router = express.Router();

  router.get("/health", (_req, res) => {
    const storage = store.info();
    res.json({
      ok: true,
      service: "agentwallet-relay",
      time: new Date().toISOString(),
      observability: {
        metrics: true,
        audit_events_buffered: observability.auditEventCount()
      },
      storage: {
        driver: storage.driver,
        schema_version: storage.schema_version
      },
      runtime: runtimeHealth(runtimeConfig, runtimeValidation)
    });
  });

  router.get("/metrics", (req, res) => {
    const auth = observability.authorizeMetricsRequest(req);
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    refreshRuntimeMetrics();
    res.set("content-type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(observability.prometheusText());
  });

  router.get("/v1/audit/events", (req, res) => {
    const auth = observability.authorizeAuditRequest(req);
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    const result = observability.listAuditEvents({
      since: req.query.since,
      limit: req.query.limit,
      action: req.query.action,
      outcome: req.query.outcome,
      resource_type: req.query.resource_type
    });
    res.json({ ok: true, ...result });
  });

  return router;
}
