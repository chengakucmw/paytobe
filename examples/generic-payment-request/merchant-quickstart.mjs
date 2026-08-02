import assert from "node:assert/strict";

import { createVelarumPayClient } from "../../packages/sdk-js/src/index.js";

const OFFICIAL_TESTNET_ORIGIN = "https://api-testnet.velarumpay.com";
const TEST_PUBLIC_KEY = `ed25519:${"A".repeat(43)}`;

export async function runOfflineMerchantQuickstart() {
  const calls = [];
  const fetch = createOfflinePlatformMock(calls);
  const anonymous = createVelarumPayClient({
    baseUrl: OFFICIAL_TESTNET_ORIGIN,
    fetch,
    requestIdFactory: sequentialIds("request")
  });

  await mustSucceed(anonymous.requestJson("POST", "/v1/merchant-accounts/registrations", {
    email: "developer@example.invalid"
  }, { auth: "none" }));
  const verified = await mustSucceed(anonymous.requestJson("POST", "/v1/merchant-accounts/email-verifications", {
    token: "mock_email_verification_token"
  }, { auth: "none" }));
  assert.equal(verified.account.status, "active");

  const organization = await mustSucceed(anonymous.requestJson("POST", "/v1/merchants", {
    display_name: "Offline Test Merchant",
    session_grant: verified.session_grant
  }, { auth: "none" }));
  const session = await mustSucceed(anonymous.requestJson("POST", "/v1/merchant-sessions", {
    merchant_id: organization.merchant.merchant_id,
    session_grant: organization.session_grant
  }, { auth: "none" }));
  const merchant = createVelarumPayClient({
    baseUrl: OFFICIAL_TESTNET_ORIGIN,
    fetch,
    csrfToken: session.csrf_token,
    requestIdFactory: sequentialIds("merchant-request")
  });
  const domain = await mustSucceed(merchant.requestJson("POST", "/v1/merchant-domains", {
    domain: "merchant.example.invalid",
    method: "dns_txt"
  }, { auth: "merchant" }));
  await mustSucceed(merchant.requestJson("POST", `/v1/merchant-domains/${domain.merchant_domain.domain_id}/verify`, {}, {
    auth: "merchant"
  }));

  const recipient = await mustSucceed(merchant.createRecipient({
    name: "Offline Test Recipient",
    network: "stellar_testnet",
    asset: "XLM",
    address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
  }));
  const recipientVerification = await mustSucceed(merchant.verifyRecipient(recipient.recipient.recipient_id, {
    recipient_version_id: recipient.recipient_version.recipient_version_id,
    type: "domain_proof",
    source_id: "source_test_0001",
    version: 1
  }));
  await mustSucceed(merchant.activateRecipientVersion(
    recipient.recipient.recipient_id,
    recipient.recipient_version.recipient_version_id,
    {
      evidence_id: recipientVerification.evidence.evidence_id,
      evidence_digest: recipientVerification.evidence.evidence_digest,
      version: 2
    }
  ));

  const agent = await mustSucceed(merchant.createAgent({
    name: "Offline Test Agent",
    runtime: "node",
    environment: "testnet",
    allowed_scopes: ["payment.requests.create", "payment.requests.read"]
  }));
  const credential = await mustSucceed(merchant.registerAgentCredential(agent.agent.agent_id, {
    kid: "credential_test_0001",
    alg: "Ed25519",
    public_key: TEST_PUBLIC_KEY,
    not_before: "2026-08-01T00:00:00.000Z",
    expires_at: "2027-08-01T00:00:00.000Z"
  }));
  await mustSucceed(merchant.activateAgentCredential(
    agent.agent.agent_id,
    credential.credential.credential_id,
    { challenge: credential.proof_challenge, signature: "mock_proof_signature" }
  ));
  await mustSucceed(merchant.updateAgent(agent.agent.agent_id, { status: "active", version: 1 }));

  const agentClient = createVelarumPayClient({
    baseUrl: OFFICIAL_TESTNET_ORIGIN,
    fetch,
    requestIdFactory: sequentialIds("agent-request"),
    agentAuth: {
      agentId: agent.agent.agent_id,
      clientId: "client_test_0001",
      kid: "credential_test_0001",
      scopes: ["payment.requests.create", "payment.requests.read"],
      keyHandle: "opaque_test_key_handle",
      now: () => 1_754_042_400_000,
      createJti: () => "jti_offline_quickstart",
      signer: ({ data, keyHandle }) => {
        assert.equal(keyHandle, "opaque_test_key_handle");
        assert.ok(data instanceof Uint8Array);
        return new Uint8Array(64);
      }
    }
  });
  const claim = await mustSucceed(agentClient.claimConnectInvitation(
    `velarumpay-connect:ck_${"B".repeat(43)}`,
    ["payment.requests.create", "payment.requests.read"]
  ));
  await mustSucceed(agentClient.getConnectInvitation(claim.connect_invitation.connect_invitation_id, claim.claim_token));
  await mustSucceed(agentClient.exchangeConnectInvitation(claim.connect_invitation.connect_invitation_id, claim.claim_token));

  const payment = await mustSucceed(agentClient.createPaymentRequest({
    recipient_id: recipient.recipient.recipient_id,
    recipient_version_id: recipient.recipient_version.recipient_version_id,
    payment: { amount: "1.00" },
    expires_at: "2026-08-03T00:00:00.000Z",
    policy: { requires_user_approval: true }
  }, { idempotencyKey: "payment-quickstart" }));
  assert.equal(payment.payment_request.status, "pending_user_approval");

  assert.equal(organization.merchant.merchant_id, "merchant_test_0001");
  assert.ok(calls.every((call) => !call.body.includes("PRIVATE KEY")));
  return Object.freeze({ ok: true, completed_steps: 11, calls: calls.length });
}

