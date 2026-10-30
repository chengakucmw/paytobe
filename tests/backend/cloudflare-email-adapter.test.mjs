import assert from "node:assert/strict";
import test from "node:test";

import { createCloudflareEmailAdapter } from "../../services/platform-api/src/adapters/email/cloudflare.js";
import { loadRuntimeConfig, validateRuntimeConfig } from "../../services/platform-api/src/security.js";

const CONFIG = Object.freeze({
  account_id: "a".repeat(32),
  api_token: "cloudflare-email-token-with-sufficient-entropy",
  from: "security@Paytobe.com",
  from_name: "Paytobe",
  reply_to: "support@Paytobe.com",
  portal_base_url: "https://portal.Paytobe.com",
  timeout_ms: 1_000
});

test("Cloudflare verification email uses the REST endpoint and a one-time Portal URL", async () => {
  const calls = [];
  const adapter = createCloudflareEmailAdapter(CONFIG, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options, body: JSON.parse(options.body) });
      return jsonResponse(200, {
        success: true,
        errors: [],
        result: { delivered: ["owner@example.com"], queued: [], permanent_bounces: [] }
      });
    }
  });

  const result = await adapter.sendVerification({
    to: "owner@example.com",
    token: `mverify_${"A".repeat(43)}`,
    expires_at: "2026-08-03T01:15:00.000Z"
  });

  assert.deepEqual(result, { accepted: true, queued: false });
  assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/email/sending/send`);
  assert.equal(calls[0].options.headers.authorization, "Bearer cloudflare-email-token-with-sufficient-entropy");
  assert.equal(calls[0].body.to, "owner@example.com");
  assert.match(calls[0].body.text, /https:\/\/portal\.Paytobe\.com\/verify-email\?token=mverify_/);
  assert.match(calls[0].body.html, /Verify email/);
  assert.equal(calls[0].body.reply_to, "support@Paytobe.com");
  assert.equal(calls[0].body.headers, undefined);
});

test("Cloudflare email accepts the live asynchronous message_id contract", async () => {
  const adapter = createCloudflareEmailAdapter(CONFIG, {
    fetchImpl: async () => jsonResponse(200, {
      success: true,
      errors: [],
      result: {
        message_id: "message_accepted_for_async_delivery",
        delivered: [],
        queued: [],
        permanent_bounces: []
      }
    })
  });

  const result = await adapter.sendVerification({
    to: "owner@example.com",
    token: `mverify_${"C".repeat(43)}`,
    expires_at: "2026-08-03T01:15:00.000Z"
  });

  assert.deepEqual(result, { accepted: true, queued: true });
});

test("Cloudflare step-up email accepts queued delivery and never puts the API token in the body", async () => {
  let body;
  const adapter = createCloudflareEmailAdapter(CONFIG, {
    fetchImpl: async (_url, options) => {
      body = options.body;
      return jsonResponse(200, {
        success: true,
        errors: [],
        result: { delivered: [], queued: ["owner@example.com"], permanent_bounces: [] }
      });
    }
  });
  const result = await adapter.sendStepUp({
    to: "owner@example.com",
    token: `mstep_${"B".repeat(43)}`,
    expires_at: "2026-08-03T01:05:00.000Z"
  });
  assert.deepEqual(result, { accepted: true, queued: true });
  assert.match(body, /mstep_/);
  assert.match(body, /without signing in again/);
  assert.match(body, /Complete security verification/);
  assert.doesNotMatch(body, /verification code/);
  assert.doesNotMatch(body, /cloudflare-email-token/);
});

test("Cloudflare email retries transient failure and fails closed on permanent bounce", async () => {
  let attempts = 0;
  const adapter = createCloudflareEmailAdapter(CONFIG, {
    sleep: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return jsonResponse(503, { success: false, errors: [{ message: "upstream" }] });
      return jsonResponse(200, {
        success: true,
        result: { delivered: [], queued: [], permanent_bounces: ["owner@example.com"] }
      });
    }
  });
  await assert.rejects(
    () => adapter.sendVerification({ to: "owner@example.com", token: "token", expires_at: "soon" }),
    (error) => error.code === "email_permanent_bounce"
  );
  assert.equal(attempts, 2);
});

test("production runtime requires a complete Cloudflare transactional email configuration", () => {
  const base = {
    NODE_ENV: "production",
    RUNTIME_ENV: "production",
    PUBLIC_BASE_URL: "https://api.Paytobe.com",
    OFFICIAL_TESTNET_ONLY: "true",
    OPENCLAW_DEVICE_SECRET: "strong-openclaw-secret",
    CORS_ALLOWED_ORIGINS: "https://portal.Paytobe.com",
    RELAY_STORE_PATH: "/var/lib/Paytobe/relay.sqlite",
    METRICS_TOKEN: "metrics-secret",
    FCM_ENABLED: "true",
    FCM_PROJECT_ID: "Paytobe",
    FCM_SERVICE_ACCOUNT_FILE: "/run/secrets/firebase.json",
    FCM_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64")
  };
  const missing = validateRuntimeConfig(loadRuntimeConfig(base));
  assert.equal(missing.ok, false);
  assert(missing.errors.some((error) => error.includes("TRANSACTIONAL_EMAIL_PROVIDER")));

  const complete = validateRuntimeConfig(loadRuntimeConfig({
    ...base,
    TRANSACTIONAL_EMAIL_PROVIDER: "cloudflare",
    CLOUDFLARE_EMAIL_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_EMAIL_API_TOKEN: "token-with-sufficient-entropy",
    TRANSACTIONAL_EMAIL_FROM: "security@Paytobe.com",
    MERCHANT_PORTAL_PUBLIC_URL: "https://portal.Paytobe.com"
  }));
  assert.equal(complete.ok, true, complete.errors.join("\n"));
});

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
