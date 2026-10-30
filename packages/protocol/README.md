# Protocol Package

> **Last modified / 最后修改时间**
> - **Taipei Time / 台北时间:** 2026-10-29 13:41:42 Asia/Taipei (UTC+08:00)
> - **UTC / 协调世界时:** 2026-10-29 05:41:42 UTC


Shared protocol constants, validators, and fixtures for Paytobe v0.1.

## Machine-readable contracts

- `schema/Paytobe.payment_request.v1.schema.json` is the JSON Schema for `Paytobe.payment_request.v1`.
- `schema/Paytobe.transaction_context.v1.schema.json` is the JSON Schema for `Paytobe.transaction_context.v1`.
- `services/platform-api/openapi/Paytobe-platform-api-v0.1.openapi.json` in the code repository describes the canonical HTTP API and references both packaged schemas.

`tests/protocol/documentation-contract.test.mjs` compares schema/OpenAPI enums and references with runtime constants. Update constants, schemas, OpenAPI, fixtures, types, tests, and documentation in the same change.

## Exports

- `normalizePaymentRequestV1(payload, options)` for `Paytobe.payment_request.v1`.
- `normalizeTransactionContextV1(payload, options)` for `Paytobe.transaction_context.v1`.
- `createTransactionContextSnapshot(context, options)` for immutable review snapshots.
- enums for rails, statuses, truth source types, verification statuses, risk severities, and pairing scopes.
- fixtures for valid, missing context, mismatch, AI-only, expired, Base USDC, and Stellar XLM cases.

## Package

Package name: `@Paytobe/protocol`
Version: `0.1.0`  
Entry point: `./src/index.js`  
Types: `./src/index.d.ts`

Dry-run the release tarball:

```bash
cd packages/protocol
npm run pack:dry
```

## Constraints

- Payment facts come from `payment`, not `display` or `metadata`.
- Base USDC uses `base_mainnet`, chain id `8453`, the canonical USDC contract, and `decimals = 6`.
- Stellar XLM uses `stellar_public` or `stellar_testnet` and a Stellar `G...` public key.
- `evm_erc20` is accepted only as a migration alias and normalizes to `base_usdc`.
- Validators do not sign, store keys, or create automatic payment paths.
- A transfer asset registry entry is not a release-support claim; build, signing, broadcast, and platform/device evidence are tracked separately.

Public contract sources:

- `schema/Paytobe.payment_request.v1.schema.json`
- `schema/Paytobe.transaction_context.v1.schema.json`
- `services/platform-api/openapi/Paytobe-platform-api-v0.1.openapi.json`

## Check

```bash
npm run check
npm test
```
