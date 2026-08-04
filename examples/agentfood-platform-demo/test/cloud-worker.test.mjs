import assert from "node:assert/strict";
import test from "node:test";
import worker from "../dist/server/index.js";

async function call(path, options = {}, env = {}) {
  const response = await worker.fetch(new Request(`https://agentfood.example${path}`, options), env);
  const result = response.headers.get("content-type")?.includes("application/json") ? await response.json() : await response.text();
  return { response, result };
}

function jsonBody(value) {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

test("the hosted page exposes the conversation-first real Connect Key experience", async () => {
  const home = await call("/");
  assert.equal(home.response.status, 200);
  assert.match(home.result, /class="product-workspace"/);
  assert.match(home.result, /What are you in the mood for\?/);
  assert.match(home.result, /Continue with Google/);
  assert.match(home.result, /\/signin-with-chatgpt\?return_to=%2F/);
  assert.match(home.result, /Real Connect Key/);
  assert.match(home.result, /https:\/\/agentfood\.example\/assets\/agentfood-social-v3\.png/);

  const app = await call("/app.js");
  assert.equal(app.response.status, 200);
  assert.doesNotMatch(app.result, /\/v1\/integrations\/agentfood|velarumpay-connect-testnet/);
  assert.match(app.result, /fetch\(path,/);

  for (const path of ["/assets/agentfood-dishes-v2.jpg", "/assets/agentfood-social-v3.png"]) {
    const image = await worker.fetch(new Request(`https://agentfood.example${path}`));
    assert.equal(image.status, 200);
    assert.match(image.headers.get("content-type"), /^image\/(jpeg|png)$/);
    assert.ok((await image.arrayBuffer()).byteLength > 100_000);
  }

  for (const path of ["/fonts/Poppins-Regular.ttf", "/fonts/DMSans-Variable.ttf", "/fonts/JetBrainsMono-Variable.ttf"]) {
    const font = await worker.fetch(new Request(`https://agentfood.example${path}`));
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("content-type"), "font/ttf");
    assert.ok((await font.arrayBuffer()).byteLength > 100_000);
  }

  const catalog = await call("/api/catalog");
  assert.equal(catalog.response.status, 200);
  assert.equal(catalog.result.hosting_mode, "cloud_real_connect");
  assert.equal(catalog.result.merchants.length, 3);
});

test("the hosted identity session reflects Sites-authenticated visitor headers", async () => {
  const anonymous = await call("/api/auth/session");
  assert.equal(anonymous.response.status, 200);
  assert.equal(anonymous.result.authenticated, false);
  assert.equal(anonymous.result.user, null);

  const signedIn = await call("/api/auth/session", {
    headers: {
      "oai-authenticated-user-email": "demo@example.com",
      "oai-authenticated-user-full-name": "Demo%20Diner",
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8"
    }
  });
  assert.equal(signedIn.response.status, 200);
  assert.equal(signedIn.result.authenticated, true);
  assert.deepEqual(signedIn.result.user, { email: "demo@example.com", name: "Demo Diner" });
});

test("hosted AgentFood uses an Ed25519 Agent Assertion and standard Platform contracts", async (t) => {
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const env = {
    VELARUMPAY_CONNECT_PLATFORM_URL: "https://platform.example",
    AGENTFOOD_AGENT_ID: "agentfood-testnet",
    AGENTFOOD_AGENT_CLIENT_ID: "agentfood-cloud-demo",
    AGENTFOOD_AGENT_CREDENTIAL_KID: "agentfood-reference-key",
    AGENTFOOD_AGENT_CREDENTIAL_PRIVATE_KEY_JWK: JSON.stringify(privateJwk)
  };
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/v1/agent-auth/token")) {
      const assertion = JSON.parse(options.body).client_assertion;
      const [protectedPart, claimsPart] = assertion.split(".");
      assert.deepEqual(JSON.parse(Buffer.from(protectedPart, "base64url")), { alg: "EdDSA", kid: "agentfood-reference-key", typ: "JWT" });
      const claims = JSON.parse(Buffer.from(claimsPart, "base64url"));
      assert.equal(claims.iss, "agentfood-testnet");
      assert.equal(claims.sub, "agentfood-cloud-demo");
      return new Response(JSON.stringify({ ok: true, access_token: `vat_${"A".repeat(43)}`, expires_in: 300 }), { status: 200 });
    }
    if (String(url).endsWith("/v1/connect-invitations/claim")) {
      assert.equal(options.headers.authorization, `Bearer vat_${"A".repeat(43)}`);
      const body = JSON.parse(options.body);
      assert.equal(Object.hasOwn(body, "agent_identity"), false);
      return new Response(JSON.stringify({
        ok: true,
        claim_token: `claim_tok_${"B".repeat(43)}`,
        connect_invitation: { connect_invitation_id: "cinv_standard", status: "claimed", identity_assurance: "registered" },
        pairing_session: { pairing_session_id: "pair_standard", status: "pending" }
      }), { status: 201 });
    }
    if (String(url).endsWith("/v1/transaction-contexts")) {
      const body = JSON.parse(options.body);
      assert.equal(body.type, "generic");
      assert.equal(body.metadata.food_order.demo, true);
      return new Response(JSON.stringify({ ok: true, context: body }), { status: 201 });
    }
    if (String(url).endsWith("/v1/payment-requests")) {
      const body = JSON.parse(options.body);
      assert.equal(body.recipient_id, "agentfood-reference-recipient");
      assert.deepEqual(Object.keys(body.payment), ["amount"]);
      assert.equal(Object.hasOwn(body.metadata, "food_order"), false);
      return new Response(JSON.stringify({ ok: true, payment_request: { ...body, request_id: "prq_standard", status: "pending" } }), { status: 201 });
    }
    throw new Error(`Unexpected remote request: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const claimed = await call("/api/chat", jsonBody({ message: `Use velarumpay-connect:ck_${"C".repeat(43)}` }), env);
  assert.equal(claimed.response.status, 201);
  assert.equal(claimed.result.connect_invitation_id, "cinv_standard");
  assert.equal(claimed.result.connect_invitation.identity_assurance, "registered");

  const order = await call("/api/chat", jsonBody({
    message: "Find me spicy vegetarian noodles under 20 XLM",
    connection_token: `conn_tok_${"D".repeat(43)}`,
    preferred_merchant_id: "noodle-atelier"
  }), env);
  assert.equal(order.response.status, 201);
  assert.equal(order.result.payment_request.request_id, "prq_standard");
  assert.equal(calls.length, 4);
});

test("legacy hosted APIs are absent and standard routes fail closed without Agent configuration", async () => {
  const legacy = await call("/v1/devices/app", jsonBody({ device_id: "legacy", token: "legacy-token-123456" }));
  assert.equal(legacy.response.status, 404);
  assert.equal(legacy.result.error.code, "not_found");

  const claim = await call("/api/chat", jsonBody({ message: `Use velarumpay-connect:ck_${"E".repeat(43)}` }));
  assert.equal(claim.response.status, 503);
  assert.equal(claim.result.error.code, "agent_platform_unavailable");

  const exchange = await call("/api/connect", jsonBody({
    connect_invitation_id: "cinv_retired",
    claim_token: `claim_${"F".repeat(43)}`
  }));
  assert.equal(exchange.response.status, 503);
  assert.equal(exchange.result.error.code, "agent_platform_unavailable");
});
