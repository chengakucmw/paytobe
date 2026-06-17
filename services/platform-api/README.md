# VelarumPay Platform API

Local development API for VelarumPay payment requests, Transaction Context Lite, and legacy AgentWallet relay compatibility.

## Features

- App device registration.
- OpenClaw-signed payment intent creation.
- WebSocket delivery to AgentWallet App.
- REST inbox sync.
- Status callback: `pending`, `signed`, `broadcasted`, `confirmed`, `failed`, `expired`, `rejected`.
- Velarum Payment Request v1 normalization.
- Transaction Context v1 validation and latest-context store.
- Agent pairing sessions with QR URI and short code.
- Connection-scoped tokens for standard Payment Request create/read.
- Risk policy: chain/token allowlist, Base USDC contract allowlist, optional address whitelist, daily USDC/XLM limits, idempotency.

## Run

```bash
cd /Users/yang/code/VelarumPayCode/services/platform-api
cp .env.example .env
npm install
OPENCLAW_DEVICE_SECRET=change-me-openclaw-secret npm start
```

For a physical phone, set AgentWallet Relay URL to your Mac LAN IP, for example:

```text
http://192.168.1.10:8787
```

For Android emulator:

```text
http://10.0.2.2:8787
```

## API

```http
POST /v1/devices/app
POST /v1/pairing/sessions
GET  /v1/pairing/sessions/{pairing_session_id_or_code}?code=...
POST /v1/pairing/sessions/{pairing_session_id_or_code}/approve
POST /v1/pairing/sessions/{pairing_session_id_or_code}/reject
GET  /v1/connections?device_id=...&token=...
PATCH /v1/connections/{connection_id}
DELETE /v1/connections/{connection_id}
POST /v1/transaction-contexts
GET  /v1/transaction-contexts/{transaction_id}
POST /v1/payment-requests
GET  /v1/payment-requests
GET  /v1/payment-requests/events
GET  /v1/payment-requests/{request_id}
POST /v1/payment-requests/{request_id}/status
POST /v1/payment-intents
GET  /v1/payment-intents?device_id=...&token=...
GET  /v1/payment-intents/{id}?device_id=...&token=...
POST /v1/payment-intents/{id}/status
GET  /v1/openclaw/events?since=0
WS   /v1/ws/app?device_id=...&token=...
WS   /v1/ws/agent?connection_token=...
WS   /v1/ws/openclaw?device_id=...
```

## Pairing and Connection Tokens

`POST /v1/pairing/sessions` accepts:

```json
{
  "agent": {
    "agent_id": "agt_local_123",
    "agent_name": "Hermes on Alice MacBook",
    "runtime": "hermes",
    "device_label": "Alice MacBook"
  },
  "requested_scopes": [
    "payment.requests.create",
    "payment.requests.read"
  ],
  "expires_in_seconds": 300
}
```

It returns both `pairing_uri` and `pairing_code` for the same pending session. Pairing sessions default to 5 minutes and may be set from 60 to 600 seconds. v0.1 grantable scopes are:

- `payment.requests.create`
- `payment.requests.read`
- `transaction_contexts.create`
- `transaction_contexts.read`
- `wallet.addresses.read`

Signing, seed, private-key, and other unsupported scopes return a structured `unsupported_scope` error.

Wallet apps can review a pairing session before approval:

```http
GET /v1/pairing/sessions/pair_...?code=482913
GET /v1/pairing/sessions/482913
```

The response includes the agent identity, requested scopes, session status, pairing URI, short code, and expiration. It never returns a connection token.

Approve or reject a pending session with wallet app credentials in the JSON body:

```json
{
  "device_id": "wallet-demo",
  "token": "wallet-token",
  "approved_scopes": [
    "payment.requests.create",
    "payment.requests.read"
  ]
}
```

Approve creates an active connection and returns `connection_id`, `connection_token`, `scopes`, `agent_identity`, `status`, and `expires_at`. Reject marks the session `rejected` and does not create a connection. Approved, rejected, or expired sessions cannot be approved again.

Wallet apps manage approved connections with device credentials:

```json
{
  "device_id": "wallet-demo",
  "token": "wallet-token"
}
```

`GET /v1/connections` lists wallet-owned connections without returning token plaintext. `PATCH /v1/connections/{connection_id}` accepts `status: "active"` or `status: "paused"`. `DELETE /v1/connections/{connection_id}` marks the connection `revoked`. Paused or revoked connections are no longer accepted by standard Payment Request or Transaction Context endpoints because connection auth requires `status = "active"`.

## Standard Payment Requests

Use the connection token with either header:

