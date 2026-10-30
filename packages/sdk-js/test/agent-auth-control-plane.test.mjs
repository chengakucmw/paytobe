import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPaytobeClient, DEFAULT_AGENT_TOKEN_AUDIENCE } from "../src/index.js";

const tokenA = `vat_${"A".repeat(43)}`;
const tokenB = `vat_${"B".repeat(43)}`;
const claimToken = `claim_tok_${"C".repeat(43)}`;
let jtiSequence = 0;

test("local signer creates a canonical assertion and Agent token authenticates Connect claim", async () => {
  const calls = [];
  let signerInput;
  const client = clientWithAgentAuth(calls, [
    response(200, { ok: true, access_token: tokenA, token_type: "Bearer", expires_in: 300, scope: ["payment.requests.create"] }),
    response(201, { ok: true, claim_token: claimToken, connect_invitation: { connect_invitation_id: "cinv_one" } })
  ], (input) => { signerInput = input; return new Uint8Array([1, 2, 3]); });

  const result = await client.claimConnectInvitation(`Paytobe-connect:ck_${"D".repeat(43)}`, ["payment.requests.create"], {
    requestId: "request_connect_one"
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "https://platform.test/v1/agent-auth/token");
  const assertion = JSON.parse(calls[0].init.body).client_assertion;
  const parts = assertion.split(".");
  assert.equal(parts.length, 3);
  assert.deepEqual(JSON.parse(Buffer.from(parts[0], "base64url")), { alg: "EdDSA", kid: "kid-local", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
  assert.equal(claims.iss, "agent_registered");
  assert.equal(claims.sub, "client_local");
  assert.equal(claims.aud, DEFAULT_AGENT_TOKEN_AUDIENCE);
  assert.deepEqual(claims.scope, ["payment.requests.create"]);
  assert.equal(parts[2], "AQID");
  assert.equal(signerInput.keyHandle, "secure-handle-only");
  assert.equal(signerInput.data instanceof Uint8Array, true);
  assert.equal(calls[1].init.headers.authorization, `Bearer ${tokenA}`);
  assert.equal(calls[1].init.headers["x-request-id"], "request_connect_one");
});

test("short-token refresh is coalesced and a 401 retry is bounded to one", async () => {
  const calls = [];
  let exchanges = 0;
  let claims = 0;
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/agent-auth/token")) {
      exchanges += 1;
      await Promise.resolve();
      return response(200, { ok: true, access_token: exchanges === 1 ? tokenA : tokenB, expires_in: 300 });
    }
    claims += 1;
    return response(201, { ok: true, claim_token: claimToken, connect_invitation: { connect_invitation_id: `cinv_${claims}` } });
  };
  const client = clientWithAgentAuth(calls, [], undefined, fetch);
  await Promise.all([
    client.claimConnectInvitation(`Paytobe-connect:ck_${"E".repeat(43)}`, ["payment.requests.create"]),
    client.claimConnectInvitation(`Paytobe-connect:ck_${"F".repeat(43)}`, ["payment.requests.create"])
  ]);
  assert.equal(exchanges, 1);
  assert.equal(claims, 2);

  let tokenCalls = 0;
  let protectedCalls = 0;
  const bounded = clientWithAgentAuth([], [], undefined, async (url) => {
    if (url.endsWith("/agent-auth/token")) {
      tokenCalls += 1;
      return response(200, { ok: true, access_token: tokenCalls === 1 ? tokenA : tokenB, expires_in: 300 });
    }
    protectedCalls += 1;
    return response(401, { ok: false, error: { code: "unauthenticated", message: "revoked" } });
  });
  const failure = await bounded.claimConnectInvitation(`Paytobe-connect:ck_${"G".repeat(43)}`, ["payment.requests.create"]);
  assert.equal(failure.ok, false);
  assert.equal(tokenCalls, 2);
  assert.equal(protectedCalls, 2);
});

test("403, clock-skew, and duplicate-JTI failures do not retry", async () => {
  let exchanges = 0;
  let protectedCalls = 0;
  const forbidden = clientWithAgentAuth([], [], undefined, async (url) => {
    if (url.endsWith("/agent-auth/token")) { exchanges += 1; return response(200, { ok: true, access_token: tokenA, expires_in: 300 }); }
    protectedCalls += 1;
    return response(403, { ok: false, error: { code: "scope_denied", message: "denied" } });
  });
  assert.equal((await forbidden.claimConnectInvitation(`Paytobe-connect:ck_${"H".repeat(43)}`, ["payment.requests.create"])).status, 403);
  assert.equal(exchanges, 1);
  assert.equal(protectedCalls, 1);

  for (const reason of ["clock skew", "duplicate jti"]) {
    let calls = 0;
    const client = clientWithAgentAuth([], [], undefined, async () => {
      calls += 1;
      return response(401, { ok: false, error: { code: "unauthenticated", message: reason } });
    });
    const result = await client.exchangeAgentToken();
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
  }
});

test("merchant control plane, Payment Request, and Webhook clients share request ID and idempotency semantics", async () => {
  const calls = [];
  const client = createPaytobeClient({
    baseUrl: "https://platform.test",
    connectionToken: "connection-token-test",
    csrfToken: () => "csrf-in-memory",
    requestIdFactory: () => "request_auto",
    fetch: sequenceFetch(calls, [
      response(201, { ok: true, agent: { agent_id: "agent_one" } }),
      response(201, { ok: true, recipient: { recipient_id: "recipient_one" } }),
      response(201, { ok: true, payment_request: { request_id: "request_one" } }),
      response(201, { ok: true, webhook_endpoint: { webhook_endpoint_id: "endpoint_one" }, secret: `whsec_${"W".repeat(43)}` })
    ])
  });
  await client.createAgent({ name: "Agent", runtime: "node", environment: "testnet", allowed_scopes: [] }, { idempotencyKey: "idem_agent" });
  await client.createRecipient({ name: "Recipient" }, { requestId: "request_recipient" });
  await client.createPaymentRequest({ idempotency_key: "idem_payment" });
  await client.createWebhookEndpoint({ url: "https://hooks.test", event_types: ["payment_request.status_updated"] }, { idempotencyKey: "idem_webhook" });

  assert.equal(calls[0].url, "https://platform.test/v1/agents");
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[0].init.headers["x-csrf-token"], "csrf-in-memory");
  assert.equal(calls[0].init.headers["x-idempotency-key"], "idem_agent");
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.equal(calls[1].init.headers["x-request-id"], "request_recipient");
  assert.equal(calls[2].init.headers.authorization, "Bearer connection-token-test");
  assert.equal(calls[2].init.headers["x-idempotency-key"], "idem_payment");
  assert.equal(calls[3].url, "https://platform.test/v1/webhook-endpoints");
  assert.equal(calls[3].init.credentials, "include");
});

