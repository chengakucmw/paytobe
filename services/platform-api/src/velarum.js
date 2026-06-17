import { hmacHex, sha256Hex, verifyHmac } from "./crypto.js";
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

export function adaptVelarum(paymentIntent, env = process.env) {
  const velarum = paymentIntent.velarum || {};
  if (!velarum.request_id) {
    paymentIntent.velarum = {
      request_id: "",
      payload_hash: "",
      signature: "",
      verified: false
    };
    return { ok: true, warnings: ["No Velarum payload attached"] };
  }

  const payload = velarum.payload || null;
  const canonical = payload ? JSON.stringify(payload) : `${velarum.request_id}:${paymentIntent.payment?.amount || ""}:${paymentIntent.payment?.to || ""}`;
  const payloadHash = `sha256:${sha256Hex(canonical)}`;
  const secret = env.VELARUM_SHARED_SECRET || "";
  const signature = velarum.signature || "";

  if (payload && payload.asset) {
    const asset = payload.asset;
    const payment = paymentIntent.payment || {};
    if (asset.network && payment.network && asset.network !== payment.network) {
      return { ok: false, error: "Velarum network does not match payment intent" };
    }
    if (asset.symbol && payment.asset && asset.symbol.toUpperCase() !== payment.asset.toUpperCase()) {
      return { ok: false, error: "Velarum asset does not match payment intent" };
    }
    if (payload.amount && payment.amount && payload.amount !== payment.amount) {
      return { ok: false, error: "Velarum amount does not match payment intent" };
    }
    if (payload.recipient?.address && payment.to && payload.recipient.address !== payment.to) {
      return { ok: false, error: "Velarum recipient does not match payment intent" };
    }
  }

  if (secret && signature && !verifyHmac(secret, canonical, signature)) {
    return { ok: false, error: "Velarum signature is invalid" };
  }

  paymentIntent.velarum = {
    ...velarum,
    payload_hash: payloadHash,
    verified: Boolean(secret && signature),
    expected_signature: secret && !signature ? `sha256=${hmacHex(secret, canonical)}` : undefined
  };
  return { ok: true, warnings: paymentIntent.velarum.verified ? [] : ["Velarum signature was not verified"] };
}

function decimalString(value) {
  return typeof value === "string" && /^(0|[1-9]\d*)(\.\d+)?$/.test(value);
}

function addDecimalStrings(left, right) {
  const [leftWhole, leftFraction = ""] = String(left).split(".");
  const [rightWhole, rightFraction = ""] = String(right).split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftUnits = BigInt(leftWhole) * 10n ** BigInt(scale) + BigInt(leftFraction.padEnd(scale, "0") || "0");
  const rightUnits = BigInt(rightWhole) * 10n ** BigInt(scale) + BigInt(rightFraction.padEnd(scale, "0") || "0");
  const sum = leftUnits + rightUnits;
  const whole = sum / (10n ** BigInt(scale));
  const fraction = String(sum % (10n ** BigInt(scale))).padStart(scale, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
