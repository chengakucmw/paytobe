# AgentFood Independent Production Connector

> **Last modified**
> - **Taipei Time:** 2026-08-02 03:04:51 Asia/Taipei (UTC+08:00)
> - **UTC:** 2026-08-01 19:04:51 UTC

This dependency-free Node.js service is the independently deployable AgentFood backend. It creates real Stellar public-network Payment Requests through the VelarumPay Platform API, but never holds a seed phrase or private key, never signs, and never broadcasts. VelarumPay still requires local user review and signing.

The commerce boundary remains intentionally limited: merchants, menu items, catalog prices, orders, and fulfillment are mock data. The real XLM amount is a fixed small demonstration settlement configured by the operator and is explicitly separated from the mock catalog total in every API response and Payment Request.

This service is separate from `examples/agentfood-platform-demo`. The OpenAI Sites project remains a public mock/Stellar-testnet reference demo and must not receive this service's mainnet configuration or secrets.

## Required production controls

- `AGENTFOOD_STELLAR_MAINNET_ENABLED=true`
- a fixed `AGENTFOOD_STELLAR_PAYMENT_AMOUNT_XLM` no greater than `AGENTFOOD_STELLAR_MAINNET_MAX_XLM`
- the official `https://horizon.stellar.org` endpoint
- one active standard Recipient selected by `AGENTFOOD_RECIPIENT_ID` and `AGENTFOOD_RECIPIENT_VERSION_ID`
- an HTTPS `PLATFORM_API_URL`, registered Agent credential, local Ed25519 Agent Assertion signer, and standard Webhook secret
- a 32-character-or-longer API key and an absolute durable store path

The Platform API must independently enable the same mainnet boundary with `STELLAR_PUBLIC_ENABLED=true`, a compatible single-payment cap, the same Horizon endpoint, and the AgentFood recipient in `ADDRESS_WHITELIST_STELLAR`.

## Run and verify

Copy `.env.example` values into the deployment secret manager; do not commit a populated `.env` file. Then run:

```bash
npm --prefix services/agentfood run check
npm --prefix services/agentfood test
npm --prefix services/agentfood run start:production
```

The service exposes liveness at `GET /health`, configuration readiness at `GET /ready`, API-key-protected Connect and order routes, and the signed `POST /v1/webhooks/velarumpay` endpoint. A Connection token exists only in the in-memory session after Agent Assertion authentication and wallet approval; there is no fixed shared token or anonymous fallback. There is deliberately no food-fulfillment endpoint.
