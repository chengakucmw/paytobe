# VelarumPay Developer Docs Site

> **Last modified / 最后修改时间**
> - **Taipei Time / 台北时间:** 2026-08-02 02:05:41 Asia/Taipei (UTC+08:00)
> - **UTC / 协调世界时:** 2026-08-01 18:05:41 UTC

Static developer documentation and quickstart for VelarumPay Platform API v0.1.
Plain HTML served by a tiny zero-dependency Node static server (same pattern as
`apps/website`).

## Contract sources

- Platform API: `services/platform-api/openapi/velarumpay-platform-api-v0.1.openapi.json`.
- Payment Request: `packages/protocol/schema/velarum.payment_request.v1.schema.json` for `velarum.payment_request.v1`.
- Transaction Context: `packages/protocol/schema/velarum.transaction_context.v1.schema.json` for `velarum.transaction_context.v1`.

The HTML pages are explanatory guides. When an example conflicts with these machine-readable contracts or runtime validators, treat the conflict as a documentation defect and block publication until the same change updates the guide, contract, and tests.

Synchronize the public downloadable copies before local review, packaging, or deployment:

```bash
node apps/docs/scripts/sync-contracts.mjs
```

`tests/protocol/documentation-contract.test.mjs` byte-compares the public copies with the canonical sources.

## Pages

- `public/index.html` — overview and the "no API key" trust model.
- `public/quickstart.html` — merchant registration through a user-approved test request.
- `public/api.html` — REST API reference (auth, endpoints, example).
- `public/agent-auth.html` — local-signer Agent Assertion and bounded token refresh.
- `public/webhooks.html` — raw-body HMAC verification and delivery replay semantics.
- `public/protocol.html` — `payment_request.v1` and `transaction_context.v1`.
- `public/mcp.html` — MCP server setup for AI agents.

Public non-production vectors live under `public/vectors/`. The Assertion vector deliberately has no signing key and an invalid mock signature; the HMAC vector uses an explicitly public test key.

## Test

```bash
npm --prefix apps/docs test
node --test tests/protocol/documentation-contract.test.mjs
node examples/generic-payment-request/merchant-quickstart.mjs
```

## Run locally

```bash
cd apps/docs
node server.mjs
# http://localhost:8092
```

Override the port with `PORT`. The site is fully static, so it can also be
served by any static host or by Caddy directly.

## Deployment boundary

Deployment configuration belongs to the private sibling repository at
`/Users/yang/code/VelarumPay/cloud`. Local documentation work does not deploy or
publish the site.
