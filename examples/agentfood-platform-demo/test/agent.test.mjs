import assert from "node:assert/strict";
import test from "node:test";
import {
  createVelarumArtifacts,
  extractConnectKey,
  recommendOrder
} from "../src/agent.mjs";

test("the Agent recognizes only the canonical versionless Connect Key shape", () => {
  const key = `velarumpay-connect:ck_${"A".repeat(43)}`;
  assert.equal(extractConnectKey(`Please connect ${key} now`), key);
  assert.equal(extractConnectKey(`velarumpay-connect:v1:ck_${"A".repeat(43)}`), null);
  assert.equal(extractConnectKey("connectkey:not-valid"), null);
});

test("the recommendation honors cuisine intent, dietary intent, and budget", () => {
  const order = recommendOrder("I want spicy vegetarian noodles under 18 XLM");
  assert.equal(order.merchant.id, "noodle-atelier");
  assert.ok(order.items.some((item) => item.tags.includes("vegetarian") || item.tags.includes("spicy")));
  assert.ok(Number(order.total) <= 18);
  assert.equal(order.demo, true);
});

test("a merchant case route can anchor the recommendation", () => {
  const order = recommendOrder("Choose a dinner under 20 XLM", "bento-harbor");
  assert.equal(order.merchant.id, "bento-harbor");
  assert.ok(Number(order.total) <= 20);
});

test("generated context and payment facts agree and always require wallet approval", () => {
  const order = recommendOrder("healthy vegetarian meal under 15 XLM", "green-bowl");
  const { transactionContext, paymentRequest } = createVelarumArtifacts(order, {
    connectionId: "conn_demo",
    demoBaseUrl: "http://127.0.0.1:8790"
  });
  assert.equal(transactionContext.connection_id, "conn_demo");
  assert.equal(transactionContext.metadata.food_order.quote.total, paymentRequest.payment.amount);
  assert.equal(transactionContext.transaction_id, paymentRequest.transaction_context_ref.transaction_id);
  assert.equal(paymentRequest.recipient_id, "agentfood-reference-recipient");
  assert.equal(Object.hasOwn(paymentRequest.payment, "network"), false);
  assert.equal(Object.hasOwn(paymentRequest.metadata, "food_order"), false);
  assert.equal(transactionContext.type, "generic");
  assert.equal(paymentRequest.metadata.environment, "local_reference_demo");
});
