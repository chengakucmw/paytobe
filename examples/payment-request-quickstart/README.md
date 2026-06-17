# Payment Request Quickstart Fixtures

Copyable Payment Request and Transaction Context examples for local developer preview.

These fixtures are for validation, local routing, and smoke checks. They do not contain private keys, real user data, or mainnet funds. Base USDC examples use mainnet chain identifiers because the validator checks the production Base USDC contract, but the smoke check only creates requests and writes local status callbacks.

## Fixtures

- `fixtures/normal.json`: AgentFood normal pending request on Base USDC.
- `fixtures/stellar_xlm.json`: valid Stellar XLM testnet request.
- `fixtures/missing_context.json`: GearScout request with missing evidence warning.
- `fixtures/mismatch.json`: TripPlanner payee and recipient mismatch blocker.
- `fixtures/ai_only.json`: LearnScout AI-only critical claim warning.
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
