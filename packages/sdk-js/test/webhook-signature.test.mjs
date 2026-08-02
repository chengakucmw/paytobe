import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { verifyWebhookSignature } from "../src/index.js";

test("standard Webhook verification binds timestamp and exact raw UTF-8 bytes", async () => {
  const secret = "whsec_sdk_test_01234567890123456789";
  const timestamp = "1785609600";
  const raw = new TextEncoder().encode('{"event_id":"event_1","message":"付款 ready"}\n');
  const digest = crypto.createHmac("sha256", secret)
    .update(Buffer.from(`${timestamp}.`))
    .update(raw)
    .digest("hex");
  const signature = `t=${timestamp},v1=${digest}`;
  const now = () => Number(timestamp) * 1000;

  assert.deepEqual(await verifyWebhookSignature(secret, raw, signature, { now }), {
    ok: true,
    timestamp: Number(timestamp)
  });
  assert.equal((await verifyWebhookSignature(secret, new TextEncoder().encode('{"event_id":"event_1"}'), signature, { now })).ok, false);
  assert.equal((await verifyWebhookSignature(secret, raw, signature, { now: () => (Number(timestamp) + 301) * 1000 })).code, "stale_webhook_signature");
});
