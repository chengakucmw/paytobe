// App-device routes. Mounted at "/v1/devices".

import express from "express";
import { id } from "../crypto.js";
import { deviceResponse } from "../domain/projections.js";

export function createDevicesRouter(deps) {
  const { store, observability, sendApiError, verifyAppBody } = deps;
  const router = express.Router();

  router.post("/app", (req, res) => {
    const { device_id, token } = req.body || {};
    if (!device_id || !token) {
      return sendApiError(res, 400, "invalid_app_device_registration", "device_id and token are required");
    }
    // M6: first-create-only. This endpoint used to UNCONDITIONALLY overwrite the
    // token_hash of an existing device, so anyone who knew or guessed a device_id
    // could re-register it with their own token and take the device over (and,
    // combined with C1, hijack its inbox). registerDevice now returns null for an
    // id that already exists; we surface that as 409 and never overwrite. A
    // legitimate token refresh must use the authenticated rotate-token endpoint.
    const device = store.registerDevice(device_id, token);
    if (!device) {
      return sendApiError(res, 409, "app_device_exists", "App device already registered", {
        details: { device_id }
      });
    }
    observability.recordAuditEvent("app_device.registered", "success", {
      actor: { type: "wallet_device", id: device.device_id },
      resource: { type: "app_device", id: device.device_id }
    });
    res.json({ ok: true, device: deviceResponse(device) });
  });

  router.post("/app/:id/rotate-token", (req, res) => {
    const auth = verifyAppBody({ body: { device_id: req.params.id, token: req.body?.token } });
    if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
    const newToken = String(req.body?.new_token || id("app_tok")).trim();
    if (!newToken) return sendApiError(res, 400, "invalid_app_device_token", "new_token must not be empty", { field: "new_token" });
    const device = store.rotateDeviceToken(req.params.id, newToken);
    if (!device) return sendApiError(res, 404, "app_device_not_found", "App device not found");
    observability.recordAuditEvent("app_device.token_rotated", "success", {
      actor: { type: "wallet_device", id: req.params.id },
      resource: { type: "app_device", id: req.params.id }
    });
    res.json({ ok: true, device: deviceResponse(device), device_token: newToken });
  });

  return router;
}
