// Cross-platform HD-derivation contract test.
//
// The Android and iOS wallets each implement BIP39 + SLIP-10 / BIP-44 key
// derivation in their own language (Kotlin/Java vs Swift) and, for the shared
// path, through the Rust core. The real danger is silent DRIFT: if one platform's
// derivation changes, the two apps would compute DIFFERENT wallet addresses from
// the same recovery phrase — funds would go to an address the user doesn't control.
//
// This test makes tests/fixtures/hd-derivation-golden.json the single source of
// truth and asserts that BOTH platforms' conformance tests pin the exact same
// mnemonic -> address vectors, for all three chains (Stellar / EVM / Solana). It
// runs in the normal node test runner, so the contract is checked on every backend
// test run; the platform tests themselves (run in Xcode / Gradle CI) and the Rust
// golden test prove each side actually derives those addresses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const golden = JSON.parse(readFileSync(`${root}tests/fixtures/hd-derivation-golden.json`, "utf8"));

const iosTest = readFileSync(`${root}apps/ios/PaytobeTests/HDDerivationGoldenTests.swift`, "utf8");
const androidTest = readFileSync(
  `${root}apps/android/app/src/test/java/ai/agentwallet/hd/HDDerivationGoldenTest.java`,
  "utf8"
);

const STELLAR = /^G[A-Z2-7]{55}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

test("golden vectors are well-formed for every chain", () => {
  assert.ok(golden.vectors.length >= 4, "expected at least four vectors");
  for (const v of golden.vectors) {
    assert.match(v.stellar_address, STELLAR, `bad Stellar address: ${v.stellar_address}`);
    assert.match(v.evm_address, EVM, `bad EVM address: ${v.evm_address}`);
    assert.match(v.solana_address, SOLANA, `bad Solana address: ${v.solana_address}`);
    assert.ok(v.mnemonic && v.mnemonic.split(" ").length === v.word_count, "mnemonic/word_count mismatch");
  }
});

test("iOS golden test pins every vector (mnemonic + all three chain addresses)", () => {
  for (const v of golden.vectors) {
    assert.ok(iosTest.includes(v.mnemonic), "iOS test missing a golden mnemonic");
    assert.ok(iosTest.includes(v.stellar_address), `iOS test missing Stellar ${v.stellar_address}`);
    assert.ok(iosTest.includes(v.evm_address), `iOS test missing EVM ${v.evm_address}`);
    assert.ok(iosTest.includes(v.solana_address), `iOS test missing Solana ${v.solana_address}`);
  }
});

test("Android golden test pins every vector (mnemonic + all three chain addresses)", () => {
  for (const v of golden.vectors) {
    assert.ok(androidTest.includes(v.mnemonic), "Android test missing a golden mnemonic");
    assert.ok(androidTest.includes(v.stellar_address), `Android test missing Stellar ${v.stellar_address}`);
    assert.ok(androidTest.includes(v.evm_address), `Android test missing EVM ${v.evm_address}`);
    assert.ok(androidTest.includes(v.solana_address), `Android test missing Solana ${v.solana_address}`);
  }
});