```http
Authorization: Bearer conn_tok_...
X-Connection-Token: conn_tok_...
```

`POST /v1/payment-requests` requires `payment.requests.create`. `GET /v1/payment-requests` and `GET /v1/payment-requests/{request_id}` require `payment.requests.read` for agent access and only return requests owned by that connection. Wallet device reads still use `device_id` and `token` query parameters.

Connection auth errors return `unauthorized_connection`. Missing scope or cross-connection reads return `scope_denied`. The legacy OpenClaw shared-secret path is only kept as a migration fallback when an OpenClaw signature is supplied or `ALLOW_UNSIGNED_OPENCLAW=true` is set.

`POST /v1/transaction-contexts` accepts `velarum.transaction_context.v1`, validates it, and stores the latest object by `transaction_id`. Standard callers should use a connection token with `transaction_contexts.create` or `transaction_contexts.read`; the legacy OpenClaw path remains available for migration and local quickstarts.

Payment Request creation can carry `transaction_context_snapshot` as a compatibility shortcut, while `transaction_id` remains the standard reference for opening the full dossier or audit trail.

Payment Request creation reads `x-idempotency-key` or body `idempotency_key`. Standard requests scope idempotency by `connection_id`; legacy requests without a connection keep the migration-compatible key behavior. A duplicate returns `duplicate: true` and the existing `payment_request` projection.

`GET /v1/payment-requests` returns `items` sorted by the latest `updated_at` or `created_at` timestamp. `GET /v1/payment-requests/{request_id}` returns a single `payment_request`. Both standard read projections keep hard Payment Facts separate from display and metadata:

```json
{
  "payment_request": {
    "request_id": "prq_...",
    "transaction_id": "txn_...",
    "status": "pending",
    "source": {},
    "payee": {},
    "payment": {},
    "payment_facts": {},
    "transaction_context_ref": {
      "transaction_id": "txn_...",
      "status": "ready",
      "snapshot_hash": "sha256:..."
    },
    "transaction_context_snapshot": {},
    "context": {
      "status": "ready",
      "has_snapshot": true
    },
    "risk": {
      "level": "safe",
      "review_status": "ready",
      "signing_allowed": true,
      "errors": [],
      "warnings": []
    },
    "status_projection": {
      "lifecycle_status": "pending",
      "review_state": "pending",
      "label": "Awaiting signature",
      "tone": "safe",
      "group": "pending",
      "inbox_group": "pending",
      "is_final": false,
      "requires_attention": false,
      "signing_allowed": true
    }
  }
}
```

Wallet inbox filters can use `inbox_group`: `pending` includes active and attention states such as missing context, risk blocked, source review required, broadcasting, and failed; `final` includes confirmed, rejected, expired, and cancelled. `status` remains the protocol lifecycle value (`pending`, `signed`, `broadcasted`, `confirmed`, `failed`, `expired`, `rejected`) while `review_state` is the UI-oriented state (`missing_context`, `blocked`, `source_review_required`, `broadcasting`, etc.).

Context risk checks are deterministic and never let Transaction Context override `payment.amount`, `payment.to`, `payment.asset`, or `payment.network`. Blockers are returned in `risk.errors`; warnings and review-required findings are returned in `risk.warnings`. Current codes include `context_amount_mismatch`, `context_payee_mismatch`, `context_asset_mismatch`, `context_network_mismatch`, `context_fee_basis_warning`, `context_missing`, and `ai_only_critical_field`.

Wallet devices update standard Payment Request status with:

```json
{
  "device_id": "wallet-demo",
  "token": "wallet-token",
  "status": "broadcasted",
  "tx_hash": "0x..."
}
```

Allowed status updates are `signed`, `broadcasted`, `confirmed`, `failed`, `expired`, and `rejected`. The status endpoint only accepts the target wallet device token. Agent or connector connection tokens can read status through `GET /v1/payment-requests`, `GET /v1/payment-requests/{request_id}`, `GET /v1/payment-requests/events?since=0`, or `WS /v1/ws/agent?connection_token=...`, but cannot confirm or reject a user request.

Status update responses return the standard `payment_request` projection and append to `history`. Standard agent events use `payment_request.created` and `payment_request.status`; the legacy OpenClaw event and WebSocket paths remain available during migration.

## Quickstart Fixtures

Copyable Payment Request and Transaction Context examples live under:

```text
/Users/yang/code/VelarumPayCode/examples/payment-request-quickstart
```

Run the local smoke check from the repository root:

```bash
node examples/payment-request-quickstart/smoke-check.mjs
```

Formal specs live in `/Users/yang/code/VelarumPay`; this README only documents nearby code.
