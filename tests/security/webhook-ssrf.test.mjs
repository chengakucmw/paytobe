import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWebhookUrl, WebhookEndpointVerifier } from "../../services/platform-api/src/adapters/webhook/endpoint-verifier.js";
import { tokenHash } from "../../services/platform-api/src/crypto.js";

test("Webhook URLs reject non-HTTPS, credentials, non-standard ports, fragments, IP literals, and reserved hosts", () => {
  for (const value of [
    "http://hooks.merchant.co/callback",
    "https://user:pass@hooks.merchant.co/callback",
    "https://hooks.merchant.co:8443/callback",
    "https://hooks.merchant.co/callback#fragment",
    "https://127.0.0.1/callback",
    "https://[::1]/callback",
    "https://localhost/callback",
    "https://hooks.example/callback",
    "https://hooks.internal/callback"
  ]) assert.throws(() => normalizeWebhookUrl(value), TypeError, value);
  assert.equal(normalizeWebhookUrl("https://hooks.merchant.co:443/callback").toString(), "https://hooks.merchant.co/callback");
});

test("private, loopback, link-local, carrier-grade NAT, documentation, multicast, and empty DNS answers fail closed", async () => {
  for (const address of ["10.0.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "192.168.1.1", "100.64.0.1",
    "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "2001:db8::1", "::ffff:127.0.0.1"]) {
    const verifier = verifierFor([[address]]);
    await assert.rejects(() => verifier.inspect("https://hooks.merchant.co/callback"), (error) => error.code === "webhook_non_public_address", address);
  }
  await assert.rejects(() => verifierFor([[]]).inspect("https://hooks.merchant.co/callback"), (error) => error.code === "webhook_non_public_address");
});

test("redirects and DNS rebinding are rejected while the challenge request never follows redirects", async () => {
  let optionsSeen;
  const redirect = verifierFor([["8.8.8.8"]], async (_url, options) => {
    optionsSeen = options;
    return new Response("", { status: 302, headers: { location: "https://other.co/" } });
  });
  const redirected = await redirect.verifyChallenge("https://hooks.merchant.co/callback", tokenHash("challenge"), tokenHash);
  assert.equal(redirected.code, "webhook_redirect_forbidden");
  assert.equal(optionsSeen.redirect, "manual");

  const rebinding = verifierFor([["8.8.8.8"], ["1.1.1.1"]], async () =>
    new Response(JSON.stringify({ challenge: "challenge" }), { status: 200 }));
  const rebound = await rebinding.verifyChallenge("https://hooks.merchant.co/callback", tokenHash("challenge"), tokenHash);
  assert.equal(rebound.code, "webhook_dns_rebinding");
});

test("wrong challenge and oversized response fail without reflecting response data", async () => {
  const mismatch = verifierFor([["8.8.8.8"], ["8.8.8.8"]], async () =>
    new Response(JSON.stringify({ challenge: "attacker-controlled" }), { status: 200 }));
  const result = await mismatch.verifyChallenge("https://hooks.merchant.co/callback", tokenHash("expected"), tokenHash);
  assert.equal(result.code, "webhook_challenge_mismatch");
  assert.equal(JSON.stringify(result).includes("attacker-controlled"), false);

  const oversized = verifierFor([["8.8.8.8"]], async () => new Response("x".repeat(8193), { status: 200 }));
  await assert.rejects(() => oversized.verifyChallenge("https://hooks.merchant.co/callback", tokenHash("expected"), tokenHash),
    (error) => error.code === "webhook_response_too_large");
});

function verifierFor(answerSets, fetch = async () => new Response(JSON.stringify({ challenge: "challenge" }), { status: 200 })) {
  let index = 0;
  return new WebhookEndpointVerifier({
    resolver: { resolve: async () => answerSets[Math.min(index++, answerSets.length - 1)] },
    fetcher: { fetch }
  });
}
