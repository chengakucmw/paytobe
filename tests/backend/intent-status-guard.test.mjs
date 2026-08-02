import assert from "node:assert/strict";
import test from "node:test";
import { validateIntentStatusUpdate } from "../../services/platform-api/src/risk.js";

// M5 (intent parity): the legacy Payment Intent status route used to accept ANY
// status in ALLOWED_STATUSES, so pending->confirmed (skipping signature/broadcast),
// reviving a failed intent (failed->confirmed), and re-reporting a terminal status
// all slipped through — each re-running the F1 settle/record side effect and
// double-counting the daily-spend ledger. validateIntentStatusUpdate mirrors the
// Payment Request state machine (domain/payment-request.js) for intents.

function intent(status) {
  return { intent_id: "pi_x", status };
}

test("legal forward transitions are allowed", () => {
  assert.equal(validateIntentStatusUpdate(intent("pending"), "signed").ok, true);
  assert.equal(validateIntentStatusUpdate(intent("pending"), "broadcasted").ok, true);
  assert.equal(validateIntentStatusUpdate(intent("signed"), "broadcasted").ok, true);
  assert.equal(validateIntentStatusUpdate(intent("broadcasted"), "confirmed").ok, true);
  assert.equal(validateIntentStatusUpdate(intent("broadcasted"), "failed").ok, true);
  // A brand-new intent with no status defaults to pending.
  assert.equal(validateIntentStatusUpdate({ intent_id: "pi_y" }, "signed").ok, true);
});

test("pending->confirmed (skipping signature/broadcast) is blocked", () => {
  const r = validateIntentStatusUpdate(intent("pending"), "confirmed");
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, "invalid_status_transition");
});

test("a failed intent cannot be revived to confirmed", () => {
  const r = validateIntentStatusUpdate(intent("failed"), "confirmed");
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_status_transition");
});

test("re-reporting a terminal status is a conflict (prevents double settle)", () => {
  for (const s of ["confirmed", "expired", "rejected"]) {
    const r = validateIntentStatusUpdate(intent(s), s);
    assert.equal(r.ok, false, `${s} re-report should conflict`);
    assert.equal(r.status, 409);
    assert.equal(r.code, "terminal_payment_intent");
  }
});

test("a confirmed intent cannot move anywhere else", () => {
  assert.equal(validateIntentStatusUpdate(intent("confirmed"), "failed").ok, false);
  assert.equal(validateIntentStatusUpdate(intent("confirmed"), "broadcasted").ok, false);
});

test("re-reporting a NON-terminal status is an idempotent no-op", () => {
  assert.equal(validateIntentStatusUpdate(intent("broadcasted"), "broadcasted").ok, true);
  assert.equal(validateIntentStatusUpdate(intent("signed"), "signed").ok, true);
  // failed is a dead-end but, mirroring the request machine, re-reporting it is a no-op.
  assert.equal(validateIntentStatusUpdate(intent("failed"), "failed").ok, true);
});
