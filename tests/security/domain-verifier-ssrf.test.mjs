import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isPublicAddress,
  MerchantDomainService,
  normalizeDomain,
  SqliteMerchantDomainRepository
} from "../../services/platform-api/src/application/merchant-domains/service.js";
import { createClockPort } from "../../services/platform-api/src/ports/clock.js";
import { createRandomPort } from "../../services/platform-api/src/ports/random.js";
import { createTenantScope } from "../../services/platform-api/src/ports/tenant-repository.js";
import { createConnectKey, id, opaqueToken, tokenHash } from "../../services/platform-api/src/crypto.js";
import { Store } from "../../services/platform-api/src/store.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-domain-ssrf-"));
const store = new Store(path.join(directory, "platform.sqlite"));
const at = "2026-08-02T00:00:00.000Z";
store.db.prepare(`INSERT INTO merchants
  (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
  VALUES ('merchant_ssrf', 'SSRF', 'active', 'verified', 1, ?, ?)`).run(at, at);
const tenantScope = createTenantScope(Object.freeze({ merchant_id: "merchant_ssrf", actor_id: "actor_ssrf", request_id: "request_ssrf" }));

test.after(() => {
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("hostname and address policy blocks loopback, private, link-local, reserved, credentials, ports, and paths", () => {
  for (const domain of ["localhost", "service.local", "service.internal", "service.test", "service.invalid", "example.com",
    "127.0.0.1", "[::1]", "user@public.acme.com", "public.acme.com:8443", "public.acme.com/path"]) {
    assert.throws(() => normalizeDomain(domain), /Domain is invalid/, domain);
  }
  for (const address of ["0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1",
    "192.168.1.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "2001:db8::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("private resolution fails before HTTPS fetch", async () => {
  let fetched = false;
  const domains = createService({
    resolver: resolverSequence([["10.0.0.1"]]),
    fetcher: { async fetch() { fetched = true; return response("unused"); } }
  });
  const created = domains.create(tenantScope, { domain: uniqueDomain("private"), method: "https_well_known" });
  const result = await domains.verify(tenantScope, created.merchant_domain.domain_id);
  assert.equal(result.code, "domain_verification_failed");
  assert.equal(fetched, false);
});

test("redirects and DNS rebinding fail closed", async () => {
  const redirectService = createService({
    resolver: resolverSequence([["8.8.8.8"], ["8.8.8.8"]]),
    fetcher: { async fetch() { return new Response("", { status: 302, headers: { location: "https://other.acme.com" } }); } }
  });
  const redirect = redirectService.create(tenantScope, { domain: uniqueDomain("redirect"), method: "https_well_known" });
  assert.equal((await redirectService.verify(tenantScope, redirect.merchant_domain.domain_id)).code, "domain_redirect_forbidden");

  let challenge = "";
  const rebindService = createService({
    resolver: resolverSequence([["8.8.8.8"], ["1.1.1.1"]]),
    fetcher: { async fetch() { return response(challenge); } }
  });
  const rebind = rebindService.create(tenantScope, { domain: uniqueDomain("rebind"), method: "https_well_known" });
  challenge = rebind.challenge;
  assert.equal((await rebindService.verify(tenantScope, rebind.merchant_domain.domain_id)).code, "domain_dns_rebinding");
});

test("timeouts, invalid proof, and oversized bodies fail without verification", async () => {
  const timeoutService = createService({
    resolver: resolverSequence([["8.8.8.8"]]),
    fetcher: { async fetch() { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); } }
  });
  const timeout = timeoutService.create(tenantScope, { domain: uniqueDomain("timeout"), method: "https_well_known" });
  assert.equal((await timeoutService.verify(tenantScope, timeout.merchant_domain.domain_id)).code, "domain_verification_failed");

  const mismatchService = createService({
    resolver: resolverSequence([["8.8.8.8"], ["8.8.8.8"]]),
    fetcher: { async fetch() { return response("wrong"); } }
  });
  const mismatch = mismatchService.create(tenantScope, { domain: uniqueDomain("mismatch"), method: "https_well_known" });
  assert.equal((await mismatchService.verify(tenantScope, mismatch.merchant_domain.domain_id)).code, "domain_challenge_mismatch");

  const oversizedService = createService({
    resolver: resolverSequence([["8.8.8.8"], ["8.8.8.8"]]),
    fetcher: { async fetch() { return new Response("x".repeat(8_193), { status: 200 }); } }
  });
  const oversized = oversizedService.create(tenantScope, { domain: uniqueDomain("oversized"), method: "https_well_known" });
  assert.equal((await oversizedService.verify(tenantScope, oversized.merchant_domain.domain_id)).code, "domain_response_too_large");
});

function createService({ resolver, fetcher }) {
  return new MerchantDomainService({
    repository: new SqliteMerchantDomainRepository(store.db),
    clock: createClockPort(() => at),
    random: createRandomPort({ id, opaqueToken, connectKey: createConnectKey }),
    hash: tokenHash,
    resolver,
    fetcher
  });
}
function resolverSequence(sequence) {
  let index = 0;
  return { async resolve() { return sequence[Math.min(index++, sequence.length - 1)]; }, async resolveTxt() { return []; } };
}
function response(challenge) { return new Response(JSON.stringify({ challenge }), { status: 200, headers: { "content-type": "application/json" } }); }
function uniqueDomain(label) { return `${label}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}.acme.com`; }
