import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

import { createAuthContext } from "../../packages/protocol/src/platform-api.js";
import { createConnectKey, id, opaqueToken } from "../../services/platform-api/src/crypto.js";
import { createConnectInvitationsRouter } from "../../services/platform-api/src/routes/connect-invitations.js";
import { Store } from "../../services/platform-api/src/store.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "Paytobe-auth-connect-"));
const store = new Store(path.join(directory, "connect.sqlite"));
const agent = {
  agent_id: "agent_verified",
  merchant_id: "merchant_verified",
  name: "Verified checkout Agent",
  runtime: "node",
  source_domain: "checkout.example.invalid",
  allowed_scopes: ["payment.requests.create", "payment.requests.read"],
  status: "active"
};
const authContext = createAuthContext({
  actor_type: "agent_client",
  actor_id: "client_verified",
  merchant_id: agent.merchant_id,
  agent_id: agent.agent_id,
  client_id: "client_verified",
  credential_id: "credential_verified",
  scopes: agent.allowed_scopes,
  auth_method: "agent_assertion"
}, { requestId: "request_connect_claim" });
const audit = [];
let origin = "";
let server;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/v1/connect-invitations", createConnectInvitationsRouter({
    store,
    observability: {
      recordAuditEvent: (...args) => audit.push(args),
      incrementCounter() {}
    },
    sendApiError: (res, status, code, message, options = {}) => res.status(status).json({ error: { code, message, ...options } }),
    verifyAppBody: () => ({ ok: false, status: 401, error: "not used" }),
    verifyAppQuery: () => ({ ok: false, status: 401, error: "not used" }),
    verifyAgentAccessToken: (req) => req.get("authorization") === "Bearer vat_good"
      ? { ok: true, auth_context: authContext }
      : { ok: false, status: 401, code: "unauthenticated", message: "Agent access token is invalid" },
    agentService: {
      get: (scope, agentId) => scope.merchant_id === agent.merchant_id && agentId === agent.agent_id
        ? { ok: true, agent }
        : { ok: false, status: 404 }
    },
    notifyApp() {},
    platformCore: {
      clock: { nowIso: () => new Date().toISOString(), after: (ms) => new Date(Date.now() + ms).toISOString() },
      random: { connectKey: createConnectKey, id, opaqueToken }
    }
  }));
  server = await new Promise((resolve, reject) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
    value.once("error", reject);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("canonical claim derives every identity binding from Agent AuthContext and still awaits wallet approval", async () => {
  const invitation = createInvitation();
  const claimed = await claim(invitation.connect_key, {
    requested_scopes: ["payment.requests.create", "payment.requests.read"]
  });
  assert.equal(claimed.status, 201);
  assert.match(claimed.body.claim_token, /^claim_tok_[A-Za-z0-9_-]{43}$/);
  assert.equal(claimed.body.connect_invitation.status, "claimed");
  assert.equal(claimed.body.connect_invitation.identity_assurance, "registered");
  assert.equal(claimed.body.pairing_session.status, "pending");
  assert.equal(claimed.body.connect_invitation.connection_id, null, "authentication is not wallet approval");
  assert.deepEqual(claimed.body.pairing_session.agent_identity, {
    agent_id: agent.agent_id,
    agent_name: agent.name,
    runtime: agent.runtime,
    source: agent.source_domain,
    merchant_id: agent.merchant_id,
    client_id: authContext.client_id,
    credential_id: authContext.credential_id,
    verified: true
  });
  const stored = store.connectInvitation(invitation.connect_invitation.connect_invitation_id);
  assert.equal(Object.hasOwn(stored, "connect_key"), false);
  assert.equal(Object.hasOwn(stored, "claim_token"), false);
  assert.match(stored.connect_key_hash, /^sha256:/);
  assert.match(stored.claim_token_hash, /^sha256:/);
});

test("anonymous, self-declared identity, scope escalation, cancellation, expiry, and consumption fail closed", async () => {
  const anonymousInvitation = createInvitation();
  assert.equal((await claim(anonymousInvitation.connect_key, {}, "")).status, 401);

  for (const forged of [
    { agent_identity: { agent_id: "attacker" } },
    { merchant_id: "merchant_other" },
    { credential_id: "credential_other" }
  ]) {
    const invitation = createInvitation();
    const result = await claim(invitation.connect_key, forged);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "self_declared_identity_forbidden");
    assert.equal(store.connectInvitation(invitation.connect_invitation.connect_invitation_id).status, "waiting");
  }

  const escalationInvitation = createInvitation();
  const escalation = await claim(escalationInvitation.connect_key, { requested_scopes: ["wallet.addresses.read"] });
  assert.equal(escalation.status, 403);
  assert.equal(escalation.body.error.code, "scope_denied");

  const cancelledInvitation = createInvitation();
  store.cancelConnectInvitation(cancelledInvitation.connect_invitation.connect_invitation_id, "wallet_1");
  assert.equal((await claim(cancelledInvitation.connect_key)).body.error.code, "connect_key_unavailable");

  const expiredInvitation = createInvitation(new Date(Date.now() - 1_000).toISOString());
  assert.equal((await claim(expiredInvitation.connect_key)).body.error.code, "connect_key_unavailable");

  const consumedInvitation = createInvitation();
  assert.equal((await claim(consumedInvitation.connect_key)).status, 201);
  assert.equal((await claim(consumedInvitation.connect_key)).body.error.code, "connect_key_unavailable");
});

test("concurrent use of one Connect Key has exactly one atomic winner", async () => {
  const invitation = createInvitation();
  const attempts = await Promise.all(Array.from({ length: 12 }, () => claim(invitation.connect_key)));
  assert.equal(attempts.filter((result) => result.status === 201).length, 1);
  assert.equal(attempts.filter((result) => result.status === 409 && result.body.error.code === "connect_key_unavailable").length, 11);
  assert.equal(Object.values(store.state.pairingSessions)
    .filter((session) => session.connect_invitation_id === invitation.connect_invitation.connect_invitation_id).length, 1);
});

function createInvitation(expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()) {
  const connectKey = createConnectKey();
  const connectInvitation = store.createConnectInvitation(id("cinv"), connectKey, {
    target_app_device_id: "wallet_1",
    expires_at: expiresAt
  });
  return { connect_key: connectKey, connect_invitation: connectInvitation };
}

async function claim(connectKey, extra = {}, authorization = "Bearer vat_good") {
  const response = await fetch(`${origin}/v1/connect-invitations/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    body: JSON.stringify({ connect_key: connectKey, requested_scopes: ["payment.requests.create"], ...extra })
  });
  return { status: response.status, body: await response.json() };
}
