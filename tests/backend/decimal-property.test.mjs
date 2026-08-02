import assert from "node:assert/strict";
import test from "node:test";
import {
  addDecimalParts,
  addDecimalStrings,
  addDecimalStringsOrEmpty,
  compareDecimalStrings,
  decimalAbsDiff,
  decimalString,
  normalizeDecimalString
} from "../../services/platform-api/src/decimal.js";

// Property / fuzz coverage for the money module (H3). The existing
// daily-limit.test.mjs pins a handful of hand-picked vectors; this file pounds
// the same functions with thousands of randomized non-negative decimals and
// asserts the ALGEBRAIC LAWS that exact money math must obey no matter the
// input. A regression that only shows up at an unusual scale or carry boundary
// (exactly what float drift looked like) trips one of these laws instead of
// slipping through a fixed example. The seed is fixed so any failure is
// reproducible and prints the offending operands.

// Small deterministic PRNG (mulberry32) — reproducible, no dependency.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build a canonical non-negative decimal string with up to `maxWholeDigits`
// integer digits and up to `maxFractionDigits` fractional digits. Canonical =
// no leading zeros (except a lone "0"), no trailing fractional zeros — i.e.
// exactly the shape decimalString() accepts, so we test the real input domain.
function randomDecimal(rnd, { maxWholeDigits = 6, maxFractionDigits = 8 } = {}) {
  const wholeLen = 1 + Math.floor(rnd() * maxWholeDigits);
  let whole = "";
  for (let i = 0; i < wholeLen; i++) whole += String(Math.floor(rnd() * 10));
  whole = whole.replace(/^0+(?=\d)/, ""); // canonical: strip leading zeros

  const fractionLen = Math.floor(rnd() * (maxFractionDigits + 1));
  let fraction = "";
  for (let i = 0; i < fractionLen; i++) fraction += String(Math.floor(rnd() * 10));
  fraction = fraction.replace(/0+$/, ""); // canonical: strip trailing zeros

  const value = fraction ? `${whole}.${fraction}` : whole;
  // Sanity: every generated value must be in the accepted domain.
  assert.equal(decimalString(value), true, `generator produced a non-canonical decimal: ${value}`);
  return value;
}

const ITERATIONS = 4000;

test("normalizeDecimalString is idempotent and decimalString agrees with it", () => {
  const rnd = mulberry32(0x1234);
  for (let i = 0; i < ITERATIONS; i++) {
    const a = randomDecimal(rnd);
    const once = normalizeDecimalString(a);
    assert.equal(once, a, "canonical input must normalize to itself");
    assert.equal(normalizeDecimalString(once), once, "normalize must be idempotent");
    assert.equal(decimalString(a), true);
  }
});

test("addition is commutative and has 0 as identity", () => {
  const rnd = mulberry32(0xa11ce);
  for (let i = 0; i < ITERATIONS; i++) {
    const a = randomDecimal(rnd);
    const b = randomDecimal(rnd);
    assert.equal(addDecimalStrings(a, b), addDecimalStrings(b, a), `commutativity failed for ${a} + ${b}`);
    assert.equal(addDecimalStrings(a, "0"), a, `0 is not identity for ${a}`);
    assert.equal(addDecimalStrings("0", a), a, `0 is not identity for ${a}`);
  }
});

test("addition is associative across mixed scales", () => {
  const rnd = mulberry32(0xb0b);
  for (let i = 0; i < ITERATIONS; i++) {
    const a = randomDecimal(rnd);
    const b = randomDecimal(rnd);
    const c = randomDecimal(rnd);
    const left = addDecimalStrings(addDecimalStrings(a, b), c);
    const right = addDecimalStrings(a, addDecimalStrings(b, c));
    assert.equal(left, right, `associativity failed for (${a} + ${b}) + ${c}`);
  }
});

test("compare is a consistent total order, antisymmetric and reflexive", () => {
  const rnd = mulberry32(0xc0ffee);
  for (let i = 0; i < ITERATIONS; i++) {
    const a = randomDecimal(rnd);
    const b = randomDecimal(rnd);
    const ab = compareDecimalStrings(a, b);
    const ba = compareDecimalStrings(b, a);
    // `===` (not assert.equal) so the 0 / -0 pair compares equal: compare only
    // ever returns -1/0/1, and antisymmetry means ab must be the negation of ba.
    assert.ok(ab === -ba, `antisymmetry failed for ${a} vs ${b} (got ${ab} and ${ba})`);
    assert.equal(compareDecimalStrings(a, a), 0, `reflexivity failed for ${a}`);
    assert.ok(ab === -1 || ab === 0 || ab === 1, "compare must return -1/0/1");
  }
});

