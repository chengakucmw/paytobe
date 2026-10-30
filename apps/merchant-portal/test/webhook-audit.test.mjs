import assert from "node:assert/strict";
import test from "node:test";
import { PortalApiError } from "../public/modules/api-client.js";
import { createWebhookAuditModel, renderMerchantAudit, renderWebhooks } from "../src/pages/webhooks/index.js";

const secret = `whsec_${"S".repeat(43)}`;
const endpoint = Object.freeze({ webhook_endpoint_id: "endpoint_one", url: "https://hooks.acme.com/Paytobe", event_types: ["payment_request.status_updated"], status: "active", verification_mode: "merchant_domain", secret_overlap_until: null, version: 1, secret_ciphertext: "MUST_NOT_RENDER" });
const retryable = Object.freeze({ delivery_id: "delivery_retry", event_id: "event_stable", webhook_endpoint_id: "endpoint_one", attempt: 2, status: "retryable_failed", response_status: 500, failure_code: "http_500", next_attempt_at: "2026-08-02T02:00:00Z", response_body: "FULL_RESPONSE_MUST_NOT_RENDER", authorization: "Bearer MUST_NOT_RENDER" });
const terminal4xx = Object.freeze({ delivery_id: "delivery_400", event_id: "event_400", webhook_endpoint_id: "endpoint_one", attempt: 1, status: "failed", response_status: 400, failure_code: "http_400" });

test("Secret is displayed once and removed only after saved confirmation", async () => {
  const model = createWebhookAuditModel({ api: mockApi(), session: session("owner") });
  await model.load();
  await model.create({ url: "https://new.acme.com/hook", eventTypes: ["payment_request.status_updated"] });
  assert.match(renderWebhooks(model.getState(), true), new RegExp(secret));
  assert.equal(model.acknowledgeSecret(false), false);
  assert.match(renderWebhooks(model.getState(), true), new RegExp(secret));
  assert.equal(model.acknowledgeSecret(true), true);
  assert.doesNotMatch(renderWebhooks(model.getState(), true), new RegExp(secret));
  assert.equal(JSON.stringify(model.getState()).includes(secret), false);
});

test("lists, audit, and DOM contain no Secret, authorization header, or response body", async () => {
  const model = createWebhookAuditModel({ api: mockApi(), session: session("admin") });
  await model.load();
  const dom = `${renderWebhooks(model.getState(), true)}${renderMerchantAudit(model.getState().auditEvents)}`;
  assert.match(dom, /event_stable|delivery_retry|http_500|Merchant audit/);
  assert.doesNotMatch(dom, /MUST_NOT_RENDER|FULL_RESPONSE_MUST_NOT_RENDER|Bearer|secret_ciphertext|authorization|response_body/i);
});

test("replay requires capability, confirmation, step-up, and preserves Event ID", async () => {
  const calls = [];
  let confirmed = true;
  const model = createWebhookAuditModel({ api: mockApi({ calls }), session: session("developer"), confirmAction: () => confirmed });
  await model.load();
  await model.replay("delivery_retry", true);
  assert.equal(model.getState().stepUpRequired, true);
  assert.equal(calls.some(([name]) => name === "replayWebhookDelivery"), false);
  await model.completeStepUp("mstep_valid");
  await model.replay("delivery_retry", true);
  assert.equal(model.getState().deliveries[0].event_id, "event_stable");
  assert.match(model.getState().message, /stable Event ID event_stable/);
  confirmed = false;
  await model.completeStepUp("mstep_again");
  assert.equal(await model.replay("delivery_retry", true), null);
});

test("non-retryable 4xx and Viewer role have no replay or management action", async () => {
  const model = createWebhookAuditModel({ api: mockApi(), session: session("viewer") });
  await model.load();
  const html = renderWebhooks(model.getState(), false);
  assert.doesNotMatch(html, /Add endpoint|Rotate Secret|Revoke endpoint|>Replay</);
  assert.equal(await model.replay("delivery_400", true), null);
  const managerHtml = renderWebhooks(model.getState(), true);
  const row400 = managerHtml.slice(managerHtml.indexOf("delivery_400"));
  assert.doesNotMatch(row400.split("</tr>")[0], />Replay</);
});

test("cross-tenant replay clears stale data and changed Event ID fails closed", async () => {
  const api = mockApi();
  const model = createWebhookAuditModel({ api, session: session("owner"), confirmAction: () => true });
  await model.load(); await model.completeStepUp("mstep_valid");
  api.replayWebhookDelivery = async () => { throw new PortalApiError("other tenant", 404, "resource_not_found"); };
  await model.replay("delivery_retry", true);
  assert.deepEqual(model.getState().deliveries, []);
  assert.deepEqual(model.getState().auditEvents, []);

  const mismatchApi = mockApi({ replayEventId: "event_changed" });
  const mismatch = createWebhookAuditModel({ api: mismatchApi, session: session("owner"), confirmAction: () => true });
  await mismatch.load(); await mismatch.completeStepUp("mstep_valid"); await mismatch.replay("delivery_retry", true);
  assert.deepEqual(mismatch.getState().deliveries, []);
  assert.match(mismatch.getState().message, /Event ID changed/);
});

function session(role) { return { merchantId: "merchant_one", role }; }
function mockApi({ calls = [], replayEventId = "event_stable" } = {}) {
  return {
    async listWebhookEndpoints() { calls.push(["listWebhookEndpoints"]); return [{ ...endpoint }]; },
    async listWebhookDeliveries() { calls.push(["listWebhookDeliveries"]); return [{ ...retryable }, { ...terminal4xx }]; },
    async listMerchantAuditEvents() { calls.push(["listMerchantAuditEvents"]); return [{ audit_event_id: "audit_one", actor: { type: "merchant_account", id: "owner_one" }, action: "webhook_endpoint.created", resource: { type: "webhook_endpoint", id: "endpoint_one" }, result: "success", occurred_at: "2026-08-02T01:00:00Z", details: { secret, authorization: "Bearer bad", response_body: "bad" } }]; },
    async createWebhookEndpoint(input) { calls.push(["createWebhookEndpoint", input]); return { ok: true, webhook_endpoint: { ...endpoint, webhook_endpoint_id: "endpoint_two", url: input.url }, secret, ownership_challenge: "whv_public_challenge" }; },
    async verifyWebhookEndpoint(id) { calls.push(["verifyWebhookEndpoint", id]); return { ok: true, webhook_endpoint: { ...endpoint, webhook_endpoint_id: id } }; },
    async rotateWebhookSecret(id) { calls.push(["rotateWebhookSecret", id]); return { ok: true, webhook_endpoint: { ...endpoint, webhook_endpoint_id: id, secret_overlap_until: "2026-08-03T01:00:00Z" }, secret }; },
    async revokeWebhookEndpoint(id) { calls.push(["revokeWebhookEndpoint", id]); return { ok: true, webhook_endpoint: { ...endpoint, webhook_endpoint_id: id, status: "revoked" } }; },
    async replayWebhookDelivery(id) { calls.push(["replayWebhookDelivery", id]); return { ok: true, delivery: { ...retryable, delivery_id: "delivery_replay", event_id: replayEventId, status: "pending", attempt: 1, replay_of_delivery_id: id } }; },
    async startStepUp() { calls.push(["startStepUp"]); return { ok: true }; },
    async completeStepUp(value) { calls.push(["completeStepUp", value]); return { ok: true }; }
  };
}
