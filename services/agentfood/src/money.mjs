const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

export function normalizeDecimal(value) {
  const text = String(value ?? "").trim();
  return DECIMAL.test(text) ? text : null;
}

export function compareDecimal(left, right) {
  const a = normalizeDecimal(left);
  const b = normalizeDecimal(right);
  if (a === null || b === null) throw new TypeError("Decimal comparison requires non-negative decimal strings");
  const scale = Math.max(decimalScale(a), decimalScale(b));
  const leftUnits = decimalUnits(a, scale);
  const rightUnits = decimalUnits(b, scale);
  return leftUnits === rightUnits ? 0 : leftUnits > rightUnits ? 1 : -1;
}

export function addDecimal(left, right) {
  const a = normalizeDecimal(left);
  const b = normalizeDecimal(right);
  if (a === null || b === null) throw new TypeError("Decimal addition requires non-negative decimal strings");
  const scale = Math.max(decimalScale(a), decimalScale(b));
  return unitsToDecimal(decimalUnits(a, scale) + decimalUnits(b, scale), scale);
}

export function multiplyDecimal(value, quantity) {
  const amount = normalizeDecimal(value);
  if (amount === null || !Number.isSafeInteger(quantity) || quantity < 0) {
    throw new TypeError("Decimal multiplication requires a decimal and a non-negative integer");
  }
  const scale = decimalScale(amount);
  return unitsToDecimal(decimalUnits(amount, scale) * BigInt(quantity), scale);
}

function decimalScale(value) {
  return String(value).split(".")[1]?.length || 0;
}

function decimalUnits(value, scale) {
  const [whole, fraction = ""] = String(value).split(".");
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0") || "0");
}

function unitsToDecimal(units, scale) {
  if (!scale) return String(units);
  const divisor = 10n ** BigInt(scale);
  const whole = units / divisor;
  const fraction = String(units % divisor).padStart(scale, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
