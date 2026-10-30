import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePaymentRequestV1,
  normalizeTransactionContextV1
} from "../../packages/protocol/src/index.js";
import {
  normalizePaymentRequestV1 as normalizeApiPaymentRequestV1,
  normalizeTransactionContextV1 as normalizeApiTransactionContextV1
} from "../../services/platform-api/src/Paytobe.js";
import {
  paymentRequestFixtures,
  protocolFixtureClock,
  transactionContextFixtures
} from "../../packages/protocol/src/fixtures.js";

// Robustness / fuzz coverage for the protocol validators. protocol.test.mjs pins
// the KNOWN good and bad shapes; this file proves the validators stay FAIL-CLOSED
// under hostile, malformed, and randomly-corrupted input — exactly what a relay
// receives from the open internet. Two guarantees are checked on every input:
//   1. the validator NEVER throws (a thrown error would crash the request handler
//      or, worse, skip a check), and
//   2. it always returns a structured verdict: either a clean ok:true with the
//      hard payment facts intact, or ok:false with a non-empty error.code.
// The seed is fixed so any counterexample is reproducible and printed.

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

const clock = { now: protocolFixtureClock.now };

const JUNK_VALUES = [
  null, undefined, true, false, 0, -1, 1.5, NaN, Infinity, -Infinity,
  "", "   ", "abc", "0x", "<script>", "../../etc/passwd", "\0", "💸",
  "9".repeat(2048), {}, [], [1, 2, 3], { nested: { deep: [{}] } },
  { amount: -1 }, "1e10", "01", "-0", "2026-13-40T99:99:99Z"
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function randomJunk(rnd) {
  return JUNK_VALUES[Math.floor(rnd() * JUNK_VALUES.length)];
}

// Collect dotted paths to every leaf so we can corrupt or delete one at random.
function leafPaths(value, prefix = "", out = []) {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) leafPaths(value[key], prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.push(prefix);
  }
  return out;
}

function setPath(root, path, next) {
  const keys = path.split(".");
  let node = root;
  for (let i = 0; i < keys.length - 1; i++) {
    if (node[keys[i]] === undefined || node[keys[i]] === null || typeof node[keys[i]] !== "object") return false;
    node = node[keys[i]];
  }
  node[keys.at(-1)] = next;
  return true;
}

function deletePath(root, path) {
  const keys = path.split(".");
  let node = root;
  for (let i = 0; i < keys.length - 1; i++) {
    if (node[keys[i]] === undefined || node[keys[i]] === null || typeof node[keys[i]] !== "object") return false;
    node = node[keys[i]];
  }
  if (Array.isArray(node)) return false;
  delete node[keys.at(-1)];
  return true;
}

// Apply 1..4 random corruptions to a deep clone of a valid base fixture.
function mutate(rnd, base) {
  const doc = clone(base);
  const rounds = 1 + Math.floor(rnd() * 4);
  for (let i = 0; i < rounds; i++) {
    const paths = leafPaths(doc);
    if (!paths.length) break;
    const path = paths[Math.floor(rnd() * paths.length)];
    const op = rnd();
    try {
      if (op < 0.45) setPath(doc, path, randomJunk(rnd));
      else if (op < 0.75) deletePath(doc, path);
      else doc[`x_${Math.floor(rnd() * 1000)}`] = randomJunk(rnd); // inject unexpected field
    } catch {
      // A mutation helper must not abort the fuzz run; the validator call is the
      // thing under test, not the mutator.
    }
  }
  return doc;
}

// Build an arbitrary random JSON value of bounded depth (the "total garbage" case).
function randomDoc(rnd, depth = 0) {
  if (depth > 3 || rnd() < 0.3) return randomJunk(rnd);
  if (rnd() < 0.5) {
    const n = Math.floor(rnd() * 4);
    return Array.from({ length: n }, () => randomDoc(rnd, depth + 1));
  }
  const obj = {};
  const n = Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) obj[`k${Math.floor(rnd() * 100)}`] = randomDoc(rnd, depth + 1);
  return obj;
}

