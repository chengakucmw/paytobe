# Hermes Connector

Local Hermes adapter for VelarumPay Payment Request v1. It lets a Hermes local
agent create a pairing session, create a Transaction Context, create a Payment
Request, and read request status through polling or the agent WebSocket URL.

It does not hold wallet private keys, seed phrases, signing keys, automatic
payment authority, webhook callbacks, or wallet status-update permission.

Package name: `@velarumpay/hermes-connector`  
Version: `0.1.0`  
Entry point: `./src/index.js`  
Types: `./src/index.d.ts`  
Runtime dependency: `@velarumpay/sdk-js@0.1.0`

## Scopes

Hermes requests only these v0.1 scopes:

- `payment.requests.create`
- `payment.requests.read`
- `transaction_contexts.create`
- `transaction_contexts.read`

`wallet.sign`, automatic approval, webhook delivery, and wallet status updates
are not exposed by this connector. The wallet still reviews and signs locally.

## Usage

```js
import { createHermesPaymentRequestAdapter } from "@velarumpay/hermes-connector";
import fixture from "./fixtures/stellar-xlm-payment-request.json" with { type: "json" };

const hermes = createHermesPaymentRequestAdapter({
  baseUrl: "http://127.0.0.1:8787",
  connectionToken: "conn_tok_..."
});

const pairing = await hermes.createPairingSession();

// After the wallet approves pairing and returns a connection token:
const created = await hermes.createStandardPaymentRequest(fixture);
const status = await hermes.getPaymentStatus(created.request_id);
const events = await hermes.pollStatusEvents({ since: 0 });
const wsUrl = hermes.agentWebSocketUrl();
```

For local dev, `fixture.target_app_device_id` can be supplied to route a request
to a registered test wallet device. Production integrations should rely on the
approved connection and Platform API routing rules.

## Fixtures

- `fixtures/stellar-xlm-payment-request.json`
- `fixtures/base-usdc-payment-request.json`

Both fixtures include a `velarum.transaction_context.v1` object and a paired
`velarum.payment_request.v1` object with the same `transaction_id`. The Stellar
fixture uses testnet. The Base USDC fixture uses canonical Base USDC identifiers
for validation and local status-loop testing; creating the request does not
require mainnet funds.

## Check

```bash
cd /Users/yang/code/VelarumPayCode/connectors/hermes
npm run check
npm run pack:dry
```

Formal protocol and API references live in the document workspace:

- `/Users/yang/code/VelarumPay/Chinese/Architecture/velarumpay-platform-api-v0-1-engineering-contract-平台APIv0.1工程契约-2026-06-16.md`
- `/Users/yang/code/VelarumPay/Chinese/Architecture/velarumpay-payment-request-v1-engineering-spec-PaymentRequestv1工程规格-2026-06-16.md`
