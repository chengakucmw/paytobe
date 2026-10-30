# JavaScript SDK

> **Last modified / 最后修改时间**
> - **Taipei Time / 台北时间:** 2026-10-29 13:41:42 Asia/Taipei (UTC+08:00)
> - **UTC / 协调世界时:** 2026-10-29 05:41:42 UTC


Minimal JavaScript SDK for local agents and app developers using Paytobe Platform API v0.1.

Package name: `@Paytobe/sdk-js`
Version: `0.1.0`  
Entry point: `./src/index.js`  
Types: `./src/index.d.ts`  
Runtime dependency: `@Paytobe/protocol@0.1.0`

## Agent Auth Quickstart

The SDK creates Agent Assertions locally and exchanges them for short-lived Agent tokens. The `signer` receives only canonical bytes and an opaque `keyHandle`; private-key access remains inside the caller's secure signer.

```js
import { createPaytobeClient } from "@Paytobe/sdk-js";

const client = createPaytobeClient({
  baseUrl: "https://api.Paytobe.com",
  agentAuth: {
    agentId: "agt_local_123",
    clientId: "client_local_123",
    kid: "cred_active_123",
    scopes: ["payment.requests.create", "payment.requests.read"],
    keyHandle: secureKeyHandle,
    signer: ({ data, keyHandle }) => secureSigner.sign(data, keyHandle)
  }
});

const claim = await client.claimConnectInvitation(connectKey, [
  "payment.requests.create",
  "payment.requests.read"
]);
```

Agent tokens are held in memory, refreshed before expiry, and refreshed at most once after a `401`. A `403`, revoked credential, clock-skew failure, or duplicate JTI is returned without a retry loop.

## Payment Request Quickstart

Payment Request methods use a connection token, which is intentionally separate from Agent and merchant authentication.

```js
import { createPaytobeClient, validatePaymentRequest } from "@Paytobe/sdk-js";

const client = createPaytobeClient({
  baseUrl: "https://api.Paytobe.com",
  connectionToken
});

await client.createTransactionContext(transactionContextPayload);

const validation = validatePaymentRequest(paymentRequestPayload);
if (!validation.ok) {
  console.error(validation.error);
}

const created = await client.createPaymentRequest(paymentRequestPayload, {
  idempotencyKey: paymentRequestPayload.idempotency_key
});
const detail = await client.getPaymentRequest(created.payment_request.request_id);
const events = await client.pollEvents({ since: 0 });
```

Every call sends an `x-request-id`; mutation methods accept `idempotencyKey`. The SDK keeps API errors structured and redacts assertions, tokens, secrets, signatures, seed material, and private-key material from failure objects.

## Authentication Boundaries

- Agent authentication: local signer callback, short-lived in-memory Agent token, Connect claim only.
- Connection authentication: connection token for Transaction Context and Payment Request APIs.
- Merchant control plane: same-origin merchant session cookie plus an in-memory CSRF proof; the SDK never reads the cookie value.
- Connect claim-token exchange: a short-lived claim token supplied only to the invitation detail and exchange calls.

## Scope

- Agent token exchange and Connect invitation claim/exchange.
- Agent and credential registration, lifecycle, and listing.
- Recipient registration, verification, version activation, and listing.
- Pairing, Transaction Context, Payment Request, and event polling.
- Webhook endpoint lifecycle, delivery listing, and bounded replay.
- Protocol validation helpers from `packages/protocol`.

This SDK does not store private keys, seed phrases, signing material, or automatic payment authority.

## Typed API Surface

- `PaytobeClientOptions`
- `AgentAuthOptions`
- `AgentSignerInput`
- `RequestOptions`
- `ApiResult`
- `ApiError`
- `PaytobeClient`
- `createPaytobeClient(options)`
- `createPairingSession(payload, options)`
- `createTransactionContext(payload, options)`
- `createPaymentRequest(payload, options)`
- `getPaymentRequest(requestId, options)`
- `pollEvents(options)`
- `claimConnectInvitation(connectKey, scopes, options)`
- Agent, Recipient, and Webhook client methods on `PaytobeClient`
- `validatePaymentRequest(payload, options)`
- `validateTransactionContext(payload, options)`

Quickstart fixtures live in `examples/payment-request-quickstart`. Public contract sources:

- `packages/protocol/schema/Paytobe.payment_request.v1.schema.json`
- `packages/protocol/schema/Paytobe.transaction_context.v1.schema.json`
- `services/platform-api/openapi/Paytobe-platform-api-v0.1.openapi.json`

## Check

```bash
cd packages/sdk-js
npm run check
npm test
npm run pack:dry
```
