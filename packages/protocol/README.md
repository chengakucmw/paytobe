# Protocol Package

> **Last modified / 最后修改时间**
> - **Taipei Time / 台北时间:** 2026-07-21 21:50:07 Asia/Taipei (UTC+08:00)
> - **UTC / 协调世界时:** 2026-07-21 13:50:07 UTC


Shared protocol constants, validators, and fixtures for VelarumPay v0.1.

## Machine-readable contracts

- `schema/velarum.payment_request.v1.schema.json` is the JSON Schema for `velarum.payment_request.v1`.
- `schema/velarum.transaction_context.v1.schema.json` is the JSON Schema for `velarum.transaction_context.v1`.
- `services/platform-api/openapi/velarumpay-platform-api-v0.1.openapi.json` in the code repository describes the canonical HTTP API and references both packaged schemas.

`tests/protocol/documentation-contract.test.mjs` compares schema/OpenAPI enums and references with runtime constants. Update constants, schemas, OpenAPI, fixtures, types, tests, and documentation in the same change.

## Exports

- `normalizePaymentRequestV1(payload, options)` for `velarum.payment_request.v1`.
- `normalizeTransactionContextV1(payload, options)` for `velarum.transaction_context.v1`.
- `createTransactionContextSnapshot(context, options)` for immutable review snapshots.
- enums for rails, statuses, truth source types, verification statuses, risk severities, and pairing scopes.
- fixtures for valid, missing context, mismatch, AI-only, expired, Base USDC, and Stellar XLM cases.

## Package

Package name: `@velarumpay/protocol`  
Version: `0.1.0`  
Entry point: `./src/index.js`  
Types: `./src/index.d.ts`

Dry-run the release tarball:

```bash
cd /Users/yang/code/VelarumPay/code/packages/protocol
npm run pack:dry
```

## Constraints

- Payment facts come from `payment`, not `display` or `metadata`.
- Base USDC uses `base_mainnet`, chain id `8453`, the canonical USDC contract, and `decimals = 6`.
- Stellar XLM uses `stellar_public` or `stellar_testnet` and a Stellar `G...` public key.
- `evm_erc20` is accepted only as a migration alias and normalizes to `base_usdc`.
- Validators do not sign, store keys, or create automatic payment paths.
- A transfer asset registry entry is not a release-support claim; build, signing, broadcast, and platform/device evidence are tracked separately.

Formal specs live in the document workspace:

- `/Users/yang/code/VelarumPay/docs/Chinese/Architecture/00056-00003-00012-1-velarumpay-payment-request-v1-engineering-spec-PaymentRequestv1工程规格-2026-06-16.md`
- `/Users/yang/code/VelarumPay/docs/Chinese/Architecture/00056-00003-00016-1-velarumpay-transaction-context-v1-engineering-spec-TransactionContextv1工程规格-2026-06-16.md`
- `/Users/yang/code/VelarumPay/docs/Chinese/Architecture/00056-00003-00017-1-velarumpay-transaction-truth-layer-v1-engineering-spec-事务事实层v1工程规格-2026-06-16.md`

## Check

```bash
npm run check
npm test
```
