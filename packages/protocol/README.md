# Protocol Package

Shared protocol constants, validators, and fixtures for VelarumPay v0.1.

## Exports

- `normalizePaymentRequestV1(payload, options)` for `velarum.payment_request.v1`.
- `normalizeTransactionContextV1(payload, options)` for `velarum.transaction_context.v1`.
- `createTransactionContextSnapshot(context, options)` for immutable review snapshots.
- enums for rails, statuses, truth source types, verification statuses, risk severities, and pairing scopes.
- fixtures for valid, missing context, mismatch, AI-only, expired, Base USDC, and Stellar XLM cases.

## Constraints

- Payment facts come from `payment`, not `display` or `metadata`.
- Base USDC uses `base_mainnet`, chain id `8453`, the canonical USDC contract, and `decimals = 6`.
- Stellar XLM uses `stellar_public` or `stellar_testnet` and a Stellar `G...` public key.
- `evm_erc20` is accepted only as a migration alias and normalizes to `base_usdc`.
- Validators do not sign, store keys, or create automatic payment paths.

Formal specs live in the document workspace:

- `/Users/yang/code/VelarumPay/Chinese/Architecture/velarumpay-payment-request-v1-engineering-spec-PaymentRequestv1工程规格-2026-06-16.md`
- `/Users/yang/code/VelarumPay/Chinese/Architecture/velarumpay-transaction-context-v1-engineering-spec-TransactionContextv1工程规格-2026-06-16.md`
- `/Users/yang/code/VelarumPay/Chinese/Architecture/velarumpay-transaction-truth-layer-v1-engineering-spec-事务事实层v1工程规格-2026-06-16.md`

## Check

```bash
npm run check
npm test
```
