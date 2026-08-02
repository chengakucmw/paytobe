// App-device routes. Mounted at "/v1/devices".

import express from "express";
import { tokenHash } from "../crypto.js";
import { deviceResponse } from "../domain/projections.js";

export function createDevicesRouter(deps) {
  const { store, observability, sendApiError, verifyAppBody, pushService, platformCore } = deps;
  const router = express.Router();

  router.post("/app", (req, res) => {
    const { device_id, token } = req.body || {};
    if (!device_id || !token) {
      return sendApiError(res, 400, "invalid_app_device_registration", "device_id and token are required");
    }
    // First-create-only for different credentials. Repeating the exact same
    // registration is idempotent so a wallet can safely ensure registration before
    // creating a Connect Key; a different token can never take over the device id.
    const device = store.registerDevice(device_id, token);
    if (!device) {
      if (store.verifyDeviceToken(device_id, token)) {
        return res.json({ ok: true, device: deviceResponse(store.device(device_id)) });
      }
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
    const newToken = String(req.body?.new_token || platformCore.random.id("app_tok")).trim();
    if (!newToken) return sendApiError(res, 400, "invalid_app_device_token", "new_token must not be empty", { field: "new_token" });
    const device = store.rotateDeviceToken(req.params.id, newToken);
    if (!device) return sendApiError(res, 404, "app_device_not_found", "App device not found");
    observability.recordAuditEvent("app_device.token_rotated", "success", {
      actor: { type: "wallet_device", id: req.params.id },
      resource: { type: "app_device", id: req.params.id }
    });
    res.json({ ok: true, device: deviceResponse(device), device_token: newToken });
  });

  router.put("/app/:id/push-token", (req, res) => {
    const auth = verifyAppBody(req);
    if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
    if (req.body?.device_id !== req.params.id) {
      return sendApiError(res, 400, "device_id_mismatch", "device_id must match the route device id", { field: "device_id" });
    }
    if (!pushService?.enabled || !pushService.tokenVault) {
      return sendApiError(res, 503, "push_not_configured", "FCM push delivery is not configured");
    }
    const provider = String(req.body?.provider || "fcm").trim().toLowerCase();
    const pushToken = String(req.body?.push_token || "").trim();
    if (provider !== "fcm") {
      return sendApiError(res, 400, "unsupported_push_provider", "Only the fcm push provider is supported", { field: "provider" });
    }
    if (pushToken.length < 20 || pushToken.length > 4096 || /\s/.test(pushToken)) {
      return sendApiError(res, 400, "invalid_push_token", "push_token is not a valid FCM registration token", { field: "push_token" });
    }
    const device = store.setDevicePushToken(req.params.id, {
      token_hash: tokenHash(pushToken),
      token_ciphertext: pushService.tokenVault.encrypt(pushToken, req.params.id)
    });
    if (!device) return sendApiError(res, 404, "app_device_not_found", "App device not found");
    observability.recordAuditEvent("app_device.push_token_registered", "success", {
      actor: { type: "wallet_device", id: req.params.id },
      resource: { type: "app_device", id: req.params.id },
      details: { provider: "fcm" }
    });
    return res.json({ ok: true, device: deviceResponse(device) });
  });

  router.delete("/app/:id/push-token", (req, res) => {
    const auth = verifyAppBody(req);
    if (!auth.ok) return sendApiError(res, auth.status, "invalid_app_device_token", auth.error);
    if (req.body?.device_id !== req.params.id) {
      return sendApiError(res, 400, "device_id_mismatch", "device_id must match the route device id", { field: "device_id" });
    }
    const device = store.clearDevicePushToken(req.params.id);
    if (!device) return sendApiError(res, 404, "app_device_push_token_not_found", "App device push token not found");
    observability.recordAuditEvent("app_device.push_token_cleared", "success", {
      actor: { type: "wallet_device", id: req.params.id },
      resource: { type: "app_device", id: req.params.id },
      details: { provider: "fcm" }
    });
    return res.json({ ok: true, device: deviceResponse(device) });
  });

  return router;
}
