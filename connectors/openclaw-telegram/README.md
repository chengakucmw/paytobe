# OpenClaw Telegram Connector

> **Last modified**
> - **Taipei Time:** 2026-07-21 21:50:07 Asia/Taipei (UTC+08:00)
> - **UTC:** 2026-07-21 13:50:07 UTC

Local OpenClaw-side bridge for Telegram payment commands.

The connector now builds a standard `velarum.payment_request.v1` payload and keeps the legacy `agentwallet.payment_intent.v1` relay wrapper for migration. It never handles private keys, mnemonic phrases, wallet signing, or automatic payment approval.

## Supported Commands

```text
send 10 USDC on Base to 0x1111111111111111111111111111111111111111
send 25 XLM to GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
转账 10 USDC 到 base 0x1111111111111111111111111111111111111111
转账 25 恒星币 到 GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
```

The parser may still accept the migration alias `evm_erc20` for Base USDC input. The standard Payment Request builder emits canonical `payment.rail = "base_usdc"`.

## Flow

1. Telegram message arrives.
2. Connector parses hard payment fields: amount, recipient, network, and asset.
3. Connector builds a standard `velarum.payment_request.v1` payload.
4. AgentFood or Telegram-specific details stay in `metadata`, for example `metadata.food_order`.
5. Connector builds a legacy relay wrapper that includes the standard payload at `payment_request` and `velarum.payload.payment_request`.
6. Connector submits the legacy wrapper to `/v1/payment-intents`, or callers can submit `payment_request` directly to `/v1/payment-requests`.
7. The wallet reviews and signs locally only after user approval.

## Run

```bash
cd /Users/yang/code/VelarumPay/code/connectors/openclaw-telegram
cp .env.example .env
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_ALLOWED_CHAT_IDS=123456 \
AGENTWALLET_RELAY_URL=http://localhost:8787 \
OPENCLAW_DEVICE_SECRET=change-me-openclaw-secret \
TARGET_APP_DEVICE_ID=android-... \
npm start
```

Dry run:

```bash
node src/index.js --dry-run "send 1 USDC on Base to 0x0000000000000000000000000000000000000001"
```

The dry-run output is a legacy `PaymentIntent` wrapper with a nested standard `payment_request`.

## Standard Payload Builder

Use `buildPaymentRequest()` when a caller wants the standard object for `POST /v1/payment-requests`.

### Base USDC AgentFood Example

```js
import { buildPaymentRequest } from "./src/intent_builder.js";

const paymentRequest = buildPaymentRequest({
  rail: "base_usdc",
  network: "base_mainnet",
  asset: "USDC",
  amount: "24.00",
  to: "0x9b1c2f4e3a8d5c6b7e9f0a1b2c3d4e5f60718293",
  token_contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  chain_id: 8453,
  decimals: 6
}, {
  request_id: "prq_agentfood_1842",
  transaction_id: "txn_agentfood_1842",
  connection_id: "conn_agentfood_demo",
  created_at: "2026-06-17T10:00:00.000Z",
  expires_at: "2026-06-17T10:05:00.000Z",
  idempotency_key: "agentfood-run-1842-payment-1",
  agent_id: "agt_agentfood",
  agent_name: "AgentFood",
  runtime: "openclaw",
  channel: "telegram",
  payee: {
    name: "Oaxaca Kitchen",
    domain: "oaxaca.example",
    verified: true
  },
  display: {
    title: "Dinner order from Oaxaca Kitchen",
    summary: "AgentFood prepared a one-time USDC payment."
  },
  food_order: {
    order_id: "ord_agentfood_1842",
    restaurant: { name: "Oaxaca Kitchen" },
    items: [{ name: "Mole Negro Plate", quantity: 1 }]
  }
});
```

Output shape:

```json
{
  "protocol": "velarum.payment_request.v1",
  "request_id": "prq_agentfood_1842",
  "connection_id": "conn_agentfood_demo",
  "transaction_id": "txn_agentfood_1842",
  "created_at": "2026-06-17T10:00:00.000Z",
  "expires_at": "2026-06-17T10:05:00.000Z",
  "idempotency_key": "agentfood-run-1842-payment-1",
  "status": "pending",
  "source": {
    "agent_id": "agt_agentfood",
    "agent_name": "AgentFood",
    "runtime": "openclaw",
    "channel": "telegram",
    "device_id": "mac-openclaw-01"
  },
  "payee": {
    "name": "Oaxaca Kitchen",
    "domain": "oaxaca.example",
    "verified": true
  },
  "payment": {
    "rail": "base_usdc",
    "network": "base_mainnet",
    "asset": "USDC",
    "amount": "24.00",
    "to": "0x9b1c2f4e3a8d5c6b7e9f0a1b2c3d4e5f60718293",
    "token_contract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "chain_id": 8453,
    "decimals": 6
  },
  "policy": {
    "requires_user_approval": true
  },
  "display": {
    "title": "Dinner order from Oaxaca Kitchen",
    "summary": "AgentFood prepared a one-time USDC payment.",
    "primary_action": "Pay"
  },
  "metadata": {
    "type": "food_order",
    "food_order": {
      "order_id": "ord_agentfood_1842",
      "restaurant": { "name": "Oaxaca Kitchen" },
      "items": [{ "name": "Mole Negro Plate", "quantity": 1 }]
    }
  }
}
```

AgentFood fields are metadata only. If `metadata.food_order` is removed, the wallet still has complete hard Payment Facts in `payment.amount`, `payment.to`, `payment.network`, and `payment.asset`.

### Stellar XLM Example

```js
import { buildPaymentRequest } from "./src/intent_builder.js";

const paymentRequest = buildPaymentRequest({
  rail: "stellar_xlm",
  network: "stellar_testnet",
  asset: "XLM",
  amount: "32.50",
  to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  memo: "book-order-1001"
}, {
  request_id: "prq_stellar_xlm_1001",
  transaction_id: "txn_stellar_xlm_1001",
  connection_id: "conn_stellar_demo",
  idempotency_key: "stellar-demo-payment-1",
  payee: { name: "Harbor Books" }
});
```

Output payment fields:

```json
{
  "rail": "stellar_xlm",
  "network": "stellar_testnet",
  "asset": "XLM",
  "amount": "32.50",
  "to": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "memo": "book-order-1001"
}
```

`stellar_public` is also accepted. Use `stellar_testnet` for quickstart and smoke checks unless you are explicitly testing a real public network request.

## Submit Paths

Standard Payment Request endpoint:

```bash
curl -s http://127.0.0.1:8787/v1/payment-requests \
  -H "authorization: Bearer $CONNECTION_TOKEN" \
  -H "content-type: application/json" \
  -H "x-idempotency-key: agentfood-run-1842-payment-1" \
  --data-binary @payment-request.json
```

Legacy relay endpoint:

```bash
node src/index.js --dry-run "send 24 USDC on Base to 0x9b1c2f4e3a8d5c6b7e9f0a1b2c3d4e5f60718293"
```

The legacy wrapper keeps `payment.rail = "base_usdc"` for Base USDC and includes the standard payload at:

- `payment_request`
- `velarum.payment_request`
- `velarum.payload.payment_request`

## Checks

```bash
cd /Users/yang/code/VelarumPay/code/connectors/openclaw-telegram
npm install
npm run check
```
