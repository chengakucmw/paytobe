import assert from "node:assert/strict";
import test from "node:test";
import { PortalApiError } from "../public/modules/api-client.js";
import { createDomainVerificationModel, messageForDomainError, renderDomainVerification } from "../src/pages/domains/index.js";

const challenge = `vdomain_${"A".repeat(43)}`;
const pendingDomain = Object.freeze({ domain_id: "domain_one", domain: "pay.acme.com", method: "dns_txt", status: "pending", version: 1 });

test("DNS and HTTPS challenges render exact proof instructions, expiry, and re-verification time", async () => {
  const api = mockApi();
  const dns = createDomainVerificationModel({ api, session: session("owner") });
  await dns.create({ domain: "pay.acme.com", method: "dns_txt" });
  const dnsHtml = renderDomainVerification(dns.getState(), true);
  assert.match(dnsHtml, /_Paytobe\.pay\.acme\.com/);
  assert.match(dnsHtml, new RegExp(challenge));
  assert.match(dnsHtml, /Aug 2, 2026|Aug 3, 2026/);

  const https = createDomainVerificationModel({ api: mockApi({ method: "https_well_known" }), session: session("admin") });
  await https.create({ domain: "secure.acme.com", method: "https_well_known" });
  const httpsHtml = renderDomainVerification(https.getState(), true);
  assert.match(httpsHtml, /\.well-known\/Paytobe-domain-verification/);
  assert.match(httpsHtml, /&quot;challenge&quot;/);
  assert.doesNotMatch(httpsHtml, /fetch\(|https:\/\/secure\.acme\.com/);
});

test("copy action copies only the domain challenge", async () => {
  const copied = [];
  const model = createDomainVerificationModel({ api: mockApi(), session: session("owner"), copyText: async (value) => copied.push(value) });
  await model.create({ domain: "pay.acme.com", method: "dns_txt" });
  await model.copyChallenge();
  assert.deepEqual(copied, [challenge]);
  assert.equal(copied[0].includes("merchant_one"), false);
  assert.equal(copied[0].includes("account"), false);
});

test("pending, verified, failure, expired, and re-verification states are stable", async () => {
  const model = createDomainVerificationModel({ api: mockApi(), session: session("owner"), confirmReplace: () => true });
  await model.create({ domain: "pay.acme.com", method: "dns_txt" });
  assert.equal(model.getState().displayStatus, "pending");
  await model.verify();
  assert.equal(model.getState().displayStatus, "verified");
  assert.equal(model.getState().challenge, "");
  await model.beginReverification(true);
  assert.equal(model.getState().displayStatus, "reverification_required");

  for (const [code, status] of [["domain_challenge_mismatch", "failed"], ["domain_challenge_expired", "expired"]]) {
    const failed = createDomainVerificationModel({ api: mockApi({ verifyError: new PortalApiError("8.8.8.8 internal detail", 422, code) }), session: session("owner") });
    await failed.create({ domain: "pay.acme.com", method: "dns_txt" });
    await failed.verify();
    assert.equal(failed.getState().displayStatus, status);
    assert.doesNotMatch(failed.getState().message, /8\.8\.8\.8|internal detail/);
  }
});

test("stable failure diagnostics never expose internal resolved addresses", () => {
  for (const code of ["domain_redirect_forbidden", "domain_http_failed", "domain_response_invalid", "domain_response_too_large", "domain_dns_rebinding", "unknown_internal_failure"]) {
    const message = messageForDomainError(code);
    assert.equal(message.length > 20, true);
    assert.doesNotMatch(message, /(?:\d{1,3}\.){3}\d{1,3}|localhost|127\.0\.0\.1/);
  }
});

test("replacement needs confirmation and step-up; cross-tenant IDs clear state", async () => {
  const calls = [];
  let confirmed = false;
  const api = mockApi({ calls });
  const model = createDomainVerificationModel({ api, session: session("owner"), confirmReplace: () => confirmed });
  await model.create({ domain: "pay.acme.com", method: "dns_txt" });
  await model.verify();
  assert.equal(await model.beginReverification(true), null);
  assert.equal(calls.some(([name]) => name === "beginDomainReverification"), false);

  confirmed = true;
  api.beginDomainReverification = async (...args) => {
    calls.push(["beginDomainReverification", ...args]);
    throw new PortalApiError("step up", 403, "step_up_required");
  };
  await model.beginReverification(true);
  assert.equal(model.getState().stepUpRequired, true);

  api.verifyDomain = async () => { throw new PortalApiError("other tenant", 404, "resource_not_found"); };
  await model.verify();
  assert.equal(model.getState().domain, null);
  assert.equal(model.getState().challenge, "");
  assert.doesNotMatch(renderDomainVerification(model.getState(), true), /pay\.acme\.com/);
});

test("browser model calls only platform API methods and never a user-supplied URL", async () => {
  const calls = [];
  const model = createDomainVerificationModel({ api: mockApi({ calls }), session: session("owner") });
  await model.create({ domain: "user-controlled.example.net", method: "https_well_known" });
  await model.verify();
  assert.deepEqual(calls.map(([name]) => name), ["createDomain", "verifyDomain"]);
  assert.equal(calls.some((entry) => entry.some((value) => String(value).startsWith("https://"))), false);
});

function session(role) {
  return { merchantId: "merchant_one", role };
}

function mockApi({ method = "dns_txt", verifyError = null, calls = [] } = {}) {
  return {
    async createDomain(input) {
      calls.push(["createDomain", input]);
      return { ok: true, merchant_domain: { ...pendingDomain, domain: input.domain, method: input.method || method }, challenge, dns_name: `_Paytobe.${input.domain}`, challenge_expires_at: "2026-08-02T18:00:00Z", next_reverification_at: "2026-09-01T18:00:00Z" };
    },
    async verifyDomain(id) {
      calls.push(["verifyDomain", id]);
      if (verifyError) throw verifyError;
      return { ok: true, merchant_domain: { ...pendingDomain, domain_id: id, method, status: "verified", version: 2, verified_at: "2026-08-02T10:00:00Z" }, next_reverification_at: "2026-09-01T18:00:00Z" };
    },
    async beginDomainReverification(id) {
      calls.push(["beginDomainReverification", id]);
      return { ok: true, merchant_domain: { ...pendingDomain, domain_id: id, method, status: "reverification_required", version: 3 }, challenge, challenge_expires_at: "2026-08-03T18:00:00Z" };
    },
    async startStepUp() { calls.push(["startStepUp"]); return { ok: true }; },
    async completeStepUp() { calls.push(["completeStepUp"]); return { ok: true }; }
  };
}
