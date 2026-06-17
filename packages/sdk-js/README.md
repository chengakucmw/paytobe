# JavaScript SDK

Minimal JavaScript SDK for local agents and app developers using VelarumPay Platform API v0.1.

## Quickstart

```js
import {
  createVelarumPayClient,
  validatePaymentRequest
} from "@velarumpay/sdk-js";

const client = createVelarumPayClient({
  baseUrl: "http://127.0.0.1:8787"
});

const pairing = await client.createPairingSession({
  agent: {
    agent_id: "agt_local_123",
    agent_name: "Hermes on Alice MacBook",
    runtime: "hermes",
    device_label: "Alice MacBook"
  },
  requested_scopes: [
    "payment.requests.create",
    "payment.requests.read",
    "transaction_contexts.create",
    "transaction_contexts.read"
  ],
  expires_in_seconds: 300
});

// After the wallet approves pairing, inject the returned connection token.
client.setConnectionToken("conn_tok_...");

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

The SDK keeps API errors structured. A failed call returns `ok: false` with `error.code`, `error.field` when available, and `error.severity`.

## Scope

- Pairing session create.
- Transaction Context create.
- Payment Request create.
- Payment Request detail read.
- Payment Request event polling.
- Protocol validation helpers from `packages/protocol`.

This SDK does not store private keys, seed phrases, signing material, or automatic payment authority.

Quickstart fixtures live in `/Users/yang/code/VelarumPayCode/examples/payment-request-quickstart`. Formal protocol explanations live in the document workspace:

- `/Users/yang/code/VelarumPay/Chinese/Architecture/velarumpay-platform-api-v0-1-engineering-contract-平台APIv0.1工程契约-2026-06-16.md`
- `/Users/yang/code/VelarumPay/Chinese/Architecture/velarumpay-payment-request-v1-engineering-spec-PaymentRequestv1工程规格-2026-06-16.md`

## Check

```bash
cd /Users/yang/code/VelarumPayCode/packages/sdk-js
npm run check
```
