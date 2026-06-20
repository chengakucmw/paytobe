// Cross-platform HD-derivation contract test.
//
// The Android and iOS wallets each implement BIP39 + SLIP-10 key derivation in
// their own language (Kotlin/Java vs Swift) with no shared code. The real danger
// is silent DRIFT: if one platform's derivation changes, the two apps would
// compute DIFFERENT wallet addresses from the same recovery phrase — funds would
// go to an address the user doesn't control.
//
// This test makes tests/fixtures/hd-derivation-golden.json the single source of
// truth and asserts that BOTH platforms' conformance tests pin the exact same
// mnemonic -> address vector. It runs in the normal node test runner, so the
// contract is checked on every backend test run; the platform tests themselves
// (run in Xcode / Gradle CI) prove each app actually derives that address.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const golden = JSON.parse(readFileSync(`${root}tests/fixtures/hd-derivation-golden.json`, "utf8"));

const iosTest = readFileSync(`${root}apps/ios/VelarumPayTests/HDDerivationGoldenTests.swift`, "utf8");
const androidTest = readFileSync(
  `${root}apps/android/app/src/test/java/ai/agentwallet/hd/HDDerivationGoldenTest.java`,
  "utf8"
);

test("golden vectors are well-formed Stellar addresses", () => {
  assert.ok(golden.vectors.length >= 1, "expected at least one vector");
  for (const v of golden.vectors) {
    assert.match(v.stellar_address, /^G[A-Z2-7]{55}$/, `bad Stellar address: ${v.stellar_address}`);
    assert.ok(v.mnemonic && v.mnemonic.split(" ").length === v.word_count, "mnemonic/word_count mismatch");
  }
});

test("iOS conformance test pins every golden vector (mnemonic + address)", () => {
  for (const v of golden.vectors) {
    assert.ok(iosTest.includes(v.stellar_address), `iOS test missing address ${v.stellar_address}`);
    assert.ok(iosTest.includes(v.mnemonic), "iOS test missing the golden mnemonic");
  }
});

test("Android conformance test pins every golden vector (mnemonic + address)", () => {
  for (const v of golden.vectors) {
    assert.ok(androidTest.includes(v.stellar_address), `Android test missing address ${v.stellar_address}`);
    assert.ok(androidTest.includes(v.mnemonic), "Android test missing the golden mnemonic");
  }
});
