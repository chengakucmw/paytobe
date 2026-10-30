import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { handleJsonRpcMessage } from "../src/mcp.js";
import { callTool, tools } from "../src/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const quickstartFixturePath = path.resolve(here, "../../../examples/payment-request-quickstart/fixtures/base_usdc.json");

test("MCP lists only Payment Request request/status tools", async () => {
  const response = await handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  }, { tools, callTool });

  assert.equal(response.result.tools.length, 4);
  assert.deepEqual(response.result.tools.map((tool) => tool.name), [
    "create_pairing_session",
    "create_transaction_context",
    "create_payment_request",
    "get_payment_status"
  ]);
  assert.equal(response.result.tools.some((tool) => tool.name.includes("sign")), false);
});

test("MCP initialize declares tools capability", async () => {
  const response = await handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: {
        name: "test-client",
        version: "0.0.0"
      }
    }
  }, { tools, callTool });

  assert.equal(response.result.protocolVersion, "2025-11-25");
  assert.deepEqual(response.result.capabilities.tools, { listChanged: false });
});

test("MCP returns a protocol error for unknown tools", async () => {
  const response = await handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "sign_payment_request",
      arguments: {}
    }
  }, { tools, callTool });

  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /Unknown tool/);
});

test("create_pairing_session uses default request scopes and rejects unsupported scopes", async () => {
  const calls = [];
  const ok = await callTool("create_pairing_session", {
    base_url: "http://platform.test",
    agent: {
      agent_id: "agt_local",
      agent_name: "Local Agent",
      runtime: "mcp",
      device_label: "developer laptop"
    }
  }, {
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
      }
    ])
  });

  assert.equal(ok.isError, false);
  assert.equal(calls[0].url, "http://platform.test/v1/pairing/sessions");
  assert.deepEqual(JSON.parse(calls[0].init.body).requested_scopes, [
    "payment.requests.create",
    "payment.requests.read",
    "transaction_contexts.create",
    "transaction_contexts.read"
  ]);

  const denied = await callTool("create_pairing_session", {
    agent: {
      agent_id: "agt_local",
      agent_name: "Local Agent"
    },
    requested_scopes: [
      "payment.requests.create",
      "wallet.sign"
    ]
  }, {
    fetch: mockFetch([], [])
  });

  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, "unsupported_scope");
  assert.equal(denied.structuredContent.error.severity, "blocker");
});

test("create_transaction_context and create_payment_request use fixtures through SDK", async () => {
  const fixture = JSON.parse(await readFile(quickstartFixturePath, "utf8"));
  const calls = [];
  const context = await callTool("create_transaction_context", {
    base_url: "http://platform.test",
    connection_token: "conn_tok_test",
    transaction_context: fixture.transaction_context
  }, {
    fetch: mockFetch(calls, [
      {
        ok: true,
        status: 201,
        body: {
          ok: true,
          context: fixture.transaction_context,
          warnings: []
        }
      }
    ])
  });

  assert.equal(context.isError, false);
  assert.equal(calls[0].url, "http://platform.test/v1/transaction-contexts");
  assert.equal(calls[0].init.headers.authorization, "Bearer conn_tok_test");

  const payment = await callTool("create_payment_request", {
    base_url: "http://platform.test",
    connection_token: "conn_tok_test",
    payment_request: fixture.payment_request,
    target_app_device_id: "wallet_dev_1"
  }, {
    fetch: mockFetch(calls, [
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

  assert.equal(payment.isError, false);
  assert.equal(calls[1].url, "http://platform.test/v1/payment-requests");
  assert.equal(calls[1].init.headers.authorization, "Bearer conn_tok_test");
  assert.equal(calls[1].init.headers["x-idempotency-key"], fixture.payment_request.idempotency_key);
  assert.equal(JSON.parse(calls[1].init.body).target_app_device_id, "wallet_dev_1");
});

test("create_payment_request rejects approval bypass and preserves API error shape", async () => {
  const bypass = await callTool("create_payment_request", {
    connection_token: "conn_tok_test",
    payment_request: {
      policy: {
        requires_user_approval: false
      }
    }
  }, {
    fetch: mockFetch([], [])
  });

  assert.equal(bypass.isError, true);
  assert.equal(bypass.structuredContent.error.code, "user_approval_required");
  assert.equal(bypass.structuredContent.error.field, "payment_request.policy.requires_user_approval");
  assert.equal(bypass.structuredContent.error.severity, "blocker");

  const apiFailure = await callTool("create_payment_request", {
    base_url: "http://platform.test",
    connection_token: "conn_tok_test",
    payment_request: {
      protocol: "Paytobe.payment_request.v1",
      payment: {
        amount: "24.00"
      }
    }
  }, {
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
            field: "payment.to",
            severity: "blocker"
          }
        }
      }
    ])
  });

  assert.equal(apiFailure.isError, true);
  assert.equal(apiFailure.structuredContent.error.code, "invalid_payment_request");
  assert.equal(apiFailure.structuredContent.error.field, "payment.to");
  assert.equal(apiFailure.structuredContent.error.severity, "blocker");
});

test("get_payment_status reads request projection without updating wallet status", async () => {
  const calls = [];
  const status = await callTool("get_payment_status", {
    base_url: "http://platform.test",
    connection_token: "conn_tok_read",
    request_id: "prq_123"
  }, {
    fetch: mockFetch(calls, [
      {
        ok: true,
        status: 200,
        body: {
          ok: true,
          payment_request: {
            request_id: "prq_123",
            transaction_id: "txn_123",
            status: "pending",
            status_projection: {
              lifecycle_status: "pending",
              review_state: "pending"
            },
            risk: {
              level: "safe"
            }
          }
        }
      }
    ])
  });

  assert.equal(status.isError, false);
  assert.equal(status.structuredContent.status, "pending");
  assert.equal(calls[0].url, "http://platform.test/v1/payment-requests/prq_123");
  assert.equal(calls[0].init.method, "GET");
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
