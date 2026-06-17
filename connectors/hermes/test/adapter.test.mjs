import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HERMES_DEFAULT_SCOPES,
  createHermesPaymentRequestAdapter,
  prepareHermesPaymentRequest
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, "../fixtures");

test("Hermes fixtures output standard Transaction Context and Payment Request", async () => {
  const fixtures = await loadFixtures();
  const rails = [];

  for (const fixture of fixtures) {
    const prepared = prepareHermesPaymentRequest(fixture, {
      now: "2026-06-17T10:00:00.000Z"
    });

    assert.equal(prepared.ok, true, JSON.stringify(prepared.error));
    assert.equal(prepared.transaction_context.protocol, "velarum.transaction_context.v1");
    assert.equal(prepared.payment_request.protocol, "velarum.payment_request.v1");
    assert.equal(prepared.transaction_id, prepared.transaction_context.transaction_id);
    assert.equal(prepared.transaction_id, prepared.payment_request.transaction_id);
    assert.equal(prepared.payment_request.policy.requires_user_approval, true);
    assert.equal("webhook_url" in prepared.payment_request, false);
    rails.push(prepared.payment_request.payment.rail);
  }

  assert.deepEqual(rails.sort(), ["base_usdc", "stellar_xlm"]);
});

test("Hermes intent can be adapted into standard v1 payloads", () => {
  const prepared = prepareHermesPaymentRequest({
    connection_id: "conn_hermes_demo",
    transaction_id: "txn_hermes_inline_1",
    request_id: "prq_hermes_inline_1",
    idempotency_key: "hermes-inline-payment-1",
    created_at: "2026-06-17T10:00:00.000Z",
    expires_at: "2027-12-31T23:59:00.000Z",
    type: "developer_test",
    title: "Inline Hermes test",
    summary: "Hermes built this request from an inline intent.",
    costs: {
      total: "42.00",
      currency: "USDC"
    },
    truth_fields: [
      {
        field: "pricing.total",
        value: "42.00",
        currency: "USDC",
        source_type: "platform_verified",
        verification_status: "signature_verified"
      }
    ],
    payee: {
      name: "VelarumPay Hermes Developer Test",
      verified: false
    },
    payment: {
      rail: "base_usdc",
      network: "base_mainnet",
      asset: "USDC",
      amount: "42.00",
      to: "0x71d83a5924b0e6d3c8a9f102bb48e4c912a556d0",
      token_contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      chain_id: 8453,
      decimals: 6
    }
  });

  assert.equal(prepared.ok, true, JSON.stringify(prepared.error));
  assert.equal(prepared.transaction_context.source.runtime, "hermes");
  assert.equal(prepared.payment_request.source.runtime, "hermes");
  assert.equal(prepared.payment_request.payment.rail, "base_usdc");
});

test("Hermes adapter runs pairing, context, request, and status polling loop", async () => {
  const fixture = await loadFixture("stellar-xlm-payment-request.json");
  const calls = [];
  const adapter = createHermesPaymentRequestAdapter({
    baseUrl: "http://platform.test",
    connectionToken: "conn_tok_hermes",
    fetch: mockFetch(calls, [
      {
        ok: true,
        status: 201,
        body: {
          ok: true,
          pairing_session: {
            pairing_session_id: "pair_hermes",
            pairing_uri: "velarumpay://pair?session=pair_hermes&code=482913",
            pairing_code: "482913",
            status: "pending"
          }
        }
      },
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
      },
      {
        ok: true,
        status: 200,
        body: {
          ok: true,
          payment_request: {
            ...fixture.payment_request,
            status: "rejected"
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
              request_id: fixture.payment_request.request_id,
              status: "rejected"
            }
          ]
        }
      }
    ])
  });

  const pairing = await adapter.createPairingSession();
  assert.equal(pairing.pairing_session.pairing_code, "482913");

  const created = await adapter.createStandardPaymentRequest(fixture);
  assert.equal(created.ok, true, JSON.stringify(created.error));
  assert.equal(created.transaction_id, fixture.transaction_context.transaction_id);
  assert.equal(created.request_id, fixture.payment_request.request_id);

  const status = await adapter.getPaymentStatus(fixture.payment_request.request_id);
  assert.equal(status.payment_request.status, "rejected");

  const events = await adapter.pollStatusEvents({ since: 7 });
  assert.equal(events.items[0].seq, 8);

  assert.equal(calls[0].url, "http://platform.test/v1/pairing/sessions");
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body).requested_scopes, HERMES_DEFAULT_SCOPES);
  assert.equal(calls[1].url, "http://platform.test/v1/transaction-contexts");
  assert.equal(calls[1].init.headers.authorization, "Bearer conn_tok_hermes");
  assert.equal(calls[2].url, "http://platform.test/v1/payment-requests");
  assert.equal(calls[2].init.headers["x-idempotency-key"], fixture.payment_request.idempotency_key);
  assert.equal(calls[3].url, `http://platform.test/v1/payment-requests/${fixture.payment_request.request_id}`);
  assert.equal(calls[4].url, "http://platform.test/v1/payment-requests/events?since=7");
  assert.equal(
    adapter.agentWebSocketUrl(),
    "ws://platform.test/v1/ws/agent?connection_token=conn_tok_hermes"
  );
  assert.equal(calls.some((call) => call.url.includes("webhook")), false);
});

test("Hermes adapter rejects unsafe fields and mismatched transaction ids", async () => {
  const fixture = await loadFixture("base-usdc-payment-request.json");
  const mismatch = prepareHermesPaymentRequest({
    transaction_context: fixture.transaction_context,
    payment_request: {
      ...fixture.payment_request,
      transaction_id: "txn_other"
    }
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "transaction_id_mismatch");

  const bypass = prepareHermesPaymentRequest({
    ...fixture,
    payment_request: {
      ...fixture.payment_request,
      policy: {
        requires_user_approval: false
      }
    }
  });
  assert.equal(bypass.ok, false);
  assert.equal(bypass.error.code, "user_approval_required");

  const webhook = prepareHermesPaymentRequest({
    ...fixture,
    webhook_url: "https://agent.example/webhook"
  });
  assert.equal(webhook.ok, false);
  assert.equal(webhook.error.code, "webhook_not_allowed");

  const privateKey = prepareHermesPaymentRequest({
    ...fixture,
    private_key: "do-not-ever-put-keys-here"
  });
  assert.equal(privateKey.ok, false);
  assert.equal(privateKey.error.code, "private_key_not_allowed");
});

async function loadFixtures() {
  return Promise.all([
    loadFixture("stellar-xlm-payment-request.json"),
    loadFixture("base-usdc-payment-request.json")
  ]);
}

async function loadFixture(name) {
  return JSON.parse(await readFile(path.join(fixtureDir, name), "utf8"));
}

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
