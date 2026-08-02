import assert from "node:assert/strict";
import test from "node:test";

import { isValidStellarPublicKey } from "../../packages/protocol/src/index.js";

test("Stellar public-key validation verifies version and StrKey checksum", () => {
  assert.equal(isValidStellarPublicKey("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"), true);
  assert.equal(isValidStellarPublicKey("GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H"), true);
  assert.equal(isValidStellarPublicKey(`G${"A".repeat(55)}`), false);
  assert.equal(isValidStellarPublicKey("SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), false);
  assert.equal(isValidStellarPublicKey(""), false);
});
