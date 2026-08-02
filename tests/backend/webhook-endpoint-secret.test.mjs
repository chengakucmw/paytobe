import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WebhookEndpointVerifier } from "../../services/platform-api/src/adapters/webhook/endpoint-verifier.js";
import {
  SECRET_OVERLAP_MS,
  SqliteWebhookEndpointRepository,
  WebhookEndpointService
} from "../../services/platform-api/src/application/webhooks/endpoint-service.js";
import { createAes256GcmVault, tokenHash } from "../../services/platform-api/src/crypto.js";
import { createTenantScope } from "../../services/platform-api/src/ports/tenant-repository.js";
import { Store } from "../../services/platform-api/src/store.js";

const start = Date.parse("2026-08-01T18:30:00.000Z");

test("verified merchant domain creates a one-time 256-bit secret encrypted at rest, rotates with bounded overlap, and revokes", async (t) => {
  const runtime = setup(t);
  runtime.seedMerchant("merchant_a");
  runtime.seedMerchant("merchant_b");
  runtime.seedVerifiedDomain("merchant_a", "merchant.co");
  const tenantA = scope("merchant_a");
  const tenantB = scope("merchant_b");

  const created = await runtime.service.create(tenantA, {
    url: "https://hooks.merchant.co/payments",
    event_types: ["payment_request.updated", "payment_request.created"]
  });
  assert.equal(created.ok, true);
  assert.equal(created.webhook_endpoint.status, "active");
  assert.equal(created.webhook_endpoint.verification_mode, "merchant_domain");
  assert.match(created.secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.ownership_challenge, undefined);
  assert.deepEqual(created.webhook_endpoint.event_types, ["payment_request.created", "payment_request.updated"]);
  assert.equal(Object.hasOwn(created.webhook_endpoint, "secret_ciphertext"), false);

  const endpointId = created.webhook_endpoint.webhook_endpoint_id;
  const row = runtime.store.db.prepare("SELECT * FROM webhook_endpoints WHERE webhook_endpoint_id = ?").get(endpointId);
  const secretRow = runtime.store.db.prepare("SELECT * FROM webhook_endpoint_secrets WHERE secret_id = ?").get(row.current_secret_id);
  assert.equal(row.secret_ciphertext.includes(created.secret), false);
  assert.equal(secretRow.ciphertext.includes(created.secret), false);
  assert.equal(runtime.vault.decrypt(JSON.parse(secretRow.ciphertext), `merchant_a:${endpointId}:${secretRow.secret_id}`), created.secret);
  assert.equal(JSON.stringify(runtime.service.list(tenantA)).includes(created.secret), false);
  assert.equal(runtime.service.get(tenantB, endpointId).status, 404);

  const previousSecretId = row.current_secret_id;
  const beforeRotate = runtime.clock.now().getTime();
  const rotated = runtime.service.rotateSecret(tenantA, endpointId);
  assert.equal(rotated.ok, true);
  assert.match(rotated.secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(rotated.secret, created.secret);
  assert.equal(Date.parse(rotated.webhook_endpoint.secret_overlap_until) - beforeRotate, SECRET_OVERLAP_MS);
  const previous = runtime.store.db.prepare("SELECT * FROM webhook_endpoint_secrets WHERE secret_id = ?").get(previousSecretId);
  assert.equal(previous.status, "overlap");
  assert.equal(previous.expires_at, rotated.webhook_endpoint.secret_overlap_until);
  const current = runtime.store.db.prepare("SELECT * FROM webhook_endpoint_secrets WHERE secret_id = ?")
    .get(runtime.store.db.prepare("SELECT current_secret_id FROM webhook_endpoints WHERE webhook_endpoint_id = ?").get(endpointId).current_secret_id);
  assert.equal(runtime.vault.decrypt(JSON.parse(current.ciphertext), `merchant_a:${endpointId}:${current.secret_id}`), rotated.secret);

  const revoked = runtime.service.revoke(tenantA, endpointId);
  assert.equal(revoked.webhook_endpoint.status, "revoked");
  assert.equal(runtime.store.db.prepare(`SELECT COUNT(*) AS count FROM webhook_endpoint_secrets
    WHERE webhook_endpoint_id = ? AND status IN ('active','overlap')`).get(endpointId).count, 0);
  assert.equal(runtime.service.rotateSecret(tenantA, endpointId).code, "webhook_not_active");

  const auditRows = runtime.store.db.prepare("SELECT action, details_json FROM audit_events WHERE resource_id = ? ORDER BY occurred_at, rowid")
    .all(endpointId);
  assert.deepEqual(auditRows.map((item) => item.action), [
    "webhook_endpoint.created", "webhook_secret.displayed", "webhook_secret.rotated", "webhook_secret.displayed", "webhook_secret.revoked"
  ]);
  const serializedAudit = JSON.stringify(auditRows);
  assert.equal(serializedAudit.includes(created.secret), false);
  assert.equal(serializedAudit.includes(rotated.secret), false);
});

test("independent endpoint ownership challenge must verify before activation and is never persisted in plaintext", async (t) => {
  let returnedChallenge = "";
  const runtime = setup(t, {
    fetch: async (_url, options) => {
      assert.equal(options.redirect, "manual");
      return new Response(JSON.stringify({ challenge: returnedChallenge }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  runtime.seedMerchant("merchant_a");
  const tenant = scope("merchant_a");
  const created = await runtime.service.create(tenant, {
    url: "https://callbacks.vendor.co/velarumpay",
    event_types: ["payment_request.updated"]
  });
  assert.equal(created.webhook_endpoint.status, "pending_verification");
  assert.match(created.ownership_challenge, /^whv_[A-Za-z0-9_-]{43}$/);
  returnedChallenge = created.ownership_challenge;
  const stored = runtime.store.db.prepare("SELECT * FROM webhook_endpoints WHERE webhook_endpoint_id = ?")
    .get(created.webhook_endpoint.webhook_endpoint_id);
  assert.equal(stored.challenge_hash, tokenHash(created.ownership_challenge));
  assert.equal(JSON.stringify(stored).includes(created.ownership_challenge), false);

  const verified = await runtime.service.verify(tenant, created.webhook_endpoint.webhook_endpoint_id);
  assert.equal(verified.ok, true);
  assert.equal(verified.webhook_endpoint.status, "active");
  assert.equal(runtime.store.db.prepare("SELECT challenge_hash FROM webhook_endpoints WHERE webhook_endpoint_id = ?")
    .get(created.webhook_endpoint.webhook_endpoint_id).challenge_hash, null);
});

function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-webhook-secret-"));
  const store = new Store(path.join(directory, "platform.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const clock = controlledClock(start);
  const vault = createAes256GcmVault(Buffer.alloc(32, 7).toString("base64url"), "velarumpay.webhook_secret.v1");
  const resolver = options.resolver || { resolve: async () => ["8.8.8.8"] };
  const fetcher = { fetch: options.fetch || (async () => new Response("{}", { status: 200 })) };
  let counter = 0;
  const random = {
    id: (prefix) => `${prefix}_${String(++counter).padStart(6, "0")}`,
    opaqueToken: (prefix) => `${prefix}_${String(++counter).padStart(43, "A")}`
  };
  const repository = new SqliteWebhookEndpointRepository(store.db);
  const service = new WebhookEndpointService({
    repository,
    verifier: new WebhookEndpointVerifier({ resolver, fetcher }),
    vault,
    clock,
    random,
    hash: tokenHash
  });
  return {
    store, repository, service, vault, clock,
    seedMerchant(merchantId) {
      const at = clock.nowIso();
      store.db.prepare(`INSERT INTO merchants
        (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
        VALUES (?, ?, 'active', 'verified', 1, ?, ?)`).run(merchantId, merchantId, at, at);
    },
    seedVerifiedDomain(merchantId, domain) {
      const at = clock.nowIso();
      store.db.prepare(`INSERT INTO merchant_domains
        (domain_id, merchant_id, domain, method, challenge_hash, status, verified_at, version, created_at, updated_at)
        VALUES (?, ?, ?, 'dns_txt', 'sha256:test', 'verified', ?, 1, ?, ?)`)
        .run(`domain_${merchantId}`, merchantId, domain, at, at, at);
    }
  };
}

function scope(merchantId) {
  return createTenantScope(Object.freeze({ merchant_id: merchantId, actor_id: `owner_${merchantId}`, request_id: `request_${merchantId}` }));
}

function controlledClock(initial) {
  let current = initial;
  return {
    now: () => new Date(current),
    nowIso: () => new Date(current).toISOString(),
    advance: (milliseconds) => { current += milliseconds; }
  };
}