function assertStructuredVerdict(label, result, input) {
  const ctx = () => `${label} returned a non-structured verdict for input ${JSON.stringify(input)?.slice(0, 200)}: ${JSON.stringify(result)?.slice(0, 200)}`;
  assert.ok(result && typeof result === "object", ctx());
  assert.equal(typeof result.ok, "boolean", ctx());
  if (result.ok === false) {
    assert.ok(result.error && typeof result.error === "object", ctx());
    assert.equal(typeof result.error.code, "string", ctx());
    assert.ok(result.error.code.length > 0, ctx());
  } else {
    assert.ok(result.value && typeof result.value === "object", ctx());
  }
}

const PR_BASES = [
  paymentRequestFixtures.valid_base_usdc,
  paymentRequestFixtures.valid_stellar_xlm
].filter(Boolean);

const TC_BASES = [
  transactionContextFixtures.valid,
  transactionContextFixtures.missing_context
].filter(Boolean);

test("payment request validators never throw and always return a structured verdict", () => {
  const rnd = mulberry32(0x9001);
  for (let i = 0; i < 3000; i++) {
    const input = rnd() < 0.8 ? mutate(rnd, PR_BASES[i % PR_BASES.length]) : randomDoc(rnd);
    let core;
    let api;
    assert.doesNotThrow(() => { core = normalizePaymentRequestV1(input, clock); }, `protocol PR validator threw on ${JSON.stringify(input)?.slice(0, 200)}`);
    assert.doesNotThrow(() => { api = normalizeApiPaymentRequestV1(input, clock); }, `API PR validator threw on ${JSON.stringify(input)?.slice(0, 200)}`);
    assertStructuredVerdict("protocol payment-request", core, input);
    assertStructuredVerdict("api payment-request", api, input);
    // When the validator accepts, the hard money facts must be well-formed —
    // a malformed input must never normalize into a payable request with a
    // non-string or empty amount/recipient.
    if (core.ok === true) {
      assert.equal(typeof core.value.payment?.amount, "string", "accepted PR has non-string amount");
      assert.ok(core.value.payment.amount.length > 0, "accepted PR has empty amount");
      assert.ok(String(core.value.payment?.to || "").length > 0, "accepted PR has empty recipient");
    }
  }
});

test("transaction context validators never throw and always return a structured verdict", () => {
  const rnd = mulberry32(0x9002);
  for (let i = 0; i < 3000; i++) {
    const input = rnd() < 0.8 ? mutate(rnd, TC_BASES[i % TC_BASES.length]) : randomDoc(rnd);
    let core;
    let api;
    assert.doesNotThrow(() => { core = normalizeTransactionContextV1(input, clock); }, `protocol TC validator threw on ${JSON.stringify(input)?.slice(0, 200)}`);
    assert.doesNotThrow(() => { api = normalizeApiTransactionContextV1(input, clock); }, `API TC validator threw on ${JSON.stringify(input)?.slice(0, 200)}`);
    assertStructuredVerdict("protocol transaction-context", core, input);
    assertStructuredVerdict("api transaction-context", api, input);
    if (core.ok === true) {
      assert.equal(typeof core.value.transaction_id, "string", "accepted TC has non-string transaction_id");
      assert.ok(core.value.transaction_id.length > 0, "accepted TC has empty transaction_id");
    }
  }
});

test("explicit hostile primitives are rejected cleanly (not just random mutations)", () => {
  const hostile = [null, undefined, "", 0, false, [], "not-json", { protocol: "evil" }, 42, NaN];
  for (const input of hostile) {
    for (const [label, fn] of [
      ["protocol PR", normalizePaymentRequestV1],
      ["api PR", normalizeApiPaymentRequestV1],
      ["protocol TC", normalizeTransactionContextV1],
      ["api TC", normalizeApiTransactionContextV1]
    ]) {
      let result;
      assert.doesNotThrow(() => { result = fn(input, clock); }, `${label} threw on hostile primitive ${String(input)}`);
      assertStructuredVerdict(label, result, input);
      assert.equal(result.ok, false, `${label} unexpectedly accepted hostile primitive ${String(input)}`);
    }
  }
});
