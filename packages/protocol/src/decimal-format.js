// The canonical money-amount format, shared by the protocol validators and the
// services-side exact-decimal arithmetic (services/platform-api/src/decimal.js
// imports it) so the one pattern can never drift between layers (F4). It lives in
// the protocol package because that is the lowest layer both sides already depend
// on; the openclaw-telegram connector keeps its own copy on purpose (it ships as a
// self-contained skill with no workspace dependency — see its Paytobe_adapter.js).

// A canonical, non-negative base-10 amount: no sign, no leading zeros (except a
// bare "0"), optional fractional part. e.g. "0", "0.1", "24.00", "1000".
export const DECIMAL_STRING = /^(0|[1-9]\d*)(\.\d+)?$/;

// True for a canonical non-negative decimal string.
export function isDecimalString(value) {
  return typeof value === "string" && DECIMAL_STRING.test(value);
}

// True only for a STRICTLY POSITIVE canonical decimal string. Pure string test: a
// canonical non-negative amount is zero iff it contains no non-zero digit, so
// "has a 1-9 digit" === "> 0". Never coerces through float64 Number(), which would
// underflow a very long fractional like "0.0000…1" to 0 and wrongly reject it (F3).
export function isPositiveDecimalString(value) {
  return isDecimalString(value) && /[1-9]/.test(value);
}
