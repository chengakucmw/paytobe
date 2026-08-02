// Risk-limits contract test.
// packages/protocol RISK_LIMITS is the single source of truth for the default
// daily spend cap and the unverified-recipient cap. This test fails if either the
// backend risk policy or the Android wallet's mirrored caps drift away from it.
// (The Android wallet keeps its own BigDecimal literals because it cannot import
// the JS protocol package at runtime, so the values are pinned here instead.)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RISK_LIMITS } from "../../packages/protocol/src/index.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel) => readFileSync(new URL(rel, `file://${repoRoot}`), "utf8");

const DECIMAL_STRING = /^(0|[1-9]\d*)(\.\d+)?$/;

function javaBigDecimal(text, name) {
  const match = text.match(new RegExp(`${name}\\s*=\\s*new BigDecimal\\("([0-9.]+)"\\)`));
  return match ? match[1] : null;
}

// The iOS wallet keeps its own Swift Decimal literals for the same reason as Android
// (it cannot import the JS protocol package at runtime), so they are pinned here too.
function swiftDecimal(text, name) {
  const match = text.match(new RegExp(`${name}\\s*=\\s*Decimal\\(\\s*"?([0-9.]+)"?\\s*\\)`));
  return match ? match[1] : null;
}

test("RISK_LIMITS exposes positive decimal-string caps", () => {
  assert.ok(DECIMAL_STRING.test(RISK_LIMITS.daily_limit_default), "daily_limit_default must be a decimal string");
  assert.ok(DECIMAL_STRING.test(RISK_LIMITS.unverified_recipient_cap), "unverified_recipient_cap must be a decimal string");
  assert.equal(Number(RISK_LIMITS.daily_limit_default) > 0, true);
  assert.equal(Number(RISK_LIMITS.unverified_recipient_cap) > 0, true);
});

test("backend risk policy sources the daily cap from RISK_LIMITS (no stray literal)", () => {
  const limits = read("services/platform-api/src/risk/limits.js");
  assert.ok(
    limits.includes("RISK_LIMITS.daily_limit_default"),
    "risk/limits.js must use RISK_LIMITS.daily_limit_default as the cap fallback"
  );
  assert.ok(
    !/\|\|\s*"1000"/.test(limits),
    'risk/limits.js must not hardcode the "1000" cap fallback anymore'
  );
});

test("backend evaluators carry no hardcoded \"1000\" cap fallback", () => {
  const evaluate = read("services/platform-api/src/risk/evaluate.js");
  assert.ok(
    !/\|\|\s*"1000"/.test(evaluate),
    'risk/evaluate.js must route the daily cap through dailyLimitFor / RISK_LIMITS'
  );
});

test("Android wallet daily-limit caps mirror RISK_LIMITS.daily_limit_default", () => {
  const policy = read("apps/android/app/src/main/java/ai/agentwallet/hd/RiskPolicy.java");
  for (const name of ["DAILY_USDC_LIMIT", "DAILY_XLM_LIMIT", "DAILY_SOL_LIMIT"]) {
    assert.equal(
      javaBigDecimal(policy, name),
      RISK_LIMITS.daily_limit_default,
      `${name} drifted from RISK_LIMITS.daily_limit_default`
    );
  }
});

test("Android wallet unverified-recipient caps mirror RISK_LIMITS.unverified_recipient_cap", () => {
  const policy = read("apps/android/app/src/main/java/ai/agentwallet/hd/RiskPolicy.java");
  for (const name of ["UNVERIFIED_USDC_CAP", "UNVERIFIED_XLM_CAP", "UNVERIFIED_STELLAR_ASSET_CAP"]) {
    assert.equal(
      javaBigDecimal(policy, name),
      RISK_LIMITS.unverified_recipient_cap,
      `${name} drifted from RISK_LIMITS.unverified_recipient_cap`
    );
  }
});

test("iOS wallet daily-limit cap mirrors RISK_LIMITS.daily_limit_default", () => {
  const policy = read("apps/ios/VelarumPay/RiskPolicy.swift");
  assert.equal(
    swiftDecimal(policy, "dailyXLMLimit"),
    RISK_LIMITS.daily_limit_default,
    "iOS LocalRiskPolicy.dailyXLMLimit drifted from RISK_LIMITS.daily_limit_default"
  );
});

test("iOS wallet unverified-recipient cap mirrors RISK_LIMITS.unverified_recipient_cap", () => {
  const policy = read("apps/ios/VelarumPay/RiskPolicy.swift");
  assert.equal(
    swiftDecimal(policy, "unverifiedXLMCap"),
    RISK_LIMITS.unverified_recipient_cap,
    "iOS LocalRiskPolicy.unverifiedXLMCap drifted from RISK_LIMITS.unverified_recipient_cap"
  );
});
