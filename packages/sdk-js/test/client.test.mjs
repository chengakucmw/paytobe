import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createPaymentRequest,
  createPaytobeClient,
  validatePaymentRequest,
  validateTransactionContext
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const quickstartFixturePath = path.resolve(here, "../../../examples/payment-request-quickstart/fixtures/normal.json");

test("SDK creates Transaction Context and Payment Request from quickstart fixture", async () => {
  const fixture = JSON.parse(await readFile(quickstartFixturePath, "utf8"));
  const calls = [];
  const client = createPaytobeClient({
    baseUrl: "http://platform.test/",
    connectionToken: "conn_tok_test",
    fetch: mockFetch(calls, [
      {
        ok: true,
        status: 201,
        body: {
          ok: true,
          context: fixture.transaction_context,
          warnings: []
        }
      },
      {
        ok: true,
        status: 201,
        body: {
          ok: true,
          payment_request: {
            ...fixture.payment_request,
            status_projection: {
              lifecycle_status: "pending",
              review_state: "pending"
            }
          },
          warnings: []
        }
      }
    ])
  });

  assert.equal(validateTransactionContext(fixture.transaction_context).ok, true);
  assert.equal(validatePaymentRequest(fixture.payment_request).ok, true);

  const context = await client.createTransactionContext(fixture.transaction_context);
  assert.equal(context.ok, true);
  assert.equal(context.context.transaction_id, fixture.transaction_context.transaction_id);

  const created = await client.createPaymentRequest(fixture.payment_request);
  assert.equal(created.ok, true);
  assert.equal(created.payment_request.request_id, fixture.payment_request.request_id);

  assert.equal(calls[0].url, "http://platform.test/v1/transaction-contexts");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer conn_tok_test");

  assert.equal(calls[1].url, "http://platform.test/v1/payment-requests");
  assert.equal(calls[1].init.headers.authorization, "Bearer conn_tok_test");
  assert.equal(calls[1].init.headers["x-idempotency-key"], fixture.payment_request.idempotency_key);
  assert.deepEqual(JSON.parse(calls[1].init.body), fixture.payment_request);
});

test("SDK creates pairing sessions, reads payment requests, and polls events", async () => {
  const calls = [];
  const client = createPaytobeClient({
    baseUrl: "http://platform.test",
    connectionToken: "conn_tok_read",
    fetch: mockFetch(calls, [
      {
        ok: true,
        status: 201,
        body: {
          ok: true,
          pairing_session: {
            pairing_session_id: "pair_123",
            pairing_uri: "Paytobe://pair?session=pair_123&code=482913",
            pairing_code: "482913",
            status: "pending"
          }
        }
      },
      {
        ok: true,
        status: 200,
        body: {
          ok: true,
          payment_request: {
            request_id: "prq_123",
            status: "pending"
          }
        }
      },
      {
        ok: true,
        status: 200,
        body: {
          ok: true,
          items: [
            {
              seq: 8,
              request_id: "prq_123",
              status: "rejected"
            }
          ]
        }
      }
    ])
  });

  const pairing = await client.createPairingSession({
    agent: {
      agent_id: "agt_local",
      agent_name: "Local Agent"
    },
    requested_scopes: [
      "payment.requests.create",
      "payment.requests.read"
    ]
  });
  assert.equal(pairing.pairing_session.pairing_code, "482913");

  const detail = await client.getPaymentRequest("prq_123");
  assert.equal(detail.payment_request.request_id, "prq_123");

  const events = await client.pollEvents({ since: 7 });
  assert.equal(events.items[0].seq, 8);

  assert.equal(calls[0].url, "http://platform.test/v1/pairing/sessions");
  assert.equal(calls[1].url, "http://platform.test/v1/payment-requests/prq_123");
  assert.equal(calls[2].url, "http://platform.test/v1/payment-requests/events?since=7");
  assert.equal(calls[1].init.headers.authorization, "Bearer conn_tok_read");
});

test("SDK preserves structured API error code, field, and severity", async () => {
  const result = await createPaymentRequest({
    protocol: "Paytobe.payment_request.v1",
    payment: {
      amount: "24.00"
    }
  }, {
    baseUrl: "http://platform.test",
    connectionToken: "conn_tok_test",
    fetch: mockFetch([], [
      {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        body: {
          ok: false,
          error: {
            code: "invalid_payment_request",
            message: "payment.to is required",
            details: {
              field: "payment.to"
            }
          }
        }
      }
    ])
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.error.code, "invalid_payment_request");
  assert.equal(result.error.field, "payment.to");
  assert.equal(result.error.severity, "blocker");
});

function mockFetch(calls, responses) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    const response = responses.shift();
    assert.ok(response, `Unexpected fetch call to ${url}`);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText || "",
      text: async () => JSON.stringify(response.body)
    };
  };
}
