# Generic Payment Request Example

> **Last modified**
> - **Taipei Time:** 2026-08-02 02:05:41 Asia/Taipei (UTC+08:00)
> - **UTC:** 2026-08-01 18:05:41 UTC

This example will show the smallest possible local-agent flow:

1. Create a `velarum.payment_request.v1` payload.
2. Send it to the platform API.
3. Receive it in VelarumPay.
4. Approve, sign, and broadcast from the wallet.

Run the complete merchant onboarding order against deterministic offline mocks:

```bash
node examples/generic-payment-request/merchant-quickstart.mjs
```

The mock covers account and session grants, domain verification, versioned Recipient activation, public Agent credential proof, local Assertion exchange, Connect, and a Payment Request that remains subject to wallet approval. It performs no network requests and contains no production credentials.

For copyable JSON payloads and a no-private-key smoke check, use:

```bash
node examples/payment-request-quickstart/smoke-check.mjs
```

For command-by-command local quickstart, use:

```bash
node examples/payment-request-quickstart/cli.mjs help
```
