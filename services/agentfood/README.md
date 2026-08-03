# AgentFood Official Testnet Connector

> **Last modified**
> - **Taipei Time:** 2026-08-03 18:06:25 Asia/Taipei (UTC+08:00)
> - **UTC:** 2026-08-03 10:06:25 UTC

This dependency-free Node.js service is the independently deployable AgentFood backend for the official VelarumPay testnet. It creates real Recipient-bound Payment Requests through the production-like Platform API, while every chain transaction is restricted to Stellar testnet. It never holds a wallet seed phrase or wallet private key, never signs a wallet transaction, and never broadcasts one. VelarumPay still requires local user review and signing.

The commerce boundary remains intentionally limited: merchants, menu items, catalog prices, orders, and fulfillment are mock data. The test XLM amount is a fixed demonstration amount configured by the operator and is explicitly separated from the mock catalog total in every API response and Payment Request.

This service is separate from `examples/agentfood-platform-demo`. Mainnet settings are forbidden in both the service and the official cloud orchestration.

## Required production controls

- `AGENTFOOD_STELLAR_TESTNET_ENABLED=true`
- a fixed `AGENTFOOD_STELLAR_PAYMENT_AMOUNT_XLM` no greater than `AGENTFOOD_STELLAR_TESTNET_MAX_XLM`
- the official `https://horizon-testnet.stellar.org` endpoint
- one active standard Recipient selected by `AGENTFOOD_RECIPIENT_ID` and `AGENTFOOD_RECIPIENT_VERSION_ID`
- an HTTPS `PLATFORM_API_URL`, registered Agent credential, local Ed25519 Agent Assertion signer, and standard Webhook secret
- a 32-character-or-longer API key and an absolute durable store path

No `AGENTFOOD_STELLAR_MAINNET_*`, `STELLAR_PUBLIC_ENABLED`, or public-network Horizon variables may be present. The Platform API keeps its mainnet gate hard-disabled and rejects mainnet requests.

## Run and verify

Copy `.env.example` values into the deployment secret manager; do not commit a populated `.env` file. Then run:

```bash
npm --prefix services/agentfood run check
npm --prefix services/agentfood test
npm --prefix services/agentfood run start:production
```

The service exposes liveness at `GET /health`, configuration readiness at `GET /ready`, API-key-protected Connect and order routes, and the signed `POST /v1/webhooks/velarumpay` endpoint. A Connection token exists only in the in-memory session after Agent Assertion authentication and wallet approval; there is no fixed shared token or anonymous fallback. There is deliberately no food-fulfillment endpoint.
