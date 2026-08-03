import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  createAes256GcmVault,
  createConnectKey,
  id,
  normalizeEd25519PublicKey,
  opaqueToken,
  tokenHash,
  verifyEd25519Signature
} from "../src/crypto.js";
import { Store } from "../src/store.js";
import { createClockPort } from "../src/ports/clock.js";
import { createRandomPort } from "../src/ports/random.js";
import { createTenantScope } from "../src/ports/tenant-repository.js";
import {
  MerchantDomainService,
  SqliteMerchantDomainRepository
} from "../src/application/merchant-domains/service.js";
import { AgentService, SqliteAgentRepository } from "../src/application/agents/service.js";
import {
  AgentCredentialService,
  SqliteAgentCredentialRepository
} from "../src/application/agent-credentials/service.js";
import {
  RecipientService,
  SqliteRecipientRepository
} from "../src/application/recipients/service.js";
import { SqliteRecipientEvidenceVerifier } from "../src/application/recipients/evidence.js";
import { createSystemDomainVerifierPorts } from "../src/adapters/domain-verifier/system.js";
import { WebhookEndpointVerifier } from "../src/adapters/webhook/endpoint-verifier.js";
import {
  SqliteWebhookEndpointRepository,
  WebhookEndpointService
} from "../src/application/webhooks/endpoint-service.js";

const OFFICIAL_MERCHANT_ID = "merchant_agentfood_official";
const OFFICIAL_DOMAIN = "agentfood.velarumai.com";
const OFFICIAL_AGENT_NAME = "AgentFood Official Testnet";
const OFFICIAL_AGENT_CLIENT_ID = "agentfood-service";
const OFFICIAL_WEBHOOK_URL = "https://agentfood.velarumai.com/v1/webhooks/velarumpay";
const STATE_PATH = process.env.AGENTFOOD_BOOTSTRAP_STATE_PATH
  || "/var/backups/velarumpay/agentfood-bootstrap.json";
const ENV_PATH = process.env.AGENTFOOD_BOOTSTRAP_ENV_PATH
  || "/var/backups/velarumpay/agentfood-bootstrap.env";

const [command = "status", ...args] = process.argv.slice(2);
const recipientAddress = argument(args, "--recipient");
const store = new Store();
if (!store.db) throw new Error("AgentFood bootstrap requires the SQLite store");
const db = store.db;
const clock = createClockPort();
const random = createRandomPort({ id, opaqueToken, connectKey: createConnectKey });
const ports = createSystemDomainVerifierPorts();

const services = {
  domain: new MerchantDomainService({
    repository: new SqliteMerchantDomainRepository(db),
    clock,
    random,
    hash: tokenHash,
    resolver: ports.resolver,
    fetcher: ports.fetcher
  }),
  agent: new AgentService({ repository: new SqliteAgentRepository(db), clock, random }),
  credential: new AgentCredentialService({
    repository: new SqliteAgentCredentialRepository(db),
    clock,
    random,
    hash: tokenHash,
    normalizePublicKey: normalizeEd25519PublicKey,
    verifySignature: verifyEd25519Signature
  }),
  recipient: new RecipientService({
    repository: new SqliteRecipientRepository(db),
    evidenceVerifier: new SqliteRecipientEvidenceVerifier(db),
    clock,
    random,
    hash: tokenHash
  })
};

if (command === "prepare") await prepare();
else if (command === "verify-domain") await verifyDomainAndWebhook();
else if (command === "activate") await activateRecipient();
else if (command === "status") printStatus();
else throw new TypeError(`Unsupported command: ${command}`);

