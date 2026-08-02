// Exact, non-negative decimal arithmetic for money amounts.
//
// H3 regression fix: payment amounts and the daily spend cap are decimal
// strings (validated against DECIMAL_STRING, e.g. "0.1", "24.00", "1000").
// Accumulating or comparing them with float64 `Number`s silently drifts
// (0.1 + 0.2 === 0.30000000000000004), which made the daily limit both
// inaccurate AND bypassable: after enough small payments the stored total
// undershoots the true sum, leaving phantom headroom under the cap.
//
// Every operation here stays in BigInt minor units, so totals are exact no
// matter how many payments accumulate over a day.

// DECIMAL_STRING lives in the protocol package so the validator and this money
// arithmetic share ONE canonical pattern that cannot drift (F4).
import { DECIMAL_STRING } from "../../../packages/protocol/src/decimal-format.js";

// True only for an already-canonical, non-negative decimal string. Kept
// strict (no trimming) so existing risk.js call sites behave identically.
export function decimalString(value) {
  return typeof value === "string" && DECIMAL_STRING.test(value);
}

// Coerce string|number input into a canonical non-negative decimal string,
// or null when it cannot be represented as one.
//   - Strings are taken exactly (after trimming surrounding whitespace).
//   - Numbers only appear here as legacy persisted spend totals written by
//     the old float code; they are expanded without inventing new digits.
export function normalizeDecimalString(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return DECIMAL_STRING.test(trimmed) ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    const expanded = expandExponential(String(value));
    return DECIMAL_STRING.test(expanded) ? expanded : null;
  }
  return null;
}

// Exact sum of two decimal values, returned as a canonical decimal string.
// Throws on input that is not a non-negative decimal — callers must pass
// validated amounts (this is a fail-loud guard against contract violations).
export function addDecimalStrings(a, b) {
  const left = normalizeDecimalString(a);
  const right = normalizeDecimalString(b);
  if (left === null || right === null) {
    throw new TypeError(`addDecimalStrings expects non-negative decimal values (received ${a} and ${b})`);
  }
  const scale = Math.max(decimalScale(left), decimalScale(right));
  return decimalUnitsToString(decimalUnits(left, scale) + decimalUnits(right, scale), scale);
}

// Best-effort sum for display projections: returns the exact decimal sum when
// BOTH inputs are already canonical decimal strings, or "" otherwise. Unlike
// addDecimalStrings this never throws, so it is safe on partially-populated
// payment facts. (Moved here from server.js so all money math lives in one
// module — it was a thin guard around addDecimalStrings, not a second impl.)
export function addDecimalStringsOrEmpty(left, right) {
  if (!decimalString(left) || !decimalString(right)) return "";
  return addDecimalStrings(left, right);
}

// -1 / 0 / 1 for left < / === / > right, compared exactly.
export function compareDecimalStrings(left, right) {
  const [leftUnits, rightUnits] = scaledDecimalPair(left, right);
  if (leftUnits === rightUnits) return 0;
  return leftUnits > rightUnits ? 1 : -1;
}

// Absolute difference |left - right| as a canonical decimal string.
export function decimalAbsDiff(left, right) {
  const [leftUnits, rightUnits, scale] = scaledDecimalPair(left, right);
  const diff = leftUnits > rightUnits ? leftUnits - rightUnits : rightUnits - leftUnits;
  return decimalUnitsToString(diff, scale);
}

// Exact sum of a list of decimal parts, ignoring any non-decimal entries.
// Returns "" when no part is a decimal string.
export function addDecimalParts(parts) {
  const values = parts.filter(decimalString);
  if (!values.length) return "";
  const scale = values.reduce((max, value) => Math.max(max, decimalScale(value)), 0);
  const total = values.reduce((sum, value) => sum + decimalUnits(value, scale), 0n);
  return decimalUnitsToString(total, scale);
}

function scaledDecimalPair(left, right) {
  const scale = Math.max(decimalScale(left), decimalScale(right));
  return [decimalUnits(left, scale), decimalUnits(right, scale), scale];
}

function decimalScale(value) {
  return String(value).split(".")[1]?.length || 0;
}

function decimalUnits(value, scale) {
  const [whole, fraction = ""] = String(value).split(".");
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0") || "0");
}

function decimalUnitsToString(units, scale) {
  if (scale === 0) return String(units);
  const divisor = 10n ** BigInt(scale);
  const whole = units / divisor;
  const fraction = String(units % divisor).padStart(scale, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

// Rewrite a JS number's string form ("1e-7", "1.5e+21") into plain decimal
// notation, then canonicalize. Non-exponential input is returned unchanged.
function expandExponential(str) {
  const match = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(str);
  if (!match) return str;
  const integer = match[1];
  const fraction = match[2] || "";
  const exponent = Number(match[3]);
  const digits = integer + fraction;
  const pointIndex = integer.length + exponent;
  let result;
  if (pointIndex <= 0) {
    result = `0.${"0".repeat(-pointIndex)}${digits}`;
  } else if (pointIndex >= digits.length) {
    result = digits + "0".repeat(pointIndex - digits.length);
  } else {
    result = `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
  }
  return canonicalizeDecimal(result);
}

function canonicalizeDecimal(value) {
  let [whole, fraction = ""] = value.split(".");
  whole = whole.replace(/^0+(?=\d)/, "");
  fraction = fraction.replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
