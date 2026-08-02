import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUTH_CONTEXT_VERSION,
  CROSS_TENANT_SAFE_ERROR,
  IDEMPOTENCY_SCOPE_VERSION,
  PLATFORM_API_CONTRACT_VERSION,
  compareIdempotencyScope,
  createAuthContext,
  createIdempotencyScope,
  createPlatformApiError,
  selfDeclaredAuthorizationFields,
  validatePlatformApiErrorEnvelope
} from "../../packages/protocol/src/index.js";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(codeRoot, relativePath), "utf8"));
}

test("OpenAPI and all control-plane schemas declare the same stable contract version", () => {
  const openapi = readJson("services/platform-api/openapi/velarumpay-platform-api-v0.1.openapi.json");
  const schemaNames = [
    "packages/protocol/schema/velarum.platform_api.error.v1.schema.json",
    "packages/protocol/schema/velarum.auth_context.v1.schema.json",
    "packages/protocol/schema/velarum.idempotency_scope.v1.schema.json"
  ];

  assert.equal(PLATFORM_API_CONTRACT_VERSION, "velarum.platform-api.v1");
  assert.equal(openapi["x-velarumpay-control-plane-contract-version"], PLATFORM_API_CONTRACT_VERSION);
  for (const schemaName of schemaNames) {
    assert.equal(readJson(schemaName)["x-velarumpay-contract-version"], PLATFORM_API_CONTRACT_VERSION);
  }
  assert.equal(openapi.components.schemas.ErrorEnvelope.$ref, "../../../packages/protocol/schema/velarum.platform_api.error.v1.schema.json");
  assert.ok(openapi.components.securitySchemes.merchantSession);
  assert.ok(openapi.components.securitySchemes.agentBearer);
});

test("AuthContext is immutable and derived only from verified identity", () => {
  const verifiedIdentity = {
    actor_type: "agent_client",
    actor_id: "agent-client-1",
    merchant_id: "merchant-a",
    agent_id: "agent-a",
    client_id: "client-a",
    credential_id: "credential-a",
    scopes: ["payment.requests.read", "payment.requests.create", "payment.requests.read"],
    auth_method: "agent_assertion"
  };
  const requestBody = {
    merchant_id: "merchant-b",
    tenant_id: "merchant-b",
    agent_identity: { agent_id: "agent-b" }
  };
  const context = createAuthContext(verifiedIdentity, { requestId: "request-1", requestBody });

  assert.equal(context.version, AUTH_CONTEXT_VERSION);
  assert.equal(context.merchant_id, "merchant-a");
  assert.equal(context.agent_id, "agent-a");
  assert.deepEqual(context.scopes, ["payment.requests.create", "payment.requests.read"]);
  assert.deepEqual(selfDeclaredAuthorizationFields(requestBody), ["merchant_id", "tenant_id", "agent_identity"]);
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.scopes));
  assert.throws(() => createAuthContext({ ...verifiedIdentity, scopes: ["wallet.sign"] }, { requestId: "request-2" }), /cannot grant/i);
});

test("cross-tenant results are non-enumerating and errors require stable codes and request IDs", () => {
  assert.deepEqual(CROSS_TENANT_SAFE_ERROR, {
    status: 404,
    code: "resource_not_found",
    message: "Resource not found"
  });

  const envelope = createPlatformApiError("validation_failed", "Request validation failed", {
    requestId: "request-validation",
    field: "email",
    details: { reason: "invalid_format" }
  });
  assert.equal(validatePlatformApiErrorEnvelope(envelope).ok, true);
  assert.equal(validatePlatformApiErrorEnvelope({ ok: false, error: { code: "sometimes_bad", message: "bad", request_id: "r" } }).code, "unstable_error_code");
  assert.equal(validatePlatformApiErrorEnvelope({ ok: false, error: { code: "validation_failed", message: "bad" } }).code, "invalid_error_envelope");
  assert.throws(() => createPlatformApiError("sometimes_bad", "bad", { requestId: "r" }), /unstable/i);
});

test("idempotency is tenant- and actor-scoped and distinguishes duplicate from conflict", () => {
  const input = {
    merchant_id: "merchant-a",
    actor_id: "agent-a",
    route: "POST /v1/agents",
    key: "create-agent-1"
  };
  const first = createIdempotencyScope({ ...input, request: { name: "Support Agent", scopes: ["payment.requests.read"] } });
  const duplicate = createIdempotencyScope({ ...input, request: { scopes: ["payment.requests.read"], name: "Support Agent" } });
  const conflict = createIdempotencyScope({ ...input, request: { name: "Different Agent", scopes: ["payment.requests.read"] } });
  const otherTenant = createIdempotencyScope({ ...input, merchant_id: "merchant-b", request: { name: "Support Agent" } });

  assert.equal(first.version, IDEMPOTENCY_SCOPE_VERSION);
  assert.match(first.request_fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(compareIdempotencyScope(first, duplicate), { ok: true, duplicate: true });
  assert.deepEqual(compareIdempotencyScope(first, conflict), { ok: false, code: "idempotency_conflict", status: 409 });
  assert.deepEqual(compareIdempotencyScope(first, otherTenant), { ok: false, code: "resource_not_found", status: 404 });
});

test("the Express error responder includes the middleware request ID", async () => {
  const { createResponders } = await import("../../services/platform-api/src/http/responses.js");
  let body;
  const response = {
    locals: {},
    getHeader: (name) => name === "x-request-id" ? "request-from-middleware" : undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { body = value; return value; }
  };
  const observability = { markApiError() {} };
  createResponders({ observability }).sendApiError(response, 409, "idempotency_conflict", "The key was reused");
  assert.equal(response.statusCode, 409);
  assert.equal(body.error.request_id, "request-from-middleware");
});
