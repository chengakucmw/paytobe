import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PLATFORM_API_ERROR_CODES } from "../../../packages/protocol/src/index.js";
import { runOfflineMerchantQuickstart } from "../../../examples/generic-payment-request/merchant-quickstart.mjs";

const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codeRoot = path.resolve(docsRoot, "../..");
const read = (relative) => fs.readFileSync(path.join(codeRoot, relative), "utf8");
const json = (relative) => JSON.parse(read(relative));

test("offline merchant quickstart completes the gated flow without network or credentials", async () => {
  const result = await runOfflineMerchantQuickstart();
  assert.deepEqual(result, { ok: true, completed_steps: 11, calls: 18 });
});

test("merchant quickstart keeps the canonical order and testnet safety boundary", () => {
  const quickstart = read("apps/docs/public/quickstart.html");
  const ordered = [
    "merchant-accounts/registrations",
    "merchant-accounts/email-verifications",
    "/v1/merchants",
    "/v1/merchant-sessions",
    "/v1/merchant-domains",
    "createRecipient",
    "createAgent",
    "registerAgentCredential",
    "exchangeAgentToken",
    "claimConnectInvitation",
    "createPaymentRequest"
  ];
  let cursor = -1;
  for (const marker of ordered) {
    const next = quickstart.indexOf(marker, cursor + 1);
    assert.ok(next > cursor, `${marker} must appear in canonical quickstart order`);
    cursor = next;
  }
  assert.match(quickstart, /https:\/\/api-testnet\.velarumpay\.com/);
  assert.match(quickstart, /requires_user_approval: true/);
  assert.match(quickstart, /recipient_version_id/);
  assert.doesNotMatch(quickstart, /AgentFood|\/claim\/legacy|BEGIN [A-Z ]*PRIVATE KEY|conn_tok_|whsec_|mainnet/i);
});

test("OpenAPI covers merchant onboarding and resolves errors, schemas, and official origin", () => {
  const openapi = json("services/platform-api/openapi/velarumpay-platform-api-v0.1.openapi.json");
  assert.equal(openapi.servers[0].url, "https://api-testnet.velarumpay.com");
  const paths = [
    "/v1/merchant-accounts/registrations", "/v1/merchant-accounts/email-verifications",
    "/v1/merchants", "/v1/merchant-sessions", "/v1/merchant-domains", "/v1/merchant-domains/{id}/verify",
    "/v1/recipients", "/v1/recipients/{id}/verify", "/v1/recipients/{id}/versions/{versionId}/activate",
    "/v1/agents", "/v1/agents/{agentId}/credentials", "/v1/agents/{agentId}/credentials/{credentialId}/activate",
    "/v1/agent-auth/token", "/v1/connect-invitations/claim", "/v1/connect-invitations/{id}/exchange",
    "/v1/webhook-endpoints", "/v1/webhook-endpoints/{id}/verify", "/v1/webhook-endpoints/{id}/rotate-secret",
    "/v1/webhook-deliveries", "/v1/webhook-deliveries/{id}/replay", "/v1/payment-requests"
  ];
  for (const endpoint of paths) assert.ok(openapi.paths[endpoint], `missing ${endpoint}`);
  for (const schema of [
    "MerchantAccountRegistration", "MerchantCreate", "MerchantSessionCreate", "MerchantDomainCreate",
    "AgentCreate", "AgentCredentialRegister", "AgentTokenExchange", "RecipientCreate", "RecipientVerify",
    "RecipientActivate", "ConnectClaim", "PaymentRequestCreate", "WebhookEndpointCreate", "ErrorEnvelope"
  ]) assert.ok(openapi.components.schemas[schema], `missing schema ${schema}`);
  assert.equal(openapi.paths["/v1/payment-requests"].post.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/PaymentRequestCreate");
  assert.equal(openapi.components.schemas.PaymentRequestCreate.properties.payment.additionalProperties, false);

  const errorSchema = json("packages/protocol/schema/velarum.platform_api.error.v1.schema.json");
  assert.deepEqual(errorSchema.properties.error.properties.code.enum, [...PLATFORM_API_ERROR_CODES]);
  assert.deepEqual(errorSchema.properties.error.required, ["code", "message", "request_id"]);
});

test("public SDK declares every method used by the merchant guide", () => {
  const types = read("packages/sdk-js/src/index.d.ts");
  for (const method of [
    "createAgent", "updateAgent", "registerAgentCredential", "activateAgentCredential",
    "createRecipient", "verifyRecipient", "activateRecipientVersion", "exchangeAgentToken",
    "claimConnectInvitation", "exchangeConnectInvitation", "createPaymentRequest", "getPaymentRequest",
    "pollEvents", "createWebhookEndpoint", "verifyWebhookEndpoint", "rotateWebhookSecret",
    "listWebhookDeliveries", "replayWebhookDelivery"
  ]) assert.match(types, new RegExp(`\\b${method}\\(`), `SDK type missing ${method}`);
});

test("Agent Assertion and Webhook HMAC fixed vectors are deterministic and non-production", () => {
  const assertion = json("apps/docs/public/vectors/agent-assertion.mock.json");
  const [headerPart, claimsPart] = assertion.signing_input.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(headerPart, "base64url")), assertion.protected_header);
  assert.deepEqual(JSON.parse(Buffer.from(claimsPart, "base64url")), assertion.claims);
  assert.equal(assertion.accepted_by_live_api, false);
  assert.equal(assertion.contains_private_key, false);
  assert.match(assertion.mock_signature, /^[A-Za-z0-9_-]{86}$/);

  const webhook = json("apps/docs/public/vectors/webhook-hmac.json");
  assert.equal(webhook.production_secret, false);
  assert.equal(webhook.signed_payload, `${webhook.timestamp}.${webhook.raw_body}`);
  const digest = createHmac("sha256", webhook.test_key).update(webhook.signed_payload).digest("hex");
  assert.equal(webhook.signature_header, `t=${webhook.timestamp},v1=${digest}`);
});

test("public HTML keeps semantic landmarks and valid local links", () => {
  const publicRoot = path.join(codeRoot, "apps/docs/public");
  const pages = fs.readdirSync(publicRoot).filter((name) => name.endsWith(".html"));
  for (const page of pages) {
    const html = fs.readFileSync(path.join(publicRoot, page), "utf8");
    assert.match(html, /<html lang="en">/i, `${page} needs a language`);
    assert.match(html, /<title>[^<]+<\/title>/i, `${page} needs a title`);
    assert.match(html, /<nav\b/i, `${page} needs navigation`);
    assert.match(html, /<main\b/i, `${page} needs a main landmark`);
    assert.match(html, /<h1>[^<]+<\/h1>/i, `${page} needs one visible page heading`);
    for (const [, href] of html.matchAll(/href="(\/[^"?#]*)/g)) {
      const target = href === "/" ? path.join(publicRoot, "index.html") : path.join(publicRoot, href.slice(1));
      assert.ok(fs.existsSync(target), `${page} has a broken local link: ${href}`);
    }
  }
});