async function prepare() {
  if (!/^G[A-Z2-7]{55}$/.test(recipientAddress)) {
    throw new TypeError("--recipient must be a canonical Stellar public address");
  }
  const state = readState() || createBootstrapState(recipientAddress);
  if (state.recipientAddress !== recipientAddress) {
    throw new Error("Bootstrap state is already bound to another Recipient address");
  }
  provisionFirstPartyMerchant(state);
  const scope = tenantScope();

  let domain = db.prepare("SELECT * FROM merchant_domains WHERE merchant_id = ? AND domain = ?")
    .get(OFFICIAL_MERCHANT_ID, OFFICIAL_DOMAIN);
  if (!domain) {
    const created = services.domain.create(scope, { domain: OFFICIAL_DOMAIN, method: "https_well_known" });
    requireOk(created, "create official domain");
    domain = created.merchant_domain;
    state.domainChallenge = created.challenge;
  }
  if (!state.domainChallenge && domain.status !== "verified") {
    throw new Error("Pending Domain exists but its one-time challenge is unavailable");
  }
  state.domainId = domain.domain_id;

  let agent = db.prepare("SELECT * FROM agents WHERE merchant_id = ? AND name = ?")
    .get(OFFICIAL_MERCHANT_ID, OFFICIAL_AGENT_NAME);
  if (!agent) {
    const created = services.agent.create(scope, {
      name: OFFICIAL_AGENT_NAME,
      runtime: "node",
      environment: "testnet",
      allowed_scopes: [
        "payment.requests.create",
        "payment.requests.read",
        "transaction_contexts.create",
        "transaction_contexts.read"
      ]
    });
    requireOk(created, "create official Agent");
    agent = created.agent;
  }
  state.agentId = agent.agent_id;

  let credential = db.prepare("SELECT * FROM agent_credentials WHERE merchant_id = ? AND agent_id = ? AND kid = ?")
    .get(OFFICIAL_MERCHANT_ID, agent.agent_id, state.agentCredentialKid);
  if (!credential) {
    const registered = services.credential.register(scope, agent.agent_id, {
      kid: state.agentCredentialKid,
      alg: "Ed25519",
      public_key: state.agentPublicKey,
      not_before: clock.nowIso(),
      expires_at: new Date(clock.now().getTime() + 365 * 24 * 60 * 60 * 1000).toISOString()
    });
    requireOk(registered, "register official Agent credential");
    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(state.agentPrivateKeyPkcs8Base64, "base64"),
      format: "der",
      type: "pkcs8"
    });
    const signature = crypto.sign(null, Buffer.from(registered.proof_challenge), privateKey).toString("base64url");
    const activated = services.credential.activate(scope, agent.agent_id, registered.credential.credential_id, {
      challenge: registered.proof_challenge,
      signature
    });
    requireOk(activated, "activate official Agent credential");
    credential = activated.credential;
  }
  state.credentialId = credential.credential_id;
  if (agent.status !== "active") {
    const activatedAgent = services.agent.update(scope, agent.agent_id, { status: "active", version: agent.version });
    requireOk(activatedAgent, "activate official Agent");
    agent = activatedAgent.agent;
  }

  let recipient = db.prepare("SELECT * FROM recipients WHERE merchant_id = ? AND name = ?")
    .get(OFFICIAL_MERCHANT_ID, "AgentFood Official Testnet Recipient");
  let recipientVersion;
  if (!recipient) {
    const created = await services.recipient.create(scope, {
      name: "AgentFood Official Testnet Recipient",
      rail: "stellar",
      network: "stellar_testnet",
      asset: "XLM",
      address: recipientAddress
    });
    requireOk(created, "create official Recipient");
    recipient = created.recipient;
    recipientVersion = created.recipient_version;
  } else {
    recipientVersion = db.prepare("SELECT * FROM recipient_versions WHERE merchant_id = ? AND recipient_id = ? ORDER BY created_at LIMIT 1")
      .get(OFFICIAL_MERCHANT_ID, recipient.recipient_id);
  }
  if (recipientVersion.address !== recipientAddress) {
    throw new Error("Existing official Recipient is bound to another address");
  }
  state.recipientId = recipient.recipient_id;
  state.recipientVersionId = recipientVersion.recipient_version_id;
  state.coolingUntil = recipientVersion.cooling_until;

  let evidence = db.prepare("SELECT * FROM recipient_verification_evidence WHERE merchant_id = ? AND recipient_id = ? AND recipient_version_id = ?")
    .get(OFFICIAL_MERCHANT_ID, recipient.recipient_id, recipientVersion.recipient_version_id);
  if (!evidence) {
    const sourceId = "source_agentfood_owner_attested_testnet";
    const evidenceDigest = tokenHash(`owner_attested_testnet:${recipientAddress}:${recipientVersion.facts_digest}`);
    db.prepare(`INSERT OR IGNORE INTO recipient_verification_sources
      (source_id, merchant_id, type, status, evidence_digest, facts_digest, verified_at, expires_at, created_at)
      VALUES (?, ?, 'reviewed_operational', 'verified', ?, ?, ?, NULL, ?)`)
      .run(sourceId, OFFICIAL_MERCHANT_ID, evidenceDigest, recipientVersion.facts_digest, clock.nowIso(), clock.nowIso());
    const verified = await services.recipient.verify(scope, recipient.recipient_id, {
      recipient_version_id: recipientVersion.recipient_version_id,
      type: "reviewed_operational",
      source_id: sourceId,
      evidence_digest: evidenceDigest,
      version: recipient.version
    });
    requireOk(verified, "verify official Recipient evidence");
    recipient = verified.recipient;
    evidence = verified.evidence;
  }
  state.evidenceId = evidence.evidence_id;
  state.evidenceDigest = evidence.evidence_digest;
  writeState(state);
  writeEnv(state, { siteOnly: true });
  printStatus();
}

