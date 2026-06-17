# Generic Payment Request Example

This example will show the smallest possible local-agent flow:

1. Create a `velarum.payment_request.v1` payload.
2. Send it to the platform API.
3. Receive it in VelarumPay.
4. Approve, sign, and broadcast from the wallet.

For copyable JSON payloads and a no-private-key smoke check, use:

```bash
node examples/payment-request-quickstart/smoke-check.mjs
```
