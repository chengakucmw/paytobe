// B15: the OpenClaw connector must not fall back to a demo connection/device identity.
import assert from "node:assert/strict";
import test from "node:test";
import { buildPaymentRequestPayload } from "../../connectors/openclaw-telegram/src/Paytobe_adapter.js";

const basePayment = {
  rail: "base_usdc",
  network: "base_mainnet",
  asset: "USDC",
  amount: "1.00",
  to: `0x${"9".repeat(40)}`
};

function clearIdentityEnv() {
  delete process.env.Paytobe_CONNECTION_ID;
  delete process.env.OPENCLAW_CONNECTION_ID;
  delete process.env.OPENCLAW_DEVICE_ID;
}

test("explicit source identity is used verbatim", () => {
  clearIdentityEnv();
  const request = buildPaymentRequestPayload(basePayment, {
    connection_id: "conn_unit",
    device_id: "device_unit"
  });
  assert.equal(request.connection_id, "conn_unit");
  assert.equal(request.source.device_id, "device_unit");
});

test("missing connection_id fails fast (no demo fallback)", () => {
  clearIdentityEnv();
  assert.throws(
    () => buildPaymentRequestPayload(basePayment, { device_id: "device_unit" }),
    /connection_id is required/
  );
});

test("missing device_id fails fast (no demo fallback)", () => {
  clearIdentityEnv();
  assert.throws(
    () => buildPaymentRequestPayload(basePayment, { connection_id: "conn_unit" }),
    /device_id is required/
  );
});

test("env vars satisfy the identity requirement", () => {
  clearIdentityEnv();
  process.env.Paytobe_CONNECTION_ID = "conn_env";
  process.env.OPENCLAW_DEVICE_ID = "device_env";
  try {
    const request = buildPaymentRequestPayload(basePayment, {});
    assert.equal(request.connection_id, "conn_env");
    assert.equal(request.source.device_id, "device_env");
  } finally {
    clearIdentityEnv();
  }
});

test("the retired demo identity values never appear by default", () => {
  clearIdentityEnv();
  const request = buildPaymentRequestPayload(basePayment, {
    connection_id: "conn_unit",
    device_id: "device_unit"
  });
  assert.notEqual(request.connection_id, "conn_openclaw_telegram_demo");
  assert.notEqual(request.source.device_id, "mac-openclaw-01");
});
