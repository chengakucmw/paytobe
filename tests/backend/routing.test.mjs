import assert from "node:assert/strict";
import test from "node:test";
import { resolveTargetDevice } from "../../services/platform-api/src/routing.js";

test("connection request is delivered to its paired wallet device", () => {
  const result = resolveTargetDevice({ connection: { approved_by_device_id: "wallet_alice" } }, {});
  assert.deepEqual(result, { ok: true, target: "wallet_alice" });
});

test("explicit target matching the paired device is accepted", () => {
  const result = resolveTargetDevice(
    { connection: { approved_by_device_id: "wallet_alice" } },
    { target_app_device_id: "wallet_alice" }
  );
  assert.equal(result.ok, true);
  assert.equal(result.target, "wallet_alice");
});

test("a connection cannot redirect a request to another user's device (the core fix)", () => {
  const result = resolveTargetDevice(
    { connection: { approved_by_device_id: "wallet_alice" } },
    { target_app_device_id: "wallet_bob" }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, "target_device_mismatch");
});

test("an unbound connection is rejected, never auto-routed to an arbitrary device", () => {
  const result = resolveTargetDevice({ connection: { approved_by_device_id: "" } }, {});
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, "connection_not_bound");
});

test("legacy request honors an explicit target, then the configured default", () => {
  assert.equal(
    resolveTargetDevice({ legacy: true }, { target_app_device_id: "wallet_legacy" }).target,
    "wallet_legacy"
  );
  assert.equal(
    resolveTargetDevice({ legacy: true }, {}, { defaultDeviceId: "wallet_default" }).target,
    "wallet_default"
  );
});

test("legacy request with neither an explicit target nor a default is rejected", () => {
  const result = resolveTargetDevice({ legacy: true }, {});
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.code, "target_device_required");
});

test("whitespace-only device ids are treated as missing (no silent fallback)", () => {
  const unbound = resolveTargetDevice({ connection: { approved_by_device_id: "   " } }, {});
  assert.equal(unbound.ok, false);
  assert.equal(unbound.code, "connection_not_bound");

  const legacy = resolveTargetDevice({ legacy: true }, { target_app_device_id: "  " }, { defaultDeviceId: "  " });
  assert.equal(legacy.ok, false);
  assert.equal(legacy.code, "target_device_required");
});
