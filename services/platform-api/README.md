# VelarumPay Platform API

> **Last modified / 最后修改时间**
> - **Taipei Time / 台北时间:** 2026-07-24 15:40:49 Asia/Taipei (UTC+08:00)
> - **UTC / 协调世界时:** 2026-07-24 07:40:49 UTC

Local development API for VelarumPay payment requests, Transaction Context Lite, and legacy AgentWallet relay compatibility.

## Features

- App device registration.
- Canonical connection-authenticated Payment Request creation; OpenClaw payment intent is legacy migration compatibility.
- Minimal-data FCM wake-up delivery plus authenticated REST compensation sync.
- WebSocket delivery as a foreground/legacy secondary channel.
- Wallet status update and agent observation: `pending`, `signed`, `broadcasted`, `confirmed`, `failed`, `expired`, `rejected`.
- Velarum Payment Request v1 normalization.
- Transaction Context v1 validation and latest-context store.
- Agent pairing sessions with QR URI and short code.
- Connection-scoped tokens for standard Payment Request create/read.
- Risk policy: chain/token allowlist, Base USDC contract allowlist, daily USDC/XLM limits, idempotency, and a fail-closed Stellar public-network gate with a fixed Horizon endpoint, single-payment cap, and mandatory recipient allowlist.
- Structured audit events and Prometheus metrics for pairing, connection, Payment Request, HTTP, and API error paths.

## Run

```bash
cd /Users/yang/code/VelarumPay/code/services/platform-api
cp .env.example .env
npm install
npm start
```

The server loads `.env` automatically unless an environment variable is already
set by the shell, systemd, Docker, or a managed runtime.

## Storage

The Platform API defaults to a SQLite store at `data/relay-store.sqlite`.
The store enables WAL mode, runs schema migrations on startup, and persists relay
state transactionally. If an older `data/relay-store.json` exists when the
default SQLite store is first created, it is imported once and a
`data/relay-store.json.migrated-to-sqlite` marker is written.

Useful environment variables:

```bash
RELAY_STORE_PATH=/var/lib/velarumpay/relay-store.sqlite
RELAY_STORE_DRIVER=sqlite
RELAY_STORE_LEGACY_JSON=/var/lib/velarumpay/relay-store.json
```

For local compatibility tests, `RELAY_STORE_DRIVER=json` or a `.json` store path
keeps the legacy JSON-backed store.

Create a store backup before deploys or schema changes:

```bash
npm run backup -- /var/backups/velarumpay/relay-store-before-deploy.sqlite
```

## Runtime Security

The production preflight is strict by design:

```bash
NODE_ENV=production \
RUNTIME_ENV=production \
RELAY_STORE_PATH=/var/lib/velarumpay/relay-store.sqlite \
CORS_ALLOWED_ORIGINS=https://wallet.example.com \
OPENCLAW_DEVICE_SECRET=replace-with-random-secret \
METRICS_TOKEN=replace-with-random-metrics-token \
FCM_ENABLED=true \
FCM_PROJECT_ID=velarumpay-production \
FCM_SERVICE_ACCOUNT_FILE=/run/secrets/firebase-service-account.json \
FCM_TOKEN_ENCRYPTION_KEY=replace-with-base64-32-byte-key \
npm run check:runtime-config
```

Production rejects weak OpenClaw secrets, unsigned legacy OpenClaw mode, wildcard
or missing CORS allowlists, incomplete FCM configuration, public metrics, and relative store paths. Local development may use
`ALLOW_UNSIGNED_OPENCLAW=true`, but unsigned legacy OpenClaw requests are still
accepted only from localhost unless `ALLOW_UNSIGNED_OPENCLAW_LOCAL_ONLY=false`.

Security-related environment variables:

```bash
CORS_ALLOWED_ORIGINS=https://wallet.example.com,https://ops.example.com
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=600
AUTH_RATE_LIMIT_MAX=120
OPENCLAW_DEVICE_SECRET=active-secret
OPENCLAW_DEVICE_SECRET_PREVIOUS=previous-secret
OPENCLAW_WS_TOKEN=legacy-websocket-token
```

Connection and app-device tokens are stored as hashes at rest. New plaintext
tokens are returned only when created or rotated.

FCM registration tokens are encrypted with AES-256-GCM at rest and bound to the wallet device identifier. Push payloads contain no amount, address, memo, payment status, or business context. The device receives only a sync signal, opaque request id, and event cursor, then retrieves authoritative data over authenticated REST. Production requires FCM so delivery cannot be silently omitted, while REST remains the source of truth.

Stellar public-network payments are disabled by default. To enable a controlled small-mainnet deployment, configure all of the following:

```bash
STELLAR_PUBLIC_ENABLED=true
STELLAR_PUBLIC_SINGLE_PAYMENT_MAX_XLM=1
STELLAR_PUBLIC_HORIZON_URL=https://horizon.stellar.org
ADDRESS_WHITELIST_STELLAR=G...verified-recipient
```

Every `stellar_public` Payment Request is blocked unless the feature is enabled, the amount is positive and no greater than the single-payment cap, the Horizon endpoint matches the configured HTTPS endpoint, and the recipient is allowlisted. This check runs independently of the Android build gate and independently of the daily XLM limit.

## Deployment

Docker Compose, systemd, health checks, preflight, and rollback notes live in:

```text
/Users/yang/code/VelarumPay/code/services/platform-api/deploy
```

## Observability and Audit Logs

