// Decides which wallet device a payment request / payment intent is delivered to.
//
// Security invariant (fixes the "payment request sent to the wrong wallet" bug):
//   - A connection-authenticated request is ALWAYS delivered to the wallet device
//     that approved the pairing (connection.approved_by_device_id). The caller may
//     not redirect it elsewhere; an explicit target_app_device_id is accepted only
//     when it matches the paired device, otherwise the request is rejected.
//   - Legacy / connection-less requests (e.g. the OpenClaw connector) are delivered
//     to an explicitly provided device or the single configured DEFAULT_APP_DEVICE_ID.
//     They MUST NOT fall back to an arbitrary "first registered device".
//
// Returns either { ok: true, target } or { ok: false, status, code, message }.

function clean(value) {
  return String(value || "").trim();
}

export function resolveTargetDevice(auth, body = {}, options = {}) {
  const requested = clean(body.target_app_device_id);

  // Connection-authenticated caller: bind strictly to the paired wallet device.
  if (auth && auth.connection) {
    const bound = clean(auth.connection.approved_by_device_id);
    if (!bound) {
      return {
        ok: false,
        status: 409,
        code: "connection_not_bound",
        message: "This connection is not paired with a wallet device. Re-pair the wallet before creating payment requests."
      };
    }
    if (requested && requested !== bound) {
      return {
        ok: false,
        status: 403,
        code: "target_device_mismatch",
        message: "Payment requests can only be delivered to the wallet device this connection is paired with."
      };
    }
    return { ok: true, target: bound };
  }

  // Legacy / connection-less path: explicit target, else the single configured
  // default. Never auto-pick an arbitrary device.
  const target = requested || clean(options.defaultDeviceId);
  if (!target) {
    return {
      ok: false,
      status: 400,
      code: "target_device_required",
      message: "No target app device is configured for this request."
    };
  }
  return { ok: true, target };
}
