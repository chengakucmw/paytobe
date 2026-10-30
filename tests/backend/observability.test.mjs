import assert from "node:assert/strict";
import test from "node:test";
import { createObservability, sanitizeAuditPayload } from "../../services/platform-api/src/observability.js";

test("observability sanitizes sensitive audit payload fields", () => {
  const sanitized = sanitizeAuditPayload({
    connection_token: "conn_tok_secret",
    token: "wallet-token",
    signature: "sig-secret",
    payment: {
      amount: "24.00",
      to: "0x9b1c2f4e3a8d5c6b7e9f0a1b2c3d4e5f60718293",
      asset: "USDC"
    },
    tx_hash: "0xabc123abc123abc123abc123abc123abc123abcd"
  });

  assert.equal(sanitized.connection_token, "[REDACTED]");
  assert.equal(sanitized.token, "[REDACTED]");
  assert.equal(sanitized.signature, "[REDACTED]");
  assert.equal(sanitized.payment.amount, "[REDACTED_VALUE]");
  assert.match(sanitized.payment.to, /^sha256:[0-9a-f]{16}$/);
  assert.match(sanitized.tx_hash, /^sha256:[0-9a-f]{16}$/);
  assert.equal(sanitized.payment.asset, "USDC");
});

test("observability records audit events and exposes sanitized metrics", () => {
  const observability = createObservability({
    auditRetention: 2,
    logAuditToStdout: false
  });

  observability.recordAuditEvent("payment_request.created", "success", {
    actor: {
      type: "connection",
      id: "conn_123",
      connection_token: "conn_tok_secret"
    },
    resource: {
      type: "payment_request",
      id: "prq_123"
    },
    labels: {
      status: "pending",
      rail: "base_usdc"
    },
    details: {
      amount: "24.00",
      tx_hash: "0xabc123abc123abc123abc123abc123abc123abcd"
    }
  });
  observability.recordAuditEvent("payment_request.status_updated", "success", {
    details: { status: "broadcasted" }
  });
  observability.recordAuditEvent("pairing_session.rejected", "success", {
    details: { pairing_code: "123456" }
  });

  const events = observability.listAuditEvents({ since: 0, limit: 10 });
  assert.equal(events.items.length, 2);
  assert.equal(events.items[0].action, "payment_request.status_updated");
  assert.equal(events.items[1].details.pairing_code, "[REDACTED]");

  const metrics = observability.prometheusText();
  assert.match(metrics, /Paytobe_audit_events_total\{action="payment_request.created",outcome="success"\} 1/);
  assert.match(metrics, /Paytobe_audit_buffer_events 2/);
  assert.equal(metrics.includes("conn_tok_secret"), false);
  assert.equal(metrics.includes("123456"), false);
});

test("audit event reader requires an observability token", () => {
  const previous = process.env.OBSERVABILITY_TOKEN;
  process.env.OBSERVABILITY_TOKEN = "ops-token";
  try {
    const observability = createObservability({ logAuditToStdout: false });
    const denied = observability.authorizeAuditRequest({
      get: () => "",
      query: {}
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 401);

    const allowed = observability.authorizeAuditRequest({
      get: (header) => header === "authorization" ? "Bearer ops-token" : "",
      query: {}
    });
    assert.equal(allowed.ok, true);
  } finally {
    if (previous === undefined) {
      delete process.env.OBSERVABILITY_TOKEN;
    } else {
      process.env.OBSERVABILITY_TOKEN = previous;
    }
  }
});
