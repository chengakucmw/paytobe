import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PAIRING_SCOPES,
  PAYMENT_RAILS,
  PAYMENT_REQUEST_PROTOCOL,
  PAYMENT_STATUSES,
  RISK_SEVERITIES,
  SOURCE_TYPES,
  SUPPORTED_NETWORKS,
  TRANSACTION_CONTEXT_PROTOCOL,
  TRANSACTION_CONTEXT_STATUSES,
  TRANSACTION_CONTEXT_TYPES,
  VERIFICATION_STATUSES
} from "../../packages/protocol/src/index.js";
import { PLATFORM_API_ERROR_CODES } from "../../packages/protocol/src/platform-api.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const codeRoot = path.resolve(testDirectory, "../..");
const paymentSchemaPath = path.join(codeRoot, "packages/protocol/schema/velarum.payment_request.v1.schema.json");
const contextSchemaPath = path.join(codeRoot, "packages/protocol/schema/velarum.transaction_context.v1.schema.json");
const openApiPath = path.join(codeRoot, "services/platform-api/openapi/velarumpay-platform-api-v0.1.openapi.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sorted(values) {
  return [...values].sort();
}

test("JSON Schemas stay aligned with protocol constants", () => {
  const payment = readJson(paymentSchemaPath);
  const context = readJson(contextSchemaPath);

  assert.equal(payment.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(payment.properties.protocol.const, PAYMENT_REQUEST_PROTOCOL);
  assert.deepEqual(payment.properties.status.enum, [...PAYMENT_STATUSES]);
  assert.deepEqual(payment.properties.payment.properties.rail.enum, [...PAYMENT_RAILS]);
  assert.deepEqual(payment.properties.payment.properties.network.enum, [...SUPPORTED_NETWORKS]);
  assert.equal(payment.properties.policy.properties.requires_user_approval.const, true);

  assert.equal(context.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(context.properties.protocol.const, TRANSACTION_CONTEXT_PROTOCOL);
  assert.deepEqual(context.properties.type.enum, [...TRANSACTION_CONTEXT_TYPES]);
  assert.deepEqual(context.properties.status.enum, [...TRANSACTION_CONTEXT_STATUSES]);
  assert.deepEqual(context.properties.truth_fields.items.properties.source_type.enum, [...SOURCE_TYPES]);
  assert.deepEqual(context.properties.truth_fields.items.properties.verification_status.enum, [...VERIFICATION_STATUSES]);
  assert.deepEqual(context.properties.risk_findings.items.properties.severity.enum, [...RISK_SEVERITIES]);
});

test("OpenAPI exposes the canonical v0.1 surface and resolves protocol schemas", () => {
  const document = readJson(openApiPath);
  assert.equal(document.openapi, "3.1.0");
  assert.equal(document["x-velarumpay-contract-version"], "velarumpay.platform_api.v0.1");

  const expectedPaths = [
    "/health",
    "/v1/pairing/sessions",
    "/v1/pairing/sessions/{id}/approve",
    "/v1/connections/{id}/rotate-token",
    "/v1/transaction-contexts",
    "/v1/transaction-contexts/{transaction_id}",
    "/v1/payment-requests",
    "/v1/payment-requests/events",
    "/v1/payment-requests/{id}",
    "/v1/payment-requests/{id}/status"
  ];
  for (const endpoint of expectedPaths) assert.ok(document.paths[endpoint], `OpenAPI is missing ${endpoint}`);

  assert.deepEqual(document.components.schemas.PaymentStatus.enum, [...PAYMENT_STATUSES]);
  assert.deepEqual(sorted(document.components.schemas.PairingScope.enum), sorted(PAIRING_SCOPES));

  for (const schemaName of ["PaymentRequest", "TransactionContext"]) {
    const reference = document.components.schemas[schemaName].$ref;
    assert.ok(reference && !reference.startsWith("#"), `${schemaName} must reference the packaged JSON Schema`);
    const resolved = path.resolve(path.dirname(openApiPath), reference);
    assert.ok(fs.existsSync(resolved), `${schemaName} schema reference does not resolve: ${reference}`);
    readJson(resolved);
  }
});

test("public developer entry points reference OpenAPI and both protocol schemas", () => {
  const files = [
    path.join(codeRoot, "packages/protocol/README.md"),
    path.join(codeRoot, "services/platform-api/README.md"),
    path.join(codeRoot, "apps/docs/README.md")
  ];
  const combined = files.map((filePath) => fs.readFileSync(filePath, "utf8")).join("\n");

  assert.match(combined, /velarum\.payment_request\.v1\.schema\.json/);
  assert.match(combined, /velarum\.transaction_context\.v1\.schema\.json/);
  assert.match(combined, /velarumpay-platform-api-v0\.1\.openapi\.json/);
  assert.match(combined, /velarum\.payment_request\.v1/);
  assert.match(combined, /velarum\.transaction_context\.v1/);
});

test("published developer contract downloads are byte-identical to canonical sources", () => {
  const copies = [
    [openApiPath, path.join(codeRoot, "apps/docs/public/contracts/velarumpay-platform-api-v0.1.openapi.json")],
    [paymentSchemaPath, path.join(codeRoot, "apps/docs/public/contracts/velarum.payment_request.v1.schema.json")],
    [contextSchemaPath, path.join(codeRoot, "apps/docs/public/contracts/velarum.transaction_context.v1.schema.json")]
  ];

  for (const [source, published] of copies) {
    assert.ok(fs.existsSync(published), `Published contract is missing: ${published}`);
    assert.equal(fs.readFileSync(published, "utf8"), fs.readFileSync(source, "utf8"), `${published} is stale`);
  }
});

test("merchant documentation contract covers the canonical testnet onboarding surface", () => {
  const document = readJson(openApiPath);
  assert.equal(document.servers[0].url, "https://api-testnet.velarumpay.com");
  for (const endpoint of [
    "/v1/merchant-accounts/registrations", "/v1/merchant-accounts/email-verifications",
    "/v1/merchants", "/v1/merchant-sessions", "/v1/merchant-domains", "/v1/merchant-domains/{id}/verify",
    "/v1/recipients", "/v1/agents", "/v1/agent-auth/token", "/v1/connect-invitations/claim",
    "/v1/connect-invitations/{id}/exchange", "/v1/webhook-endpoints", "/v1/webhook-deliveries"
  ]) assert.ok(document.paths[endpoint], `OpenAPI is missing merchant path ${endpoint}`);
  assert.equal(document.paths["/v1/payment-requests"].post.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/PaymentRequestCreate");

  const errorSchema = readJson(path.join(codeRoot, "packages/protocol/schema/velarum.platform_api.error.v1.schema.json"));
  assert.deepEqual(errorSchema.properties.error.properties.code.enum, [...PLATFORM_API_ERROR_CODES]);
  const sdkTypes = fs.readFileSync(path.join(codeRoot, "packages/sdk-js/src/index.d.ts"), "utf8");
  for (const method of ["createAgent", "createRecipient", "claimConnectInvitation", "createPaymentRequest", "createWebhookEndpoint"]) {
    assert.match(sdkTypes, new RegExp(`\\b${method}\\(`));
  }
});

test("published Assertion and Webhook vectors are deterministic and contain no production secret", () => {
  const assertion = readJson(path.join(codeRoot, "apps/docs/public/vectors/agent-assertion.mock.json"));
  const [header, claims] = assertion.signing_input.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), assertion.protected_header);
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url")), assertion.claims);
  assert.equal(assertion.accepted_by_live_api, false);
  assert.equal(assertion.contains_private_key, false);

  const webhook = readJson(path.join(codeRoot, "apps/docs/public/vectors/webhook-hmac.json"));
  assert.equal(webhook.production_secret, false);
  const digest = createHmac("sha256", webhook.test_key).update(`${webhook.timestamp}.${webhook.raw_body}`).digest("hex");
  assert.equal(webhook.signature_header, `t=${webhook.timestamp},v1=${digest}`);
});
