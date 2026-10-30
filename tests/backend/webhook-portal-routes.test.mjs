import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { opaqueToken, tokenHash } from "../../services/platform-api/src/crypto.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "Paytobe-webhook-portal-routes-"));
process.env.VP_NO_AUTO_LISTEN = "1";
process.env.RELAY_STORE_DRIVER = "sqlite";
process.env.RELAY_STORE_PATH = path.join(directory, "platform.sqlite");
process.env.AUDIT_LOG_STDOUT = "false";
process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const { server, store } = await import("../../services/platform-api/src/server.js");
let origin = "";
const sessions = new Map();

test.before(async () => {
  seedTenant("merchant_webhook_a", "owner_webhook_a");
  seedTenant("merchant_webhook_b", "owner_webhook_b");
  seedWebhookData();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("delivery list is tenant-scoped and replay requires recent step-up while preserving Event ID", async () => {
  const listed = await request("/v1/webhook-deliveries", "merchant_webhook_a");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.items.map((item) => item.delivery_id), ["delivery_a"]);
  assert.equal(JSON.stringify(listed.body).includes("payload_secret"), false);

  const blocked = await request("/v1/webhook-deliveries/delivery_a/replay", "merchant_webhook_a", { method: "POST" });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, "step_up_required");

  store.db.prepare("UPDATE merchant_sessions SET step_up_at = ? WHERE session_id = ?")
    .run(new Date().toISOString(), sessions.get("merchant_webhook_a").sessionId);
  const replay = await request("/v1/webhook-deliveries/delivery_a/replay", "merchant_webhook_a", { method: "POST" });
  assert.equal(replay.status, 201);
  assert.equal(replay.body.delivery.event_id, "event_a");
  assert.notEqual(replay.body.delivery.delivery_id, "delivery_a");

  const cross = await request("/v1/webhook-deliveries/delivery_b/replay", "merchant_webhook_a", { method: "POST" });
  assert.equal(cross.status, 404);
});

test("merchant audit route uses the session tenant and sanitizes durable details without an operations Bearer token", async () => {
  const response = await request("/v1/merchant-audit/events", "merchant_webhook_a");
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0].audit_event_id, "audit_a");
  assert.equal(JSON.stringify(response.body).includes("audit_b"), false);
  assert.equal(JSON.stringify(response.body).includes("top-secret-value"), false);
  assert.equal(response.body.items[0].details.secret, "[REDACTED]");
});

async function request(pathname, merchantId, { method = "GET" } = {}) {
  const session = sessions.get(merchantId);
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      cookie: `vp_merchant_session=${session.token}`,
      ...(method !== "GET" ? { origin, "x-csrf-token": session.csrf } : {})
    }
  });
  return { status: response.status, body: await response.json() };
}

function seedTenant(merchantId, accountId) {
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO merchants
    (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
    VALUES (?, ?, 'active', 'verified', 1, ?, ?)`).run(merchantId, merchantId, now, now);
  store.db.prepare(`INSERT INTO merchant_accounts
    (account_id, email_normalized, status, version, created_at, updated_at)
    VALUES (?, ?, 'active', 1, ?, ?)`).run(accountId, `${accountId}@example.invalid`, now, now);
  store.db.prepare(`INSERT INTO merchant_memberships
    (membership_id, merchant_id, account_id, role, status, version, created_at, updated_at)
    VALUES (?, ?, ?, 'owner', 'active', 1, ?, ?)`).run(`membership_${merchantId}`, merchantId, accountId, now, now);
  const sessionId = `msession_row_${merchantId}`;
  const token = opaqueToken("msession", 32);
  const csrf = opaqueToken("mcsrf", 32);
  store.db.prepare(`INSERT INTO merchant_sessions
    (session_id, merchant_id, account_id, token_hash, csrf_hash, status, expires_at, idle_expires_at,
     created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`).run(
    sessionId, merchantId, accountId, tokenHash(token), tokenHash(csrf),
    new Date(Date.now() + 3_600_000).toISOString(), new Date(Date.now() + 1_800_000).toISOString(), now, now
  );
  sessions.set(merchantId, { sessionId, token, csrf });
}

function seedWebhookData() {
  const now = new Date().toISOString();
  for (const suffix of ["a", "b"]) {
    const merchantId = `merchant_webhook_${suffix}`;
    store.db.prepare(`INSERT INTO webhook_endpoints
      (webhook_endpoint_id, merchant_id, url, event_types_json, status, secret_ciphertext, version, created_at, updated_at)
      VALUES (?, ?, ?, '["payment_request.status_updated"]', 'active', '{}', 1, ?, ?)`)
      .run(`endpoint_${suffix}`, merchantId, `https://hooks-${suffix}.example.invalid/Paytobe`, now, now);
    store.db.prepare(`INSERT INTO webhook_events
      (event_id, merchant_id, type, aggregate_id, payload_json, occurred_at, created_at)
      VALUES (?, ?, 'payment_request.status_updated', ?, ?, ?, ?)`)
      .run(`event_${suffix}`, merchantId, `request_${suffix}`, JSON.stringify({ safe: true, payload_secret: suffix }), now, now);
    store.db.prepare(`INSERT INTO webhook_deliveries
      (delivery_id, merchant_id, event_id, webhook_endpoint_id, attempt, status, next_attempt_at,
       created_at, updated_at, scheduled_at, failure_code, response_status)
      VALUES (?, ?, ?, ?, 1, 'failed', NULL, ?, ?, ?, 'http_500', 500)`)
      .run(`delivery_${suffix}`, merchantId, `event_${suffix}`, `endpoint_${suffix}`, now, now, now);
    store.db.prepare(`INSERT INTO audit_events
      (audit_event_id, merchant_id, actor_type, actor_id, action, resource_type, resource_id,
       result, request_id, details_json, occurred_at)
      VALUES (?, ?, 'merchant_account', ?, 'webhook_endpoint.created', 'webhook_endpoint', ?,
       'success', ?, ?, ?)`)
      .run(`audit_${suffix}`, merchantId, `owner_webhook_${suffix}`, `endpoint_${suffix}`, `request_audit_${suffix}`,
        JSON.stringify({ secret: "top-secret-value", safe: suffix }), now);
  }
}
