import { hmacHex, sha256Hex, verifyHmac } from "./crypto.js";
import { addDecimalStrings, compareDecimalStrings, decimalString, normalizeDecimalString } from "./decimal.js";
import {
  createTransactionContextSnapshot as createProtocolTransactionContextSnapshot,
  normalizePaymentRequestV1 as normalizeProtocolPaymentRequestV1,
  normalizeTransactionContextV1 as normalizeProtocolTransactionContextV1
} from "../../../packages/protocol/src/index.js";

export function normalizePaymentRequestV1(payload, options = {}) {
  const result = normalizeProtocolPaymentRequestV1(payload, options);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      errors: result.errors || [result.error],
      warnings: result.warnings || []
    };
  }

  const request = result.value;
  const fee = request.payment.estimated_fee || request.payment.fee || null;
  const total = decimalString(request.payment.total)
    ? request.payment.total
    : decimalString(fee)
      ? addDecimalStrings(request.payment.amount, fee)
      : request.payment.amount;
  return {
    ok: true,
    value: {
      ...request,
      payment_facts: {
        amount: request.payment.amount,
        token: request.payment.asset,
        network: request.payment.network,
        recipient: request.payment.to,
        fee,
        total,
        payee: request.payee
      }
    },
    warnings: result.warnings || []
  };
}

export function normalizeTransactionContextV1(payload, options = {}) {
  const result = normalizeProtocolTransactionContextV1(payload, options);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      errors: result.errors || [result.error],
      warnings: result.warnings || []
    };
  }
  return {
    ok: true,
    value: result.value,
    warnings: result.warnings || []
  };
}

export function createTransactionContextSnapshot(context, options = {}) {
  const result = createProtocolTransactionContextSnapshot(context, options);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      errors: result.errors || [result.error],
      warnings: result.warnings || []
    };
  }
  return {
    ok: true,
    value: result.value,
    warnings: result.warnings || []
  };
}

export function adaptPaytobe(paymentIntent, env = process.env) {
  const Paytobe = paymentIntent.Paytobe || {};
  if (!Paytobe.request_id) {
    paymentIntent.Paytobe = {
      request_id: "",
      payload_hash: "",
      signature: "",
      verified: false
    };
    return { ok: true, warnings: ["No Paytobe payload attached"] };
  }

  const payload = Paytobe.payload || null;
  // M2: sign and verify over a STABLE serialization (recursively sorted keys).
  // Plain JSON.stringify is key-order dependent, so the signer and verifier
  // could hash byte-different strings for the same logical payload and disagree.
  const canonical = payload
    ? stableStringify(payload)
    : `${Paytobe.request_id}:${paymentIntent.payment?.amount || ""}:${paymentIntent.payment?.to || ""}`;
  const payloadHash = `sha256:${sha256Hex(canonical)}`;
  const secret = env.Paytobe_SHARED_SECRET || "";
  const signature = Paytobe.signature || "";

  // M2: the "what you sign vs what the user sees" consistency check must run for
  // ANY attached payload. It used to be gated on `payload.asset`, so a caller
  // could simply omit `asset` and skip every check below — signing a payload
  // whose network/amount/recipient differ from the displayed payment intent.
  if (payload) {
    const asset = payload.asset || {};
    const payment = paymentIntent.payment || {};
    if (asset.network && payment.network && asset.network !== payment.network) {
      return { ok: false, error: "Paytobe network does not match payment intent" };
    }
    if (asset.symbol && payment.asset && asset.symbol.toUpperCase() !== payment.asset.toUpperCase()) {
      return { ok: false, error: "Paytobe asset does not match payment intent" };
    }
    // M2: compare amounts by VALUE, not by string. "24.0" and "24.00" are the
    // same amount; the old exact string compare wrongly treated them as a
    // mismatch (and, worse, accepted a mismatch the signer could engineer).
    if (payload.amount != null && payment.amount != null && !amountsEqual(payload.amount, payment.amount)) {
      return { ok: false, error: "Paytobe amount does not match payment intent" };
    }
    if (payload.recipient?.address && payment.to && payload.recipient.address !== payment.to) {
      return { ok: false, error: "Paytobe recipient does not match payment intent" };
    }
  }

  if (secret && signature && !verifyHmac(secret, canonical, signature)) {
    return { ok: false, error: "Paytobe signature is invalid" };
  }

  paymentIntent.Paytobe = {
    ...Paytobe,
    payload_hash: payloadHash,
    verified: Boolean(secret && signature),
    expected_signature: secret && !signature ? `sha256=${hmacHex(secret, canonical)}` : undefined
  };
  return { ok: true, warnings: paymentIntent.Paytobe.verified ? [] : ["Paytobe signature was not verified"] };
}

// True when two amounts denote the same value. Decimal strings/numbers are
// compared exactly in BigInt minor units (so "24.0" === "24.00"); anything that
// is not a clean non-negative decimal falls back to strict equality.
function amountsEqual(left, right) {
  const a = normalizeDecimalString(left);
  const b = normalizeDecimalString(right);
  if (a !== null && b !== null) return compareDecimalStrings(a, b) === 0;
  return String(left) === String(right);
}

// Deterministic JSON: object keys are sorted recursively so the same logical
// value always serializes to the same bytes regardless of insertion order.
function stableStringify(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
