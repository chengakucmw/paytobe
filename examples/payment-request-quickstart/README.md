# Payment Request Quickstart Fixtures

> **Last modified**
> - **Taipei Time:** 2026-07-21 21:50:07 Asia/Taipei (UTC+08:00)
> - **UTC:** 2026-07-21 13:50:07 UTC

Copyable Payment Request and Transaction Context examples for local developer preview.

These fixtures are for validation, local routing, and smoke checks. They do not contain private keys, real user data, or mainnet funds. Base USDC examples use mainnet chain identifiers because the validator checks the production Base USDC contract, but the smoke check only creates requests and writes local status callbacks.

## Fixtures

- `fixtures/base_usdc.json`: generic Base USDC developer test request.
- `fixtures/normal.json`: AgentFood normal pending request on Base USDC.
- `fixtures/stellar_xlm.json`: valid Stellar XLM testnet request.
- `fixtures/missing_context.json`: GearScout request with missing evidence warning.
- `fixtures/mismatch.json`: TripPlanner payee and recipient mismatch blocker.
- `fixtures/ai_only.json`: LearnScout AI-only critical claim warning.
- `fixtures/expired.json`: AgentFood request materialized with a short TTL by the cross-component smoke harness.
- `fixtures/asset_network_mismatch.json`: negative asset/network mismatch blocker.

Every fixture includes:

- `payment_request.request_id`
- `payment_request.transaction_id`
- `payment_request.idempotency_key`
- `transaction_context.transaction_id`

## Smoke Check

Run from the repository root:

```bash
node examples/payment-request-quickstart/smoke-check.mjs
```

By default the script starts a temporary local Platform API on port `18787`, stores runtime data under a temporary directory, then removes it. To use an already running API:

```bash
BASE_URL=http://127.0.0.1:8787 node examples/payment-request-quickstart/smoke-check.mjs
```

The smoke check covers:

- wallet device registration
- pairing session creation and approval
- Transaction Context create
- Payment Request create
- wallet list and detail reads
- `POST /v1/payment-requests/{id}/status` reject update
- `broadcasted` update with `tx_hash`
- `confirmed` update recorded in history
- invalid status structured error
- agent token rejection on wallet status update
- `/v1/payment-requests/events` polling
- `/v1/ws/agent` connection-token WebSocket status notification

## Cross-Component Smoke Harness

Run the developer preview harness from the repository root:

```bash
node scripts/cross-component-smoke.mjs
```

By default it starts a temporary local Platform API, runs the standard fixtures
`normal`, `missing_context`, `mismatch`, `ai_only`, and `expired`, and verifies
the SDK, CLI, OpenClaw payload builder, MCP tools, and Hermes adapter. It also
covers Base USDC and Stellar XLM, list/detail reads, wallet status updates,
events polling, and structured expected failures for API/schema/connector
diagnostics.

Use an existing API or write reports to a fixed directory:

```bash
BASE_URL=http://127.0.0.1:8787 node scripts/cross-component-smoke.mjs
node scripts/cross-component-smoke.mjs --report-dir tests/smoke-results/manual
node scripts/cross-component-smoke.mjs --json
```

The harness writes a machine-readable JSON result and a human-readable Markdown
summary. It never reads private keys, seed phrases, signing keys, or mainnet
funds.

## Package Smoke

The SDK and connector packages have typed entry points and dry-run tarball
checks:

```bash
cd /Users/yang/code/VelarumPay/code
npm run package:integrations
```

This verifies the packable file lists for:

- `@velarumpay/protocol@0.1.0`
- `@velarumpay/sdk-js@0.1.0`
- `@velarumpay/mcp-server@0.1.0`
- `@velarumpay/hermes-connector@0.1.0`

## CLI Quickstart

Start the local Platform API first:

```bash
cd /Users/yang/code/VelarumPay/code/services/platform-api
npm install
OPENCLAW_DEVICE_SECRET=change-me-openclaw-secret npm start
```

In another terminal, create and approve a local dev pairing. The dev approval uses wallet device credentials only; it does not grant signing permission and does not touch private keys:

```bash
cd /Users/yang/code/VelarumPay/code
node examples/payment-request-quickstart/cli.mjs pair --approve-dev-wallet
```

Copy the exported `CONNECTION_TOKEN`, `WALLET_DEVICE_ID`, `WALLET_TOKEN`, and `QUICKSTART_RUN_ID` from the output. Then create a Transaction Context and Payment Request:

```bash
node examples/payment-request-quickstart/cli.mjs context:create --fixture stellar_xlm
node examples/payment-request-quickstart/cli.mjs request:create --fixture stellar_xlm
```

For Base USDC, use the explicit developer fixture:

```bash
node examples/payment-request-quickstart/cli.mjs context:create --fixture base_usdc
node examples/payment-request-quickstart/cli.mjs request:create --fixture base_usdc
```

Read status and poll events with the connection token:

```bash
node examples/payment-request-quickstart/cli.mjs request:get "$REQUEST_ID"
node examples/payment-request-quickstart/cli.mjs events:poll --since 0
```

To simulate local wallet status callbacks, use the wallet credentials printed by `pair --approve-dev-wallet`:

```bash
node examples/payment-request-quickstart/cli.mjs request:reject "$REQUEST_ID"
node examples/payment-request-quickstart/cli.mjs request:confirm "$REQUEST_ID" --tx-hash local-dev-confirmed
```

`request:confirm` is a local dev status callback only. It does not sign, broadcast, or require mainnet/testnet funds.

## Manual Curl Shape

After approving a pairing session and receiving `connection_token`, create a context:

```bash
jq '.transaction_context' examples/payment-request-quickstart/fixtures/normal.json |
curl -s http://127.0.0.1:8787/v1/transaction-contexts \
  -H "authorization: Bearer $CONNECTION_TOKEN" \
  -H "content-type: application/json" \
  --data-binary @-
```

Then create the request for a registered wallet device:

```bash
jq '.payment_request + {target_app_device_id: env.WALLET_DEVICE_ID}' examples/payment-request-quickstart/fixtures/normal.json |
curl -s http://127.0.0.1:8787/v1/payment-requests \
  -H "authorization: Bearer $CONNECTION_TOKEN" \
  -H "content-type: application/json" \
  -H "x-idempotency-key: agentfood-run-1842-payment-1" \
  --data-binary @-
```

The fixture file wraps both objects, so direct curl calls should post only the nested `transaction_context` or `payment_request` object.
