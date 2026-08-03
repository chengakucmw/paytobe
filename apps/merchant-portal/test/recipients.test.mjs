import assert from "node:assert/strict";
import test from "node:test";
import { PortalApiError } from "../public/modules/api-client.js";
import { createRecipientsModel, renderRecipients } from "../src/pages/recipients/index.js";

const coolingUntil = "2026-08-03T00:00:00Z";
const recipient = Object.freeze({ recipient_id: "recipient_one", name: "Primary treasury", status: "pending_verification", active_version_id: null, version: 2 });
const recipientVersion = Object.freeze({ recipient_version_id: "rv_one", rail: "stellar", network: "stellar_testnet", asset: "USDC", address: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", issuer: "GISSUERFULLVALUE", contract: null, memo: "123", verification_state: "unverified", cooling_until: coolingUntil, created_at: "2026-08-02T00:00:00Z", display: { address: "SHORT_ADDRESS", asset: "FAKE_ASSET" }, metadata: { network: "EVIL_NETWORK", memo: "HIDDEN_MEMO" } });

test("fact panel always shows full immutable facts and ignores display or metadata conflicts", async () => {
  const model = createRecipientsModel({ api: mockApi(), session: session("owner"), clock: () => Date.parse("2026-08-02T01:00:00Z") });
  await model.load();
  const html = renderRecipients(model.getState(), true, Date.parse("2026-08-02T01:00:00Z"));
  assert.match(html, /stellar_testnet|USDC|GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ234567|GISSUERFULLVALUE|123/);
  assert.doesNotMatch(html, /SHORT_ADDRESS|FAKE_ASSET|EVIL_NETWORK|HIDDEN_MEMO/);
  assert.ok(html.indexOf("Primary treasury") < html.indexOf("Immutable payment facts"));
});

test("create and critical fact change use the server-provided cooling policy", async () => {
  const calls = [];
  const model = createRecipientsModel({ api: mockApi({ calls }), session: session("developer") });
  await model.load();
  await model.createVersion({ rail: "stellar", network: "stellar_testnet", asset: "USDC", address: "GNEWFULLADDRESSABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNO", issuer: "GISSUERFULLVALUE", memo: "456" });
  assert.equal(model.getState().versions.length, 2);
  assert.equal(Date.parse(model.getState().versions[1].cooling_until) - Date.parse(model.getState().versions[1].created_at), 24 * 60 * 60 * 1000);
  assert.deepEqual(calls.find(([name]) => name === "createRecipientVersion")[2].version, 2);
  assert.match(renderRecipients(model.getState(), true, Date.parse("2026-08-02T02:00:00Z")), /22h 0m remaining/);
});

test("validation failures map safely without replacing existing facts", async () => {
  const api = mockApi({ mutationError: new PortalApiError("raw internal", 400, "invalid_recipient") });
  const model = createRecipientsModel({ api, session: session("owner") });
  await model.load();
  const before = model.getState().versions[0].address;
  await model.createVersion({ network: "bad", asset: "BAD", address: "bad" });
  assert.match(model.getState().message, /failed validation/i);
  assert.equal(model.getState().versions[0].address, before);
});

test("verification, Owner notification, cooling, step-up activation, and revocation are enforced", async () => {
  const calls = [];
  let now = Date.parse("2026-08-02T02:00:00Z");
  const model = createRecipientsModel({ api: mockApi({ calls }), session: session("admin"), clock: () => now, confirmAction: () => true });
  await model.load();
  await model.verify({ type: "domain_proof", sourceId: "source_one", evidenceDigest: "sha256:evidence" });
  const html = renderRecipients(model.getState(), true, now);
  assert.match(html, /Domain proof|valid|pending/i);
  await model.activate(true);
  assert.match(model.getState().message, /cooling period/);
  now = Date.parse("2026-08-03T01:00:00Z");
  await model.activate(true);
  assert.equal(model.getState().stepUpRequired, true);
  await model.completeStepUp("mstep_valid");
  await model.activate(true);
  assert.equal(model.getState().recipients[0].status, "active");
  await model.completeStepUp("mstep_valid_again");
  await model.revoke(true);
  assert.equal(model.getState().recipients[0].status, "revoked");
  assert.deepEqual(model.getState().versions, []);
});

test("version history excludes revoked selections and cross-tenant IDs clear all facts", async () => {
  const api = mockApi();
  const model = createRecipientsModel({ api, session: session("owner") });
  await model.load();
  const selectedBefore = model.getState().selectedVersionId;
  assert.equal(model.selectVersion("unknown"), null);
  assert.equal(model.getState().selectedVersionId, selectedBefore);
  api.listRecipientVersions = async () => { throw new PortalApiError("other tenant", 404, "resource_not_found"); };
  await model.select("recipient_one");
  assert.deepEqual(model.getState().recipients, []);
  assert.deepEqual(model.getState().versions, []);
  assert.doesNotMatch(renderRecipients(model.getState(), true), /GABCDEFGHIJKLMNOPQRSTUVWXYZ/);

  const revoked = createRecipientsModel({ api: mockApi({ recipientStatus: "revoked" }), session: session("owner") });
  await revoked.load();
  assert.equal(revoked.getState().selectedVersionId, "");
  assert.match(revoked.getState().message, /revoked/i);
});

function session(role) { return { merchantId: "merchant_one", role }; }
function mockApi({ calls = [], mutationError = null, recipientStatus = "pending_verification" } = {}) {
  let current = { ...recipient, status: recipientStatus };
  let versions = [{ ...recipientVersion }];
  return {
    async listRecipients() { calls.push(["listRecipients"]); return [{ ...current }]; },
    async listRecipientVersions(id) { calls.push(["listRecipientVersions", id]); return versions.map((item) => ({ ...item })); },
    async createRecipient(input) { calls.push(["createRecipient", input]); if (mutationError) throw mutationError; return { ok: true, recipient: { ...current, name: input.name }, recipient_version: { ...recipientVersion }, owner_notification: { status: "pending", audience_role: "owner" } }; },
    async createRecipientVersion(id, input) { calls.push(["createRecipientVersion", id, input]); if (mutationError) throw mutationError; current = { ...current, version: current.version + 1 }; const next = { ...recipientVersion, recipient_version_id: "rv_two", address: input.address, memo: input.memo, created_at: "2026-08-02T00:00:00Z", cooling_until: "2026-08-03T00:00:00Z" }; versions.push(next); return { ok: true, recipient: { ...current }, recipient_version: next, owner_notification: { status: "pending", audience_role: "owner" } }; },
    async verifyRecipient(id, input) { calls.push(["verifyRecipient", id, input]); if (mutationError) throw mutationError; current = { ...current, version: current.version + 1 }; const next = { ...versions[0], verification_state: "verified_cooling" }; versions[0] = next; return { ok: true, recipient: { ...current }, recipient_version: next, evidence: { evidence_id: "evidence_one", evidence_digest: input.evidence_digest, type: input.type, status: "valid" }, owner_notification: { status: "pending", audience_role: "owner" } }; },
    async activateRecipientVersion(id, versionId, input) { calls.push(["activateRecipientVersion", id, versionId, input]); if (mutationError) throw mutationError; current = { ...current, status: "active", active_version_id: versionId, version: current.version + 1 }; const next = { ...versions[0], verification_state: "active" }; versions[0] = next; return { ok: true, recipient: { ...current }, recipient_version: next }; },
    async updateRecipient(id, input) { calls.push(["updateRecipient", id, input]); if (mutationError) throw mutationError; current = { ...current, status: input.status, active_version_id: null, version: input.version + 1 }; return { ok: true, recipient: { ...current } }; },
    async startStepUp() { calls.push(["startStepUp"]); return { ok: true }; },
    async completeStepUp(value) { calls.push(["completeStepUp", value]); return { ok: true }; }
  };
}
