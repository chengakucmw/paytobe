import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AGENT_ALLOWED_SCOPES, agentCanIssueToken } from "../../services/platform-api/src/application/agents/service.js";
import { id, opaqueToken, tokenHash } from "../../services/platform-api/src/crypto.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velarum-agent-registry-"));
process.env.VP_NO_AUTO_LISTEN = "1";
process.env.RELAY_STORE_DRIVER = "sqlite";
process.env.RELAY_STORE_PATH = path.join(directory, "platform.sqlite");
process.env.AUDIT_LOG_STDOUT = "false";

const { agentService, server, store } = await import("../../services/platform-api/src/server.js");
let origin = "";
const sessions = new Map();

test.before(async () => {
  seedTenant("merchant_a", "owner_a", "owner");
  seedTenant("merchant_b", "owner_b", "owner");
  seedTenant("merchant_viewer", "viewer", "viewer");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function seedTenant(merchantId, accountId, role) {
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO merchants
    (merchant_id, display_name, status, verification_state, version, created_at, updated_at)
    VALUES (?, ?, 'active', 'verified', 1, ?, ?)`).run(merchantId, merchantId, now, now);
  store.db.prepare(`INSERT INTO merchant_accounts
    (account_id, email_normalized, status, version, created_at, updated_at)
    VALUES (?, ?, 'active', 1, ?, ?)`).run(accountId, `${accountId}@example.invalid`, now, now);
  store.db.prepare(`INSERT INTO merchant_memberships
    (membership_id, merchant_id, account_id, role, status, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', 1, ?, ?)`).run(id("membership"), merchantId, accountId, role, now, now);
  const sessionToken = opaqueToken("msession", 32);
  const csrfToken = opaqueToken("mcsrf", 32);
  store.db.prepare(`INSERT INTO merchant_sessions
    (session_id, merchant_id, account_id, token_hash, csrf_hash, status, expires_at, idle_expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`).run(
    id("msession"), merchantId, accountId, tokenHash(sessionToken), tokenHash(csrfToken),
    new Date(Date.now() + 3_600_000).toISOString(), new Date(Date.now() + 1_800_000).toISOString(), now, now
  );
  sessions.set(merchantId, { cookie: `vp_merchant_session=${sessionToken}`, csrf: csrfToken });
}

async function request(pathname, merchantId, { method = "GET", payload } = {}) {
  const session = sessions.get(merchantId);
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      cookie: session.cookie,
      ...(payload ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { origin, "x-csrf-token": session.csrf } : {})
    },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  });
  return { status: response.status, body: await response.json() };
}

const validAgent = {
  name: "Checkout Agent",
  runtime: "node",
  environment: "testnet",
  allowed_scopes: ["payment.requests.create", "payment.requests.read"]
};

test("server-derived identity and the canonical scope whitelist create a draft Agent", async () => {
  assert.deepEqual(AGENT_ALLOWED_SCOPES, [
    "payment.requests.create", "payment.requests.read", "transaction_contexts.create",
    "transaction_contexts.read", "wallet.addresses.read"
  ]);
  const forged = await request("/v1/agents", "merchant_a", {
    method: "POST", payload: { ...validAgent, merchant_id: "merchant_b" }
  });
  assert.equal(forged.status, 404);
  assert.equal(forged.body.error.code, "resource_not_found");

  for (const forbidden of ["payments.approve", "payment.sign", "wallet.seed.read", "wallet.private_key.read", "unknown.scope"]) {
    const response = await request("/v1/agents", "merchant_a", {
      method: "POST", payload: { ...validAgent, allowed_scopes: [forbidden] }
    });
    assert.equal(response.status, 400, forbidden);
  }

  const created = await request("/v1/agents", "merchant_a", { method: "POST", payload: validAgent });
  assert.equal(created.status, 201);
  assert.match(created.body.agent.agent_id, /^agent_[0-9a-f]{32}$/);
  assert.equal(created.body.agent.merchant_id, "merchant_a");
  assert.equal(created.body.agent.status, "draft");
  assert.equal(created.body.agent.version, 1);
  assert.deepEqual(created.body.agent.allowed_scopes, [...validAgent.allowed_scopes].sort());
  assert.equal(agentCanIssueToken(created.body.agent), false);
  sessions.set("agent_a", created.body.agent);

  const deniedViewer = await request("/v1/agents", "merchant_viewer", { method: "POST", payload: validAgent });
  assert.equal(deniedViewer.status, 403);
});

