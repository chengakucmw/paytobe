import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

import { createConnectInvitationsRouter } from "../../services/platform-api/src/routes/connect-invitations.js";
import { createPairingRouter } from "../../services/platform-api/src/routes/pairing.js";
import { createConnectKey, id, opaqueToken } from "../../services/platform-api/src/crypto.js";
import { Store } from "../../services/platform-api/src/store.js";

test("wallet approval uses live verified identity and fails closed after lifecycle changes", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-connect-review-"));
  const store = new Store(path.join(directory, "review.sqlite"));
  seedIdentity(store);
  const audits = [];
  const app = express();
  app.use(express.json());
  const observability = { recordAuditEvent: (...args) => audits.push(args), incrementCounter() {} };
  const sendApiError = (res, status, code, message, options = {}) => res.status(status).json({ error: { code, message, ...options } });
  const verifyAppBody = (req) => req.body?.device_id === "wallet_review" && req.body?.token === "wallet_secret"
    ? { ok: true } : { ok: false, status: 401, error: "invalid" };
  const platformCore = {
    clock: { nowIso: () => new Date().toISOString(), after: (ms) => new Date(Date.now() + ms).toISOString() },
    random: { connectKey: createConnectKey, id, opaqueToken }
  };
  app.use("/v1/connect-invitations", createConnectInvitationsRouter({
    store,
    observability,
    sendApiError,
    verifyAppBody,
    verifyAppQuery: (req) => req.query?.device_id === "wallet_review" && req.query?.token === "wallet_secret"
      ? { ok: true } : { ok: false, status: 401, error: "invalid" },
    verifyAgentAccessToken: () => ({ ok: false, status: 401, code: "unauthenticated", message: "unused" }),
    agentService: { get: () => ({ ok: false }) },
    notifyApp() {},
    platformCore
  }));
  app.use("/v1/pairing", createPairingRouter({
    store,
    observability,
    sendApiError,
    uniquePairingCode: () => "123456",
    resolvePairingSession: (sessionId) => store.pairingSession(sessionId),
    recordPairingExpired() {},
    verifyAppBody,
    platformCore
  }));
  const server = await new Promise((resolve, reject) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
    value.once("error", reject);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const first = claim(store);
  let response = await fetch(`${origin}/v1/connect-invitations/${first.connect_invitation_id}`, {
    headers: { "x-app-device-id": "wallet_review", "x-app-device-token": "wallet_secret" }
  });
  let payload = await response.json();
  assert.equal(payload.connect_invitation.identity_review.state, "verified");
  assert.equal(payload.connect_invitation.identity_review.approval_allowed, true);
  assert.equal(payload.connect_invitation.identity_review.merchant.display_name, "Verified Merchant");
  assert.equal(payload.connect_invitation.identity_review.merchant.verified_domain, "pay.verified.example");
  assert.equal(payload.connect_invitation.identity_review.credential.status, "active");

  response = await fetch(`${origin}/v1/connect-invitations/${first.connect_invitation_id}/approve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: "wallet_review", token: "wallet_secret", approved_scopes: ["payment.requests.create"] })
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_request");

  response = await fetch(`${origin}/v1/connect-invitations/${first.connect_invitation_id}/approve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: "wallet_review", token: "wallet_secret" })
  });
  payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(payload.connect_invitation.status, "approved");
  assert.equal(payload.connection.connection_token, undefined);

  const second = claim(store);
  store.db.prepare("UPDATE agents SET status = 'suspended' WHERE agent_id = 'agent_review'").run();
  response = await fetch(`${origin}/v1/connect-invitations/${second.connect_invitation_id}/approve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: "wallet_review", token: "wallet_secret" })
  });
  payload = await response.json();
  assert.equal(response.status, 409);
  assert.equal(payload.error.code, "connect_identity_not_approvable");
  assert.equal(payload.error.details.state, "suspended");
  assert.equal(store.connectInvitation(second.connect_invitation_id).status, "claimed");

  response = await fetch(`${origin}/v1/connect-invitations/${second.connect_invitation_id}/reject`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: "wallet_review", token: "wallet_secret" })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).connect_invitation.status, "rejected");

  store.db.prepare("UPDATE agents SET status = 'active' WHERE agent_id = 'agent_review'").run();
  const third = claim(store);
  store.db.prepare("UPDATE agents SET name = 'Renamed Agent' WHERE agent_id = 'agent_review'").run();
  response = await fetch(`${origin}/v1/pairing/sessions/${third.pairing_session_id}/approve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: "wallet_review", token: "wallet_secret", approved_scopes: ["payment.requests.create"] })
  });
  payload = await response.json();
  assert.equal(response.status, 409);
  assert.equal(payload.error.code, "connect_identity_not_approvable");
  assert.equal(payload.error.details.reason_code, "identity_facts_changed");
  assert.equal(audits.some(([action]) => action === "connect_invitation.approved"), true);
});

function claim(store) {
  const connectKey = createConnectKey();
  const invitation = store.createConnectInvitation(id("cinv"), connectKey, {
    target_app_device_id: "wallet_review",
    expires_at: new Date(Date.now() + 300_000).toISOString()
  });
  return store.claimConnectInvitationAndCreatePairingSession(connectKey, opaqueToken("claim_tok"), id("pair"), {
    identity_assurance: "registered",
    requested_scopes: ["payment.requests.create"],
    agent_identity: {
      merchant_id: "merchant_review", agent_id: "agent_review", client_id: "client_review",
      credential_id: "credential_review", agent_name: "Verified Agent", runtime: "node", verified: true
    },
    auth_binding: {
      merchant_id: "merchant_review", agent_id: "agent_review", client_id: "client_review",
      credential_id: "credential_review", agent_revocation_version: 0, credential_revocation_version: 0
    }
  }).connect_invitation;
}

function seedIdentity(store) {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  store.db.prepare(`INSERT INTO merchants
    (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
    VALUES ('merchant_review', 'Verified Merchant', 'active', 'verified', 1, ?, ?)`).run(now, now);
  store.db.prepare(`INSERT INTO merchant_domains
    (domain_id, merchant_id, domain, method, challenge_hash, status, verified_at, version, created_at, updated_at)
    VALUES ('domain_review', 'merchant_review', 'pay.verified.example', 'dns_txt', 'sha256:test', 'verified', ?, 1, ?, ?)`)
    .run(now, now, now);
  store.db.prepare(`INSERT INTO agents
    (agent_id, merchant_id, name, runtime, environment, allowed_scopes_json, token_revocation_version, status, version, created_at, updated_at)
    VALUES ('agent_review', 'merchant_review', 'Verified Agent', 'node', 'testnet', '["payment.requests.create"]', 0, 'active', 1, ?, ?)`)
    .run(now, now);
  store.db.prepare(`INSERT INTO agent_credentials
    (credential_id, merchant_id, agent_id, kid, alg, public_key, status, not_before, expires_at,
     revocation_version, version, created_at, updated_at)
    VALUES ('credential_review', 'merchant_review', 'agent_review', 'kid_review', 'EdDSA', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'active', ?, ?, 0, 1, ?, ?)`)
    .run(now, future, now, now);
}