test("failure objects redact assertions, tokens, Secrets, and private material", async () => {
  const echoed = {
    ok: false,
    error: { code: "bad_request", message: "request rejected" },
    client_assertion: "header.payload.signature",
    access_token: tokenA,
    webhook_secret: `whsec_${"Q".repeat(43)}`,
    details: { authorization: `Bearer ${tokenB}`, private_key: "PRIVATE-MATERIAL", safe: "kept" }
  };
  const client = clientWithAgentAuth([], [], undefined, async () => response(400, echoed));
  const result = await client.exchangeAgentToken();
  const serialized = JSON.stringify(result);
  for (const value of ["header.payload.signature", tokenA, tokenB, `whsec_${"Q".repeat(43)}`, "PRIVATE-MATERIAL"]) {
    assert.equal(serialized.includes(value), false);
  }
  assert.equal(result.details.safe, "kept");
  assert.equal(result.access_token, "[REDACTED]");

  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = await readFile(path.resolve(here, "../src/index.js"), "utf8");
  assert.doesNotMatch(source, /(?:node:fs|from ["']fs["']|Deno\.read|Bun\.file)/);
  assert.doesNotMatch(source, /seed phrase value/i);
});

function clientWithAgentAuth(calls, responses, signer = () => "AQID", fetchOverride) {
  return createPaytobeClient({
    baseUrl: "https://platform.test",
    requestIdFactory: () => "request_generated",
    fetch: fetchOverride || sequenceFetch(calls, responses),
    agentAuth: {
      agentId: "agent_registered",
      clientId: "client_local",
      kid: "kid-local",
      scopes: ["payment.requests.create"],
      signer,
      keyHandle: "secure-handle-only",
      now: () => Date.parse("2026-08-02T00:00:00Z"),
      createJti: () => `jti_${++jtiSequence}`
    }
  });
}

function sequenceFetch(calls, responses) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    const next = responses.shift();
    assert.ok(next, `Unexpected fetch call to ${url}`);
    return next;
  };
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: "", text: async () => JSON.stringify(body) };
}