test("list, read, and mutation are non-enumerating across tenants", async () => {
  const agentA = sessions.get("agent_a");
  const createdB = await request("/v1/agents", "merchant_b", {
    method: "POST", payload: { ...validAgent, name: "Other Merchant Agent" }
  });
  assert.equal(createdB.status, 201);

  const listA = await request("/v1/agents", "merchant_a");
  assert.deepEqual(listA.body.items.map((agent) => agent.agent_id), [agentA.agent_id]);
  const cross = await request(`/v1/agents/${agentA.agent_id}`, "merchant_b");
  const absent = await request("/v1/agents/agent_absent", "merchant_b");
  assert.equal(cross.status, 404);
  assert.deepEqual(
    { code: cross.body.error.code, message: cross.body.error.message, severity: cross.body.error.severity },
    { code: absent.body.error.code, message: absent.body.error.message, severity: absent.body.error.severity }
  );

  const crossPatch = await request(`/v1/agents/${agentA.agent_id}`, "merchant_b", {
    method: "PATCH", payload: { name: "Stolen", version: 1 }
  });
  assert.equal(crossPatch.status, 404);
  assert.equal((await request(`/v1/agents/${agentA.agent_id}`, "merchant_a")).body.agent.name, "Checkout Agent");
});

test("optimistic concurrency and the canonical lifecycle revoke token eligibility immediately", async () => {
  const agent = sessions.get("agent_a");
  const renamed = await request(`/v1/agents/${agent.agent_id}`, "merchant_a", {
    method: "PATCH", payload: { name: "Checkout Agent v2", version: 1 }
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.agent.version, 2);
  const stale = await request(`/v1/agents/${agent.agent_id}`, "merchant_a", {
    method: "PATCH", payload: { name: "Stale", version: 1 }
  });
  assert.equal(stale.status, 409);

  const active = await request(`/v1/agents/${agent.agent_id}`, "merchant_a", {
    method: "PATCH", payload: { status: "active", version: 2 }
  });
  assert.equal(active.body.agent.status, "active");
  assert.equal(agentCanIssueToken(active.body.agent), true);
  const suspended = await request(`/v1/agents/${agent.agent_id}`, "merchant_a", {
    method: "PATCH", payload: { status: "suspended", version: 3 }
  });
  assert.equal(suspended.body.agent.status, "suspended");
  assert.equal(suspended.body.agent.token_revocation_version, 1);
  assert.equal(agentCanIssueToken(suspended.body.agent), false);
  const resumed = await request(`/v1/agents/${agent.agent_id}`, "merchant_a", {
    method: "PATCH", payload: { status: "active", version: 4 }
  });
  assert.equal(resumed.body.agent.status, "active");
  const revoked = await request(`/v1/agents/${agent.agent_id}`, "merchant_a", {
    method: "PATCH", payload: { status: "revoked", version: 5 }
  });
  assert.equal(revoked.body.agent.status, "revoked");
  assert.equal(revoked.body.agent.token_revocation_version, 2);
  assert.equal(agentCanIssueToken(revoked.body.agent), false);

  const revive = await request(`/v1/agents/${agent.agent_id}`, "merchant_a", {
    method: "PATCH", payload: { status: "active", version: 6 }
  });
  assert.equal(revive.status, 409);
  assert.equal(revive.body.error.code, "agent_revoked");
  const audit = store.db.prepare("SELECT action, details_json FROM audit_events WHERE merchant_id = ? AND resource_id = ? ORDER BY occurred_at")
    .all("merchant_a", agent.agent_id);
  assert.deepEqual(audit.map((event) => event.action), [
    "agent.created", "agent.updated", "agent.status_changed", "agent.status_changed", "agent.status_changed", "agent.status_changed"
  ]);
  assert.equal(audit.every((event) => !event.details_json.includes("allowed_scopes")), true);
});