async function verifyDomainAndWebhook() {
  const state = requireState();
  const scope = tenantScope();
  const domain = db.prepare("SELECT * FROM merchant_domains WHERE merchant_id = ? AND domain_id = ?")
    .get(OFFICIAL_MERCHANT_ID, state.domainId);
  if (!domain) throw new Error("Official Domain was not prepared");
  if (domain.status !== "verified") {
    requireOk(await services.domain.verify(scope, state.domainId), "verify official Domain");
  }

  let endpoint = db.prepare("SELECT * FROM webhook_endpoints WHERE merchant_id = ? AND url = ?")
    .get(OFFICIAL_MERCHANT_ID, OFFICIAL_WEBHOOK_URL);
  if (!endpoint) {
    const webhook = new WebhookEndpointService({
      repository: new SqliteWebhookEndpointRepository(db),
      verifier: new WebhookEndpointVerifier(ports),
      vault: createAes256GcmVault(state.webhookVaultKey, "velarumpay.webhook_secret.v1"),
      clock,
      random,
      hash: tokenHash
    });
    const created = await webhook.create(scope, {
      url: OFFICIAL_WEBHOOK_URL,
      event_types: ["payment_request.status_updated"]
    });
    requireOk(created, "create official Webhook Endpoint");
    endpoint = created.webhook_endpoint;
    state.agentfoodWebhookSecret = created.secret;
  }
  if (!state.agentfoodWebhookSecret) {
    throw new Error("Webhook Endpoint exists but its one-time Secret is unavailable");
  }
  state.webhookEndpointId = endpoint.webhook_endpoint_id;
  writeState(state);
  writeEnv(state, { siteOnly: true });
  printStatus();
}

async function activateRecipient() {
  const state = requireState();
  const scope = tenantScope();
  let recipient = db.prepare("SELECT * FROM recipients WHERE merchant_id = ? AND recipient_id = ?")
    .get(OFFICIAL_MERCHANT_ID, state.recipientId);
  if (!recipient) throw new Error("Official Recipient was not prepared");
  if (recipient.status !== "active") {
    const activated = await services.recipient.activate(scope, state.recipientId, {
      recipient_version_id: state.recipientVersionId,
      evidence_id: state.evidenceId,
      evidence_digest: state.evidenceDigest,
      version: recipient.version
    });
    requireOk(activated, "activate official Recipient");
    recipient = activated.recipient;
  }
  state.activatedAt = clock.nowIso();
  writeState(state);
  writeEnv(state, { siteOnly: false });
  printStatus();
}