`GET /metrics` returns Prometheus text metrics, including HTTP request counters,
request duration summaries, audit event counters, websocket gauges, and storage
driver info. If `METRICS_TOKEN` or `OBSERVABILITY_TOKEN` is set, callers must
send `Authorization: Bearer <token>` or `X-Observability-Token`.

Audit events are written as structured JSON lines to stdout by default and kept
in a bounded in-memory buffer for incident triage. `GET /v1/audit/events`
requires `AUDIT_LOG_READ_TOKEN` or `OBSERVABILITY_TOKEN`; without one it returns
`audit_log_token_required`.

Useful environment variables:

```bash
METRICS_TOKEN=
AUDIT_LOG_READ_TOKEN=change-me-audit-read-token
OBSERVABILITY_TOKEN=
AUDIT_EVENT_RETENTION=500
AUDIT_LOG_STDOUT=true
```

Audit payloads redact tokens, secrets, signatures, pairing codes, private-key
words, amounts, totals, fees, and costs. Addresses and transaction hashes are
stored as short SHA-256 fingerprints. The audit event stream is intended for
resource IDs, statuses, scope counts, risk levels, and error taxonomy, not raw
payment credentials or wallet secrets.

For a physical phone, set AgentWallet Relay URL to your Mac LAN IP, for example:

```text
http://192.168.1.10:8787
```

For Android emulator:

```text
http://10.0.2.2:8787
```

## API

The machine-readable public contract is `openapi/velarumpay-platform-api-v0.1.openapi.json`. It references:

- `packages/protocol/schema/velarum.payment_request.v1.schema.json` for `velarum.payment_request.v1`.
- `packages/protocol/schema/velarum.transaction_context.v1.schema.json` for `velarum.transaction_context.v1`.

Legacy PaymentIntent and OpenClaw-specific routes are implemented for migration but are not part of the canonical public OpenAPI surface.

```http
POST /v1/devices/app
POST /v1/devices/app/{device_id}/rotate-token
PUT  /v1/devices/app/{device_id}/push-token
DELETE /v1/devices/app/{device_id}/push-token
POST /v1/connect-invitations
POST /v1/connect-invitations/claim
GET  /v1/connect-invitations/{connect_invitation_id}
DELETE /v1/connect-invitations/{connect_invitation_id}
POST /v1/connect-invitations/{connect_invitation_id}/exchange
POST /v1/pairing/sessions
GET  /v1/pairing/sessions/{pairing_session_id_or_code}?code=...
POST /v1/pairing/sessions/{pairing_session_id_or_code}/approve
POST /v1/pairing/sessions/{pairing_session_id_or_code}/reject
GET  /v1/connections?device_id=...&token=...
PATCH /v1/connections/{connection_id}
DELETE /v1/connections/{connection_id}
POST /v1/connections/{connection_id}/rotate-token
POST /v1/transaction-contexts
GET  /v1/transaction-contexts/{transaction_id}
POST /v1/payment-requests
GET  /v1/payment-requests
GET  /v1/payment-requests/events
GET  /v1/payment-requests/{request_id}
POST /v1/payment-requests/{request_id}/status
GET  /v1/audit/events
GET  /metrics
POST /v1/payment-intents
GET  /v1/payment-intents?device_id=...&token=...
GET  /v1/payment-intents/{id}?device_id=...&token=...
POST /v1/payment-intents/{id}/status
GET  /v1/openclaw/events?since=0
WS   /v1/ws/app?device_id=...&token=...
WS   /v1/ws/agent?connection_token=...
WS   /v1/ws/openclaw?device_id=...&openclaw_token=...
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

`GET /v1/connections` lists wallet-owned connections without returning token plaintext. `PATCH /v1/connections/{connection_id}` accepts `status: "active"` or `status: "paused"`. `POST /v1/connections/{connection_id}/rotate-token` returns a replacement `connection_token` once. `DELETE /v1/connections/{connection_id}` marks the connection `revoked`. Paused or revoked connections are no longer accepted by standard Payment Request or Transaction Context endpoints because connection auth requires `status = "active"`.

## Standard Payment Requests

Use the connection token with either header:

```http
Authorization: Bearer conn_tok_...
X-Connection-Token: conn_tok_...
```

`POST /v1/payment-requests` requires `payment.requests.create`. `GET /v1/payment-requests` and `GET /v1/payment-requests/{request_id}` require `payment.requests.read` for agent access and only return requests owned by that connection. Wallet device reads still use `device_id` and `token` query parameters.

Connection auth errors return `unauthorized_connection`. Missing scope or cross-connection reads return `scope_denied`. The legacy OpenClaw shared-secret path is only kept as a migration fallback when an OpenClaw signature is supplied or local-only `ALLOW_UNSIGNED_OPENCLAW=true` is set.

`POST /v1/transaction-contexts` accepts `velarum.transaction_context.v1`, validates it, and stores the latest object by `transaction_id`. Standard callers should use a connection token with `transaction_contexts.create` or `transaction_contexts.read`; the legacy OpenClaw path remains available for migration and local quickstarts.

`transaction_id` is the standard reference for opening the full dossier or audit trail. The Platform API builds any immutable `transaction_context_snapshot` from the stored context owned by the same connection; caller-supplied snapshots are never trusted or used as a safe-looking fallback.

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
/Users/yang/code/VelarumPay/code/examples/payment-request-quickstart
```

Run the local smoke check from the repository root:

```bash
node examples/payment-request-quickstart/smoke-check.mjs
```

Formal specs live in `/Users/yang/code/VelarumPay/docs`; this README only documents nearby code.