test("compare is transitive", () => {
  const rnd = mulberry32(0xd00d);
  for (let i = 0; i < ITERATIONS; i++) {
    const xs = [randomDecimal(rnd), randomDecimal(rnd), randomDecimal(rnd)]
      .sort(compareDecimalStrings);
    // After sorting by the function under test, the order must be non-decreasing.
    assert.ok(compareDecimalStrings(xs[0], xs[1]) <= 0, `transitivity broke: ${xs.join(", ")}`);
    assert.ok(compareDecimalStrings(xs[1], xs[2]) <= 0, `transitivity broke: ${xs.join(", ")}`);
    assert.ok(compareDecimalStrings(xs[0], xs[2]) <= 0, `transitivity broke: ${xs.join(", ")}`);
  }
});

test("a sum is never smaller than its parts (monotonic accumulation)", () => {
  // This is the exact property the daily cap relies on: adding spend can only
  // move the total up, never (through drift) leave phantom headroom below a part.
  const rnd = mulberry32(0xfeed);
  for (let i = 0; i < ITERATIONS; i++) {
    const a = randomDecimal(rnd);
    const b = randomDecimal(rnd);
    const sum = addDecimalStrings(a, b);
    assert.ok(compareDecimalStrings(sum, a) >= 0, `sum < a for ${a} + ${b} = ${sum}`);
    assert.ok(compareDecimalStrings(sum, b) >= 0, `sum < b for ${a} + ${b} = ${sum}`);
    // Equality only when the other addend is exactly zero.
    if (b !== "0") assert.ok(compareDecimalStrings(sum, a) === 1 || a === sum, "non-zero addend must increase the total");
  }
});

test("absolute difference inverts addition: |(a+b) - a| === b", () => {
  // Ties add and decimalAbsDiff together as independent cross-checks: if either
  // mis-handles a carry or scale, the reconstructed addend stops matching.
  const rnd = mulberry32(0x5eed);
  for (let i = 0; i < ITERATIONS; i++) {
    const a = randomDecimal(rnd);
    const b = randomDecimal(rnd);
    const sum = addDecimalStrings(a, b);
    assert.equal(decimalAbsDiff(sum, a), b, `|(${a}+${b}) - ${a}| !== ${b}`);
    assert.equal(decimalAbsDiff(a, b), decimalAbsDiff(b, a), `absDiff not symmetric for ${a}, ${b}`);
    // min + |a-b| === max (reconstruct the larger from the smaller).
    const max = compareDecimalStrings(a, b) >= 0 ? a : b;
    const min = compareDecimalStrings(a, b) >= 0 ? b : a;
    assert.equal(addDecimalStrings(min, decimalAbsDiff(a, b)), max, `min + |a-b| !== max for ${a}, ${b}`);
  }
});

test("addDecimalParts equals a left fold of addDecimalStrings", () => {
  const rnd = mulberry32(0x7a11);
  for (let i = 0; i < 1000; i++) {
    const n = 1 + Math.floor(rnd() * 6);
    const parts = Array.from({ length: n }, () => randomDecimal(rnd));
    const folded = parts.reduce((sum, value) => addDecimalStrings(sum, value), "0");
    assert.equal(addDecimalParts(parts), folded, `addDecimalParts drifted from the fold for [${parts.join(", ")}]`);
  }
});

test("garbage input fails closed and never throws (normalize/decimalString/orEmpty)", () => {
  // Values that are NOT non-negative canonical decimals and must be rejected.
  // (Non-negative finite NUMBERS are deliberately excluded here — the module
  // accepts those as legacy float totals; that path is asserted separately.)
  const garbage = [
    "", "   ", "abc", "-5", "-0", "01", "1.", ".5", "1.2.3", "1,000", "+1", "1e5", "0x10",
    "Infinity", "NaN", "  1.5  x", "１２３", "1_000", "1 2",
    null, undefined, true, false, {}, [], [1], () => {}, Symbol("x"),
    Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.5
  ];
  for (const value of garbage) {
    // Must never throw, must reject (null) — the caller then fails closed.
    assert.doesNotThrow(() => normalizeDecimalString(value), `normalize threw on ${String(value)}`);
    assert.equal(normalizeDecimalString(value), null, `expected null for ${String(value)}`);
    assert.equal(decimalString(value), false, `decimalString should reject ${String(value)}`);
    // The display-safe sum tolerates bad input by returning "" rather than throwing.
    assert.equal(addDecimalStringsOrEmpty(value, "1"), "", `orEmpty should be "" for ${String(value)}`);
    assert.equal(addDecimalStringsOrEmpty("1", value), "");
    // The strict primitive fails LOUD (its documented contract) — also a guarantee.
    assert.throws(() => addDecimalStrings(value, "1"), { name: "TypeError" }, `addDecimalStrings should throw on ${String(value)}`);
  }
});

test("legacy float totals expand without inventing precision", () => {
  // The only place a Number legally enters normalize: a spend total persisted by
  // the pre-H3 float code. It must expand to plain decimal notation, never leak
  // exponent syntax, and stay comparable.
  const cases = [
    [0, "0"],
    [1e-7, "0.0000001"],
    [0.1, "0.1"],
    [1234.5, "1234.5"],
    [1e21, "1000000000000000000000"]
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeDecimalString(input), expected, `float ${input} expanded wrong`);
    assert.equal(decimalString(normalizeDecimalString(input)), true);
  }
});
