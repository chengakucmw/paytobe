import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTROL_PLANE_SCHEMA_VERSION,
  validateAgent,
  validateAgentCredential,
  validateControlPlaneObject,
  validateMerchant,
  validateMerchantDomain,
  validateMembership,
  validateNonAuthoritativeMetadata,
  validateRecipient,
  validateWebhookEndpoint
} from "../../packages/protocol/src/index.js";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = JSON.parse(fs.readFileSync(path.join(codeRoot, "tests/fixtures/control-plane-schema-fixtures.json"), "utf8"));
const validators = {
  merchant: validateMerchant,
  membership: validateMembership,
  domain: validateMerchantDomain,
  agent: validateAgent,
  credential: validateAgentCredential,
  recipient: validateRecipient,
  webhook: validateWebhookEndpoint
};

test("all control-plane JSON Schemas are versioned, closed, and publicly exported", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(codeRoot, "packages/protocol/package.json"), "utf8"));
  const schemas = fs.readdirSync(path.join(codeRoot, "packages/protocol/schema"))
    .filter((name) => /^velarum\.(merchant|agent|recipient|webhook)/.test(name));
  assert.equal(schemas.length, 7);
  for (const name of schemas) {
    const schema = JSON.parse(fs.readFileSync(path.join(codeRoot, "packages/protocol/schema", name), "utf8"));
    assert.equal(schema["x-velarumpay-contract-version"], CONTROL_PLANE_SCHEMA_VERSION);
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.required.includes("merchant_id"));
    assert.ok(schema.required.includes("status"));
    assert.ok(schema.required.includes("version"));
    assert.ok(schema.required.includes("created_at"));
    assert.ok(schema.required.includes("updated_at"));
  }
  const exportedSchemas = Object.keys(packageJson.exports).filter((name) => name.startsWith("./schema/") && /merchant|agent|recipient|webhook/.test(name));
  assert.equal(exportedSchemas.length, 7);
});

test("valid fixtures load through every public validator", () => {
  assert.equal(fixture.version, CONTROL_PLANE_SCHEMA_VERSION);
  for (const [type, value] of Object.entries(fixture.valid)) {
    assert.equal(validators[type](value).ok, true, type);
    assert.equal(validateControlPlaneObject(type, value).ok, true, type);
  }
});

test("unknown fields, invalid states, and forbidden Agent authority fail closed", () => {
  assert.equal(validateMerchant({ ...fixture.valid.merchant, private_key: "forbidden" }).error.code, "sensitive_field_forbidden");
  assert.equal(validateRecipient({ ...fixture.valid.recipient, status: "magic" }).error.code, "invalid_status");
  assert.equal(validateAgent({ ...fixture.valid.agent, allowed_scopes: ["wallet.sign"] }).error.code, "unsupported_scope");
  assert.equal(validateAgentCredential({ ...fixture.valid.credential, alg: "HS256" }).error.code, "unsupported_algorithm");
  assert.equal(validateMembership({ ...fixture.valid.membership, role: "superadmin" }).error.code, "invalid_role");
  assert.equal(validateWebhookEndpoint({ ...fixture.valid.webhook, unexpected: true }).error.code, "unknown_field");
});

test("metadata cannot override Recipient or Payment Request authoritative facts", () => {
  assert.equal(validateNonAuthoritativeMetadata({ order_id: "order-a", category: "demo" }).ok, true);
  for (const field of ["network", "asset", "amount", "recipient", "address", "contract", "issuer", "memo", "fee"]) {
    const result = validateNonAuthoritativeMetadata({ [field]: "forged" });
    assert.equal(result.ok, false, field);
    assert.equal(result.error.code, "authoritative_metadata_forbidden", field);
  }
  assert.equal(validateNonAuthoritativeMetadata({ credential: { seed_phrase: "forbidden" } }).error.code, "sensitive_field_forbidden");
});
