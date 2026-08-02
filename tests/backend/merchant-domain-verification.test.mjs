import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MerchantDomainService,
  normalizeDomain,
  SqliteMerchantDomainRepository
} from "../../services/platform-api/src/application/merchant-domains/service.js";
import { createClockPort } from "../../services/platform-api/src/ports/clock.js";
import { createRandomPort } from "../../services/platform-api/src/ports/random.js";
import { createTenantScope } from "../../services/platform-api/src/ports/tenant-repository.js";
import { createConnectKey, id, opaqueToken, tokenHash } from "../../services/platform-api/src/crypto.js";
import { Store } from "../../services/platform-api/src/store.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-domain-verification-"));
const store = new Store(path.join(directory, "platform.sqlite"));
const at = "2026-08-02T00:00:00.000Z";
for (const merchantId of ["merchant_a", "merchant_b"]) {
  store.db.prepare(`INSERT INTO merchants
    (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
    VALUES (?, ?, 'active', 'verified', 1, ?, ?)`).run(merchantId, merchantId, at, at);
}
const scopeA = scope("merchant_a");
const scopeB = scope("merchant_b");

test.after(() => {
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function scope(merchantId) {
  return createTenantScope(Object.freeze({ merchant_id: merchantId, actor_id: `actor_${merchantId}`, request_id: `request_${merchantId}` }));
}

function service(resolver, fetcher = { fetch: async () => { throw new Error("unexpected fetch"); } }) {
  return new MerchantDomainService({
    repository: new SqliteMerchantDomainRepository(store.db),
    clock: createClockPort(() => at),
    random: createRandomPort({ id, opaqueToken, connectKey: createConnectKey }),
    hash: tokenHash,
    resolver,
    fetcher
  });
}

test("IDN hostnames normalize to a stable ASCII domain", () => {
  assert.equal(normalizeDomain("BÜCHER.de."), "xn--bcher-kva.de");
  assert.equal(normalizeDomain("Pay.ACME.com"), "pay.acme.com");
});

test("DNS TXT verification stores only challenge/evidence hashes and supports safe reverification", async () => {
  const resolver = new FakeResolver(["93.184.216.34"]);
  const domains = service(resolver);
  const created = domains.create(scopeA, { domain: "pay.acme.com", method: "dns_txt" });
  assert.equal(created.ok, true);
  assert.match(created.challenge, /^vdomain_[A-Za-z0-9_-]{43}$/);
  resolver.txt = [created.challenge];
  const verified = await domains.verify(scopeA, created.merchant_domain.domain_id);
  assert.equal(verified.ok, true);
  assert.equal(verified.merchant_domain.status, "verified");
  assert.match(verified.merchant_domain.evidence_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(verified.merchant_domain.challenge_hash.includes(created.challenge), false);
  assert.equal(JSON.stringify(verified.merchant_domain).includes(created.challenge), false);

  const replacement = domains.beginReverification(scopeA, created.merchant_domain.domain_id);
  assert.equal(replacement.ok, true);
  assert.equal(replacement.merchant_domain.status, "reverification_required");
  assert.equal(replacement.merchant_domain.evidence_digest, null);
  resolver.txt = [replacement.challenge];
  const reverified = await domains.verify(scopeA, created.merchant_domain.domain_id);
  assert.equal(reverified.ok, true);
  assert.equal(reverified.merchant_domain.status, "verified");
});

test("HTTPS well-known verification requires an exact challenge and persists method evidence", async () => {
  const resolver = new FakeResolver(["8.8.8.8"]);
  let challenge = "";
  const fetcher = {
    async fetch(url, options) {
      assert.equal(url, "https://pay.bravo.com/.well-known/velarumpay-domain-verification");
      assert.equal(options.redirect, "manual");
      return new Response(JSON.stringify({ challenge }), { status: 200, headers: { "content-type": "application/json" } });
    }
  };
  const domains = service(resolver, fetcher);
  const created = domains.create(scopeA, { domain: "pay.bravo.com", method: "https_well_known" });
  challenge = created.challenge;
  const verified = await domains.verify(scopeA, created.merchant_domain.domain_id);
  assert.equal(verified.ok, true);
  assert.equal(verified.merchant_domain.method, "https_well_known");
  assert.equal(verified.merchant_domain.verified_at, at);
});

test("a claimed domain cannot be enumerated or registered by another merchant", () => {
  const domains = service(new FakeResolver(["8.8.4.4"]));
  const conflict = domains.create(scopeB, { domain: "pay.acme.com", method: "dns_txt" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "domain_conflict");
  const cross = domains.beginReverification(scopeB, store.db.prepare("SELECT domain_id FROM merchant_domains WHERE domain = 'pay.acme.com'").get().domain_id);
  assert.equal(cross.status, 404);
  assert.equal(cross.code, "resource_not_found");
});

class FakeResolver {
  constructor(addresses) { this.addresses = addresses; this.txt = []; }
  async resolve() { return this.addresses; }
  async resolveTxt() { return this.txt; }
}