function createOfflinePlatformMock(calls) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
  return async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method || "GET";
    const headers = new Headers(init.headers || {});
    const body = String(init.body || "");
    calls.push({ method, path, body });
    assert.equal(new URL(url).origin, OFFICIAL_TESTNET_ORIGIN);

    if (path === "/v1/agent-auth/token") {
      const assertion = JSON.parse(body).client_assertion;
      assert.equal(assertion.split(".").length, 3);
      return json({ ok: true, access_token: `vat_${"T".repeat(43)}`, expires_in: 120, token_type: "Bearer" });
    }
    if (path === "/v1/connect-invitations/claim") {
      assert.match(headers.get("authorization") || "", /^Bearer vat_/);
      return json({ ok: true, claim_token: "claim_tok_offline_mock_value", connect_invitation: {
        connect_invitation_id: "invitation_test_0001", status: "claimed"
      } }, 201);
    }
    if (path === "/v1/connect-invitations/invitation_test_0001" && method === "GET") {
      assert.equal(headers.get("authorization"), "Bearer claim_tok_offline_mock_value");
      return json({ ok: true, connect_invitation: { connect_invitation_id: "invitation_test_0001", status: "approved" } });
    }
    if (path === "/v1/connect-invitations/invitation_test_0001/exchange") {
      return json({ ok: true, connection: { connection_id: "connection_test_0001", connection_token: "conn_tok_offline_mock_value" } });
    }
    if (path === "/v1/payment-requests") {
      assert.equal(headers.get("authorization"), "Bearer conn_tok_offline_mock_value");
      assert.ok(JSON.parse(body).recipient_id);
      assert.equal(JSON.parse(body).policy.requires_user_approval, true);
      return json({ ok: true, payment_request: { request_id: "payment_request_test_0001", status: "pending_user_approval" } }, 201);
    }

    if (!["/v1/merchant-accounts/registrations", "/v1/merchant-accounts/email-verifications", "/v1/merchants", "/v1/merchant-sessions"].includes(path)) {
      assert.equal(init.credentials, "include");
      if (method !== "GET") assert.equal(headers.get("x-csrf-token"), "mcsrf_public_offline_mock_value");
    }
    const fixtures = {
      "/v1/merchant-accounts/registrations": { ok: true, accepted: true },
      "/v1/merchant-accounts/email-verifications": { ok: true, account: { account_id: "account_test_0001", status: "active" }, session_grant: "msgrant_public_offline_mock_value" },
      "/v1/merchants": { ok: true, merchant: { merchant_id: "merchant_test_0001", status: "pending_verification" }, session_grant: "msgrant_public_offline_session_value" },
      "/v1/merchant-sessions": { ok: true, session: { session_id: "session_test_0001" }, csrf_token: "mcsrf_public_offline_mock_value" },
      "/v1/merchant-domains": { ok: true, merchant_domain: { domain_id: "domain_test_0001", status: "pending" } },
      "/v1/merchant-domains/domain_test_0001/verify": { ok: true, merchant_domain: { domain_id: "domain_test_0001", status: "verified" } },
      "/v1/recipients": { ok: true, recipient: { recipient_id: "recipient_test_0001", status: "pending_verification" }, recipient_version: { recipient_version_id: "recipient_version_test_0001" } },
      "/v1/recipients/recipient_test_0001/verify": { ok: true, recipient: { recipient_id: "recipient_test_0001" }, evidence: { evidence_id: "evidence_test_0001", evidence_digest: "sha256:public-test-evidence" } },
      "/v1/recipients/recipient_test_0001/versions/recipient_version_test_0001/activate": { ok: true, recipient: { recipient_id: "recipient_test_0001", status: "active" } },
      "/v1/agents": { ok: true, agent: { agent_id: "agent_test_0001", status: "draft", version: 1 } },
      "/v1/agents/agent_test_0001": { ok: true, agent: { agent_id: "agent_test_0001", status: "active", version: 2 } },
      "/v1/agents/agent_test_0001/credentials": { ok: true, credential: { credential_id: "credential_test_0001", status: "pending_proof" }, proof_challenge: `acpop_${"C".repeat(43)}` },
      "/v1/agents/agent_test_0001/credentials/credential_test_0001/activate": { ok: true, credential: { credential_id: "credential_test_0001", status: "active" } }
    };
    const fixture = fixtures[path];
    assert.ok(fixture, `Offline mock has no fixture for ${method} ${path}`);
    return json(fixture, method === "POST" ? 201 : 200);
  };
}

function sequentialIds(prefix) {
  let value = 0;
  return () => `${prefix}_${String(++value).padStart(4, "0")}`;
}

async function mustSucceed(promise) {
  const result = await promise;
  assert.notEqual(result?.ok, false, result?.error?.code || "request failed");
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runOfflineMerchantQuickstart();
  console.log(`Offline merchant quickstart passed: ${result.completed_steps} steps, ${result.calls} mock calls.`);
}
