import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "Paytobe-connect-invitations-"));
process.env.VP_NO_AUTO_LISTEN = "1";
process.env.RELAY_STORE_DRIVER = "json";
process.env.RELAY_STORE_PATH = path.join(storeDir, "relay-store.json");

const { server, store } = await import("../../services/platform-api/src/server.js");

async function listen() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close() {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(5_000),
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  return { response, body };
}

const wallet = { device_id: "wallet_connect_owner", token: "wallet-owner-token" };
const otherWallet = { device_id: "wallet_connect_other", token: "wallet-other-token" };
const agent = {
  agent_id: "agentfood-demo",
  agent_name: "AgentFood Demo",
  runtime: "node",
  source: "reference-demo"
};

let base;
test.before(async () => {
  base = await listen();
});
test.after(close);

test("one-time Connect Invitation completes only after the owning wallet approves", async () => {
  for (const device of [wallet, otherWallet]) {
    const registered = await request(base, "/v1/devices/app", {
      method: "POST",
      body: JSON.stringify(device)
    });
    assert.equal(registered.response.status, 200);
  }

  const idempotentRegistration = await request(base, "/v1/devices/app", {
    method: "POST",
    body: JSON.stringify(wallet)
  });
  assert.equal(idempotentRegistration.response.status, 200);

  const takeoverRegistration = await request(base, "/v1/devices/app", {
    method: "POST",
    body: JSON.stringify({ device_id: wallet.device_id, token: "attacker-token" })
  });
  assert.equal(takeoverRegistration.response.status, 409);
  assert.equal(takeoverRegistration.body.error.code, "app_device_exists");

  const unauthenticated = await request(base, "/v1/connect-invitations", {
    method: "POST",
    body: JSON.stringify({ device_id: wallet.device_id, token: "wrong-token" })
  });
  assert.equal(unauthenticated.response.status, 401);

  const created = await request(base, "/v1/connect-invitations", {
    method: "POST",
    body: JSON.stringify(wallet)
  });
  assert.equal(created.response.status, 201);
  assert.match(created.body.connect_key, /^Paytobe-connect:ck_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.body.connect_key.includes(":v1:"), false);
  assert.equal(created.body.connect_invitation.status, "waiting");
  const invitationId = created.body.connect_invitation.connect_invitation_id;

  const invalid = await request(base, "/v1/connect-invitations/claim/legacy", {
    method: "POST",
    body: JSON.stringify({
      connect_key: "Paytobe-connect:ck_not-a-real-key",
      agent_identity: agent
    })
  });
  assert.equal(invalid.response.status, 409);
  assert.equal(invalid.body.error.code, "connect_key_unavailable");

  const claimed = await request(base, "/v1/connect-invitations/claim/legacy", {
    method: "POST",
    body: JSON.stringify({
      connect_key: created.body.connect_key,
      agent_identity: agent,
      requested_scopes: ["payment.requests.create", "payment.requests.read"]
    })
  });
  assert.equal(claimed.response.status, 201);
  assert.match(claimed.body.claim_token, /^claim_tok_[A-Za-z0-9_-]{43}$/);
  assert.equal(claimed.body.connect_invitation.status, "claimed");
  assert.equal(claimed.body.connect_invitation.identity_assurance, "unverified");
  assert.equal(claimed.body.warnings.some((warning) => warning.code === "legacy_connect_claim_deprecated"), true);
  assert.equal(claimed.body.pairing_session.connect_invitation_id, invitationId);
  const claimToken = claimed.body.claim_token;
  const pairingSessionId = claimed.body.pairing_session.pairing_session_id;

  const ownedList = await request(base, "/v1/connect-invitations", {
    headers: {
      "x-app-device-id": wallet.device_id,
      "x-app-device-token": wallet.token
    }
  });
  assert.equal(ownedList.response.status, 200);
  assert.equal(ownedList.body.items.some((item) => item.connect_invitation_id === invitationId), true);
  assert.equal(ownedList.body.items.find((item) => item.connect_invitation_id === invitationId).status, "claimed");

  const crossWalletList = await request(base, "/v1/connect-invitations", {
    headers: {
      "x-app-device-id": otherWallet.device_id,
      "x-app-device-token": otherWallet.token
    }
  });
  assert.equal(crossWalletList.response.status, 200);
  assert.equal(crossWalletList.body.items.some((item) => item.connect_invitation_id === invitationId), false);

  const duplicate = await request(base, "/v1/connect-invitations/claim/legacy", {
    method: "POST",
    body: JSON.stringify({ connect_key: created.body.connect_key, agent_identity: agent })
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error.code, "connect_key_unavailable");

  const beforeApproval = await request(base, `/v1/connect-invitations/${invitationId}/exchange`, {
    method: "POST",
    headers: { authorization: `Bearer ${claimToken}` },
    body: JSON.stringify({})
  });
  assert.equal(beforeApproval.response.status, 409);
  assert.equal(beforeApproval.body.error.code, "connect_invitation_pending");

  const wrongWallet = await request(base, `/v1/pairing/sessions/${pairingSessionId}/approve`, {
    method: "POST",
    body: JSON.stringify({ ...otherWallet, approved_scopes: ["payment.requests.create"] })
  });
  assert.equal(wrongWallet.response.status, 403);
  assert.equal(wrongWallet.body.error.code, "pairing_target_mismatch");

  const approved = await request(base, `/v1/pairing/sessions/${pairingSessionId}/approve`, {
    method: "POST",
    body: JSON.stringify({ ...wallet, approved_scopes: ["payment.requests.create", "payment.requests.read"] })
  });
  assert.equal(approved.response.status, 409);
  assert.equal(approved.body.error.code, "connect_identity_not_approvable");
  assert.equal(approved.body.error.details.state, "unverifiable");

  const storedInvitation = store.connectInvitation(invitationId);
  assert.equal("connect_key" in storedInvitation, false);
  assert.equal("claim_token" in storedInvitation, false);
  assert.match(storedInvitation.connect_key_hash, /^sha256:/);
  assert.match(storedInvitation.claim_token_hash, /^sha256:/);
  assert.equal(storedInvitation.status, "claimed", "self-declared legacy identity never receives wallet approval");
});

test("a wallet can cancel an unused Connect Invitation", async () => {
  const created = await request(base, "/v1/connect-invitations", {
    method: "POST",
    body: JSON.stringify(wallet)
  });
  assert.equal(created.response.status, 201);
  const invitationId = created.body.connect_invitation.connect_invitation_id;

  const cancelled = await request(base, `/v1/connect-invitations/${invitationId}`, {
    method: "DELETE",
    body: JSON.stringify(wallet)
  });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.connect_invitation.status, "cancelled");

  const claim = await request(base, "/v1/connect-invitations/claim/legacy", {
    method: "POST",
    body: JSON.stringify({ connect_key: created.body.connect_key, agent_identity: agent })
  });
  assert.equal(claim.response.status, 409);
  assert.equal(claim.body.error.code, "connect_key_unavailable");
});
