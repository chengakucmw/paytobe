# VelarumPay Connect Platform Edge Testnet

> **Last modified**
> - **Taipei Time:** 2026-08-02 08:20:29 Asia/Taipei (UTC+08:00)
> - **UTC:** 2026-08-02 00:20:29 UTC

Public testnet edge deployment for the wallet-owned Connect Key flow. It is an independent Platform API, not an AgentFood server.

- Wallet devices create short-lived, one-time Connect Keys.
- Only registered merchant/Agent clients may claim a key.
- Agent identity is derived from the authenticated client registry, never from claim request text.
- Connections are scoped to a tenant, client, wallet device, approved permissions, expiry, and revocation state.
- Payment Requests are accepted only for Stellar testnet and always require local wallet approval.
- D1 stores tenant, client, device, invitation, connection, context, and Payment Request records with tenant/device indexes.

`PLATFORM_ADMIN_TOKEN` protects creation of testnet tenant clients through `POST /v1/admin/agent-clients`. Registered clients and Agent Assertions are the standard path. The old `AGENTFOOD_CLIENT_TOKEN` remains only as a temporary compatibility credential during the VP-TASK-087 observation window; it must not be used to bootstrap new integrations. Both values are hosted secrets and must never be committed.

The legacy `/v1/integrations/agentfood/chat` and `/v1/integrations/agentfood/connect` routes remain temporarily available for observation. Every dedicated-route request, including rejected origins, and every successful use of the old shared token emits a redacted `agentfood.legacy_path_attempt` structured log. When the optional `AGENTFOOD_LEGACY_METRICS` Analytics Engine binding is present, the Worker also writes an aggregate-safe data point. The event excludes bearer tokens, request bodies, wallet facts, and raw resource identifiers. Route deletion still requires a deployed observation window and the VP-TASK-087 removal gate.

```bash
npm test
npm run build
```