function provisionFirstPartyMerchant(state) {
  const existing = db.prepare("SELECT * FROM merchants WHERE merchant_id = ?").get(OFFICIAL_MERCHANT_ID);
  if (existing) return;
  const account = db.prepare("SELECT account_id FROM merchant_accounts WHERE status = 'active' ORDER BY created_at LIMIT 1").get();
  if (!account) throw new Error("An active verified owner account is required before first-party bootstrap");
  const at = clock.nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO merchants
      (merchant_id, display_name, legal_name, status, verification_state, version, created_at, updated_at)
      VALUES (?, 'AgentFood Official Testnet', NULL, 'pending_verification', 'email_verified', 1, ?, ?)`)
      .run(OFFICIAL_MERCHANT_ID, at, at);
    db.prepare(`INSERT INTO merchant_memberships
      (membership_id, merchant_id, account_id, role, status, version, created_at, updated_at)
      VALUES ('membership_agentfood_official_owner', ?, ?, 'owner', 'active', 1, ?, ?)`)
      .run(OFFICIAL_MERCHANT_ID, account.account_id, at, at);
    db.prepare(`INSERT INTO audit_events
      (audit_event_id, merchant_id, actor_type, actor_id, action, resource_type, resource_id,
       result, request_id, details_json, occurred_at)
      VALUES (?, ?, 'platform_operator', 'owner_approved_bootstrap', 'merchant.first_party_provisioned',
        'merchant', ?, 'success', ?, ?, ?)`)
      .run(id("audit"), OFFICIAL_MERCHANT_ID, OFFICIAL_MERCHANT_ID, id("request"), JSON.stringify({ domain: OFFICIAL_DOMAIN }), at);
    db.exec("COMMIT");
    state.ownerAccountId = account.account_id;
    writeState(state);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
    throw error;
  }
}

function createBootstrapState(address) {
  const keys = crypto.generateKeyPairSync("ed25519");
  const publicJwk = keys.publicKey.export({ format: "jwk" });
  return {
    version: 1,
    merchantId: OFFICIAL_MERCHANT_ID,
    domain: OFFICIAL_DOMAIN,
    recipientAddress: address,
    agentCredentialKid: `agentfood-${new Date().toISOString().slice(0, 10)}`,
    agentPublicKey: publicJwk.x,
    agentPrivateKeyPkcs8Base64: keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    webhookVaultKey: crypto.randomBytes(32).toString("base64"),
    createdAt: clock.nowIso()
  };
}

function tenantScope() {
  return createTenantScope(Object.freeze({
    merchant_id: OFFICIAL_MERCHANT_ID,
    actor_id: "platform_operator",
    request_id: id("request")
  }));
}

function printStatus() {
  const state = readState() || {};
  const merchant = db.prepare("SELECT merchant_id,display_name,status,verification_state FROM merchants WHERE merchant_id = ?")
    .get(OFFICIAL_MERCHANT_ID) || null;
  const domain = state.domainId ? db.prepare("SELECT domain_id,domain,status,verified_at FROM merchant_domains WHERE domain_id = ?").get(state.domainId) : null;
  const agent = state.agentId ? db.prepare("SELECT agent_id,name,status FROM agents WHERE agent_id = ?").get(state.agentId) : null;
  const credential = state.credentialId ? db.prepare("SELECT credential_id,kid,status,expires_at FROM agent_credentials WHERE credential_id = ?").get(state.credentialId) : null;
  const recipient = state.recipientId ? db.prepare("SELECT recipient_id,name,status,active_version_id,version FROM recipients WHERE recipient_id = ?").get(state.recipientId) : null;
  const version = state.recipientVersionId ? db.prepare("SELECT recipient_version_id,network,asset,address,verification_state,cooling_until,activated_at FROM recipient_versions WHERE recipient_version_id = ?").get(state.recipientVersionId) : null;
  const webhook = state.webhookEndpointId ? db.prepare("SELECT webhook_endpoint_id,url,status FROM webhook_endpoints WHERE webhook_endpoint_id = ?").get(state.webhookEndpointId) : null;
  console.log(JSON.stringify({ ok: true, merchant, domain, agent, credential, recipient, recipient_version: version, webhook }, null, 2));
}

function writeEnv(state, { siteOnly }) {
  const values = {
    AGENTFOOD_SITE_ONLY: siteOnly ? "true" : "false",
    AGENTFOOD_DOMAIN_VERIFICATION_CHALLENGE: state.domainChallenge || "",
    AGENTFOOD_MERCHANT_ID: OFFICIAL_MERCHANT_ID,
    AGENTFOOD_AGENT_ID: state.agentId || "",
    AGENTFOOD_AGENT_CLIENT_ID: OFFICIAL_AGENT_CLIENT_ID,
    AGENTFOOD_AGENT_CREDENTIAL_KID: state.agentCredentialKid || "",
    AGENTFOOD_AGENT_CREDENTIAL_PRIVATE_KEY_PKCS8_B64: state.agentPrivateKeyPkcs8Base64 || "",
    AGENTFOOD_WEBHOOK_SECRET: state.agentfoodWebhookSecret || "",
    AGENTFOOD_STELLAR_TESTNET_ENABLED: "true",
    AGENTFOOD_STELLAR_TESTNET_MAX_XLM: "1",
    AGENTFOOD_STELLAR_PAYMENT_AMOUNT_XLM: "0.1",
    AGENTFOOD_RECIPIENT_ID: state.recipientId || "",
    AGENTFOOD_RECIPIENT_VERSION_ID: state.recipientVersionId || "",
    WEBHOOK_SECRET_ENCRYPTION_KEY: state.webhookVaultKey || ""
  };
  fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true });
  fs.writeFileSync(ENV_PATH, `${Object.entries(values).filter(([, value]) => value !== "").map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(STATE_PATH, 0o600);
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function requireState() {
  const state = readState();
  if (!state) throw new Error("Run prepare before this command");
  return state;
}

function requireOk(result, action) {
  if (result?.ok) return result;
  throw Object.assign(new Error(`${action} failed: ${result?.code || "unknown_error"}: ${result?.message || ""}`), { result });
}

function argument(values, name) {
  const index = values.indexOf(name);
  return index >= 0 ? String(values[index + 1] || "").trim() : "";
}
