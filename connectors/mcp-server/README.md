# VelarumPay MCP Server

Local MCP stdio server for VelarumPay Payment Request v1. It exposes tools for
pairing, Transaction Context creation, Payment Request creation, and status
reads. It does not hold wallet private keys, sign transactions, approve
payments, reject payments, or update wallet status.

## Tools

- `create_pairing_session`
- `create_transaction_context`
- `create_payment_request`
- `get_payment_status`

`create_pairing_session` only accepts these v0.1 scopes:

- `payment.requests.create`
- `payment.requests.read`
- `transaction_contexts.create`
- `transaction_contexts.read`

Signing, private-key, seed, automatic approval, status-update, and wallet
approval scopes are not exposed by this server. The Platform API still performs
connection token and scope checks for every create/read call.

## Run

```bash
cd /Users/yang/code/VelarumPayCode/connectors/mcp-server
npm run start
```

Environment variables:

```bash
export VELARUMPAY_API_BASE_URL=http://127.0.0.1:8787
export VELARUMPAY_CONNECTION_TOKEN=conn_tok_...
```

Tool inputs may also pass `base_url` and `connection_token` per call.
If a payload includes `connection_id`, it must match the approved connection
token. For local agent calls, omitting `connection_id` lets the Platform API
derive it from the token.

## Local Agent Examples

Create a pairing session:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "create_pairing_session",
    "arguments": {
      "agent": {
        "agent_id": "agt_mcp_local",
        "agent_name": "VelarumPay MCP Local Agent",
        "runtime": "mcp",
        "device_label": "local developer machine"
      }
    }
  }
}
```

Create a Transaction Context after the wallet approves pairing and returns a
connection token:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "create_transaction_context",
    "arguments": {
      "connection_token": "conn_tok_...",
      "transaction_context": {
        "protocol": "velarum.transaction_context.v1",
        "transaction_id": "txn_mcp_demo_1",
        "type": "developer_test",
        "title": "Developer test checkout",
        "summary": "A local developer test context for wallet review.",
        "costs": {
          "total": "42.00",
          "currency": "USDC"
        },
        "truth_fields": [],
        "evidence": []
      }
    }
  }
}
```

Create a Payment Request:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "create_payment_request",
    "arguments": {
      "connection_token": "conn_tok_...",
      "target_app_device_id": "wallet_dev_1",
      "payment_request": {
        "protocol": "velarum.payment_request.v1",
        "transaction_id": "txn_mcp_demo_1",
        "idempotency_key": "mcp-demo-payment-1",
        "payment": {
          "rail": "base_usdc",
          "network": "base_mainnet",
          "asset": "USDC",
          "amount": "42.00",
          "to": "0x71d83a5924b0e6d3c8a9f102bb48e4c912a556d0",
          "token_contract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          "chain_id": 8453,
          "decimals": 6
        },
        "payee": {
          "name": "VelarumPay Developer Test",
          "verified": false
        },
        "policy": {
          "requires_user_approval": true
        }
      }
    }
  }
}
```

Read status:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "get_payment_status",
    "arguments": {
      "connection_token": "conn_tok_...",
      "request_id": "prq_..."
    }
  }
}
```

## Fixtures

Minimal tool input examples live in `fixtures/`. Full quickstart Payment Request
fixtures remain in:

```text
/Users/yang/code/VelarumPayCode/examples/payment-request-quickstart/fixtures
```

## Check

```bash
npm run check
```
