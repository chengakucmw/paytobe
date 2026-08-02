import assert from "node:assert/strict";
import test from "node:test";
import { PortalApiError, SessionExpiredError } from "../public/modules/api-client.js";
import { capabilitiesForServerRole, createOrganizationMembersModel, renderOrganizationMembers } from "../src/pages/organization/index.js";

const merchant = Object.freeze({ merchant_id: "merchant_one", display_name: "Acme", legal_name: "Acme LLC", status: "active", verification_state: "verified", version: 4 });
const members = Object.freeze([
  Object.freeze({ membership_id: "member_owner", email_normalized: "owner@example.com", role: "owner", status: "active", version: 3 }),
  Object.freeze({ membership_id: "member_viewer", email_normalized: "viewer@example.com", role: "viewer", status: "active", version: 1 })
]);

test("owner success DOM submits server versions and never renders invitation tokens", async () => {
  const calls = [];
  const api = mockApi(calls);
  const model = createOrganizationMembersModel({ api, session: session("owner"), confirmAction: () => true });
  await model.load();
  await model.updateProfile({ displayName: "Acme Updated", legalName: "Acme LLC" });
  await model.invite({ email: "new@example.com", role: "developer" });
  await model.changeRole("member_viewer", "developer", 1);

  assert.deepEqual(calls.find(([name]) => name === "updateMerchant")[2], { display_name: "Acme Updated", legal_name: "Acme LLC", version: 4 });
  assert.deepEqual(calls.find(([name]) => name === "changeMemberRole")[3], { role: "developer", version: 1 });
  const html = renderOrganizationMembers(model.getState(), "members", capabilitiesForServerRole("owner"));
  assert.match(html, /Invite member|Save role|new@example\.com|Expires/);
  assert.doesNotMatch(html, /minvite_|invitation_token|secret-delivery-value/);
});

test("viewer and developer DOM has no management actions and client calls remain blocked", async () => {
  for (const role of ["viewer", "developer"]) {
    const calls = [];
    const model = createOrganizationMembersModel({ api: mockApi(calls), session: session(role) });
    await model.load();
    const memberHtml = renderOrganizationMembers(model.getState(), "members", capabilitiesForServerRole(role));
    const organizationHtml = renderOrganizationMembers(model.getState(), "organization", capabilitiesForServerRole(role));
    assert.doesNotMatch(memberHtml, /Invite member|Save role|data-remove-member/);
    assert.doesNotMatch(organizationHtml, /Save profile|data-lifecycle/);
    await model.invite({ email: "blocked@example.com", role: "admin" });
    assert.equal(calls.some(([name]) => name === "inviteMember"), false);
  }
});

test("concurrency, step-up, and last-owner errors produce explicit safe states", async () => {
  const errors = [
    ["concurrency_conflict", "changed elsewhere"],
    ["step_up_required", "step-up authentication"],
    ["last_owner_required", "last Owner"]
  ];
  for (const [code, expected] of errors) {
    const api = mockApi([], { mutationError: new PortalApiError("raw", code === "step_up_required" ? 403 : 409, code) });
    const model = createOrganizationMembersModel({ api, session: session("owner"), confirmAction: () => true });
    await model.load();
    if (code === "last_owner_required") await model.remove("member_owner", 3, true);
    else if (code === "step_up_required") await model.changeLifecycle("suspended", true);
    else await model.updateProfile({ displayName: "Conflict", legalName: "" });
    assert.match(model.getState().message, new RegExp(expected, "i"));
    assert.equal(model.getState().stepUpRequired, code === "step_up_required");
  }
});

test("suspension and terminal closure require confirmation and include consequences", async () => {
  const calls = [];
  let confirmed = false;
  const model = createOrganizationMembersModel({ api: mockApi(calls), session: session("owner"), confirmAction: () => confirmed });
  await model.load();
  assert.equal(await model.changeLifecycle("closed", true), null);
  assert.equal(calls.some(([name]) => name === "updateMerchant"), false);
  confirmed = true;
  await model.changeLifecycle("suspended", true);
  assert.deepEqual(calls.find(([name]) => name === "updateMerchant")[2], { status: "suspended", version: 4 });
  const html = renderOrganizationMembers({ ...model.getState(), merchant }, "organization", capabilitiesForServerRole("owner"));
  assert.match(html, /stops platform capabilities|terminal and cannot be reversed/i);
});

test("expired or cross-tenant failures clear previously rendered merchant data", async () => {
  for (const failure of [new SessionExpiredError(), new PortalApiError("missing", 404, "resource_not_found")]) {
    const api = mockApi([], { loadError: failure });
    const model = createOrganizationMembersModel({ api, session: session("owner") });
    await model.load();
    assert.equal(model.getState().merchant, null);
    assert.deepEqual(model.getState().members, []);
    const html = renderOrganizationMembers(model.getState(), "members", capabilitiesForServerRole("owner"));
    assert.doesNotMatch(html, /Acme|owner@example\.com|viewer@example\.com/);
  }
});

function session(role) {
  return { merchantId: "merchant_one", role };
}

function mockApi(calls, { mutationError = null, loadError = null } = {}) {
  return {
    async getMerchant(id) { calls.push(["getMerchant", id]); if (loadError) throw loadError; return { ...merchant }; },
    async listMemberships(id) { calls.push(["listMemberships", id]); return members.map((item) => ({ ...item })); },
    async updateMerchant(id, input) { calls.push(["updateMerchant", id, input]); if (mutationError) throw mutationError; return { ...merchant, ...input, version: merchant.version + 1 }; },
    async inviteMember(id, input) { calls.push(["inviteMember", id, input]); if (mutationError) throw mutationError; return { invitation_id: "inv_one", email_normalized: input.email, role: input.role, status: "active", expires_at: "2026-08-03T00:00:00Z", invitation_token: "secret-delivery-value" }; },
    async changeMemberRole(id, memberId, input) { calls.push(["changeMemberRole", id, memberId, input]); if (mutationError) throw mutationError; return { ...members[1], membership_id: memberId, role: input.role, version: input.version + 1 }; },
    async removeMember(id, memberId, input) { calls.push(["removeMember", id, memberId, input]); if (mutationError) throw mutationError; return { ...members[0], membership_id: memberId, status: "removed", version: input.version + 1 }; },
    async startStepUp() { calls.push(["startStepUp"]); return { ok: true }; },
    async completeStepUp() { calls.push(["completeStepUp"]); return { ok: true }; }
  };
}
