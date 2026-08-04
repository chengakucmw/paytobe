# VelarumPay Connect Platform Edge Testnet

> **Last modified**
> - **Taipei Time:** 2026-08-04 21:07:25 Asia/Taipei (UTC+08:00)
> - **UTC:** 2026-08-04 13:07:25 UTC

Public testnet edge deployment for the wallet-owned Connect Key flow. It is an independent Platform API, not an AgentFood server.

- Wallet devices create short-lived, one-time Connect Keys.
- Only registered merchant/Agent clients may claim a key.
- Agent identity is derived from the authenticated client registry, never from claim request text.
- Connections are scoped to a tenant, client, wallet device, approved permissions, expiry, and revocation state.
- Payment Requests are accepted only for Stellar testnet and always require local wallet approval.
- D1 stores tenant, client, device, invitation, connection, context, and Payment Request records with tenant/device indexes.

`PLATFORM_ADMIN_TOKEN` protects creation of testnet tenant clients through `POST /v1/admin/agent-clients`. Registered clients and Agent Assertions are the only supported Agent authentication paths. Hosted secrets must never be committed.

The former AgentFood-specific integration routes and shared-token authentication path have been removed. AgentFood now uses the same registered Merchant, Agent Assertion, Connect, Transaction Context, Recipient, and Payment Request contracts as every other integration. Requests to deleted routes receive the normal `404 not_found` response.

```bash
npm test
npm run build
```
