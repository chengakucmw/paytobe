import assert from "node:assert/strict";
import test from "node:test";
import { PortalApiError } from "../public/modules/api-client.js";
import { createAgentsModel, renderAgents } from "../src/pages/agents/index.js";

const agent = Object.freeze({ agent_id: "agent_one", name: "Checkout Agent", runtime: "node", environment: "testnet", allowed_scopes: ["payment.requests.create"], status: "active", version: 2 });
const credential = Object.freeze({ credential_id: "credential_one", kid: "checkout-2026-08", alg: "Ed25519", public_key: "PUBLIC_KEY_MUST_NOT_RENDER", status: "active", not_before: "2026-08-01T00:00:00Z", expires_at: "2026-09-01T00:00:00Z", last_used_at: "2026-08-02T00:00:00Z", version: 3 });

test("Agent and credential lifecycle renders safe operational fields only", async () => {
  const model = createAgentsModel({ api: mockApi(), session: session("owner") });
  await model.load();
  const html = renderAgents(model.getState(), true);
  assert.match(html, /checkout-2026-08|Active|Valid from|Expires|Last used|Overlap ends/i);
  assert.doesNotMatch(html, /PUBLIC_KEY_MUST_NOT_RENDER|access_token|client_assertion|secret_value|private_key/i);
});

test("registration sends only public key fields and activates with local signature proof", async () => {
  const calls = [];
  const model = createAgentsModel({ api: mockApi({ calls }), session: session("developer") });
  await model.load();
  const registered = await model.registerCredential({ kid: "next-key", publicKey: "Ed25519PublicValue", notBefore: "2026-08-02T01:00", expiresAt: "2026-09-02T01:00" });
  assert.ok(registered);
  const registration = calls.find(([name]) => name === "registerAgentCredential")[2];
  assert.deepEqual(Object.keys(registration).sort(), ["alg", "expires_at", "kid", "not_before", "public_key"]);
  assert.equal(registration.alg, "Ed25519");
  await model.activateCredential("local-agent-signature");
  const activation = calls.find(([name]) => name === "activateAgentCredential")[3];
  assert.deepEqual(Object.keys(activation).sort(), ["challenge", "signature"]);
  assert.equal(model.getState().pendingProof, null);
  assert.doesNotMatch(renderAgents(model.getState(), true), /local-agent-signature|acpop_A/);
});

test("private key material is rejected before any API call", async () => {
  const calls = [];
  const model = createAgentsModel({ api: mockApi({ calls }), session: session("owner") });
  await model.load();
  await model.registerCredential({ kid: "bad", publicKey: "-----BEGIN PRIVATE KEY-----\nforbidden", notBefore: "2026-08-02T01:00", expiresAt: "2026-09-02T01:00" });
  assert.equal(calls.some(([name]) => name === "registerAgentCredential"), false);
  assert.match(model.getState().message, /Private key or seed material was rejected/);
});

test("scope change, suspension, and credential revocation require confirmation and step-up", async () => {
  const calls = [];
  let confirmed = true;
  const model = createAgentsModel({ api: mockApi({ calls }), session: session("admin"), confirmAction: () => confirmed });
  await model.load();
  await model.changeScopes(["payment.requests.read"], true);
  assert.equal(model.getState().stepUpRequired, true);
  assert.equal(calls.some(([name]) => name === "updateAgent"), false);
  await model.completeStepUp("mstep_valid");
  await model.changeScopes(["payment.requests.read"], true);
  assert.deepEqual(calls.find(([name]) => name === "updateAgent")[2], { allowed_scopes: ["payment.requests.read"], version: 2 });

  confirmed = false;
  await model.changeStatus("suspended", true);
  assert.equal(calls.filter(([name]) => name === "updateAgent").length, 1);
  confirmed = true;
  await model.completeStepUp("mstep_valid_again");
  await model.revokeCredential("credential_one", 3, true);
  assert.deepEqual(calls.find(([name]) => name === "revokeAgentCredential").slice(1), ["agent_one", "credential_one", { version: 3 }]);
});

test("Viewer has no controls and cross-tenant, revoked, expired, and conflict states fail safely", async () => {
  const viewerCalls = [];
  const viewer = createAgentsModel({ api: mockApi({ calls: viewerCalls }), session: session("viewer") });
  await viewer.load();
  const viewerHtml = renderAgents(viewer.getState(), false);
  assert.doesNotMatch(viewerHtml, /Register Agent|Add public key|Revoke credential|Save scopes/);
  await viewer.registerCredential({});
  assert.equal(viewerCalls.some(([name]) => name === "registerAgentCredential"), false);

  for (const [error, expected] of [
    [new PortalApiError("other tenant", 404, "resource_not_found"), "unavailable"],
    [new PortalApiError("revoked", 409, "agent_revoked"), "revoked"],
    [new PortalApiError("expired", 409, "invalid_credential_transition"), "revoked or expired"],
    [new PortalApiError("conflict", 409, "concurrency_conflict"), "changed elsewhere"]
  ]) {
    const api = mockApi({ mutationError: error });
    const model = createAgentsModel({ api, session: session("owner"), confirmAction: () => true });
    await model.load();
    await model.completeStepUp("mstep_valid");
    if (error.code === "resource_not_found") await model.revokeCredential("credential_one", 3, true);
    else await model.changeStatus("suspended", true);
    assert.match(model.getState().message, new RegExp(expected, "i"));
    if (error.code === "resource_not_found") {
      assert.deepEqual(model.getState().agents, []);
      assert.deepEqual(model.getState().credentials, []);
    }
  }
});

function session(role) { return { merchantId: "merchant_one", role }; }

function mockApi({ calls = [], mutationError = null } = {}) {
  return {
    async listAgents() { calls.push(["listAgents"]); return [{ ...agent, access_token: "access_token_should_drop" }]; },
    async listAgentCredentials(id) { calls.push(["listAgentCredentials", id]); return [{ ...credential, client_assertion: "client_assertion_should_drop", secret: "secret_value" }]; },
    async createAgent(input) { calls.push(["createAgent", input]); return { ...agent, agent_id: "agent_two", ...input, status: "draft", version: 1 }; },
    async updateAgent(id, input) { calls.push(["updateAgent", id, input]); if (mutationError) throw mutationError; return { ...agent, agent_id: id, ...input, version: input.version + 1 }; },
    async registerAgentCredential(id, input) { calls.push(["registerAgentCredential", id, input]); if (mutationError) throw mutationError; return { ok: true, credential: { ...credential, credential_id: "credential_two", kid: input.kid, status: "pending_proof", version: 1 }, proof_challenge: `acpop_${"A".repeat(43)}`, proof_expires_at: "2026-08-02T02:00:00Z", private_key: "must_drop" }; },
    async activateAgentCredential(id, credentialId, input) { calls.push(["activateAgentCredential", id, credentialId, input]); if (mutationError) throw mutationError; return { ok: true, credential: { ...credential, credential_id: credentialId, status: "active", version: 2 } }; },
    async revokeAgentCredential(id, credentialId, input) { calls.push(["revokeAgentCredential", id, credentialId, input]); if (mutationError) throw mutationError; return { ok: true, credential: { ...credential, credential_id: credentialId, status: "revoked", version: input.version + 1 } }; },
    async startStepUp() { calls.push(["startStepUp"]); return { ok: true }; },
    async completeStepUp(value) { calls.push(["completeStepUp", value]); return { ok: true }; }
  };
}
