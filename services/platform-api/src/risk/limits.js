import {
  isValidStellarPublicKey,
  RISK_LIMITS
} from "../../../../packages/protocol/src/index.js";
import {
  addDecimalStrings,
  compareDecimalStrings,
  normalizeDecimalString
} from "../decimal.js";
import { riskItem } from "./findings.js";
import { sameAddress } from "./matchers.js";

// The per-asset daily cap: honor a DAILY_LIMIT_<ASSET> env override, else fall back
// to the canonical protocol default. RISK_LIMITS (packages/protocol) is the single
// source of truth — this replaces the bare "1000" literal that used to be repeated
// at every call site, and is mirror-pinned to the Android wallet by
// tests/protocol/risk-limits-contract.test.mjs.
export function dailyLimitFor(env, asset) {
  const safeEnv = env || {};
  return safeEnv[`DAILY_LIMIT_${String(asset || "").toUpperCase()}`] || RISK_LIMITS.daily_limit_default;
}

export function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function checkWhitelist(raw, address, label, errors, warnings) {
  const list = splitList(raw);
  if (!list.length) {
    warnings.push(`No ${label} whitelist is configured`);
    return;
  }
  const found = list.some((item) => item.toLowerCase() === String(address || "").toLowerCase());
  if (!found) errors.push(`${label} is not in the whitelist`);
}

export function checkDailyLimit(store, asset, amount, limit, errors) {
  if (dailyLimitExceeded(store, asset, amount, limit)) errors.push(`Daily ${asset} limit exceeded`);
}

export function stellarPublicPolicyViolations(payment, env = process.env) {
  if (String(payment?.rail || "") !== "stellar_xlm" || String(payment?.network || "") !== "stellar_public") {
    return [];
  }

  const safeEnv = env || {};
  const violations = [];
  const enabled = parseBool(safeEnv.STELLAR_PUBLIC_ENABLED, false);
  const maxAmount = normalizeDecimalString(safeEnv.STELLAR_PUBLIC_SINGLE_PAYMENT_MAX_XLM || "1");
  const amount = normalizeDecimalString(payment.amount);
  const approvedHorizon = String(
    safeEnv.STELLAR_PUBLIC_HORIZON_URL || "https://horizon.stellar.org"
  ).trim();
  const requestedHorizon = String(payment.horizon_url || approvedHorizon).trim();
  const whitelist = splitList(safeEnv.ADDRESS_WHITELIST_STELLAR);

  if (!enabled) {
    violations.push({
      code: "stellar_mainnet_disabled",
      message: "Stellar public-network payments are disabled by server policy.",
      field: "payment.network"
    });
  }
  if (maxAmount === null || compareDecimalStrings(maxAmount, "0") <= 0) {
    violations.push({
      code: "stellar_mainnet_policy_invalid",
      message: "The Stellar public-network single-payment limit is invalid.",
      field: "payment.amount",
      details: { configured_limit: safeEnv.STELLAR_PUBLIC_SINGLE_PAYMENT_MAX_XLM ?? null }
    });
  } else if (amount === null || compareDecimalStrings(amount, "0") <= 0 || compareDecimalStrings(amount, maxAmount) > 0) {
    violations.push({
      code: "stellar_mainnet_amount_exceeded",
      message: `Stellar public-network payments must be greater than zero and no more than ${maxAmount} XLM.`,
      field: "payment.amount",
      details: { amount: payment.amount ?? null, limit: maxAmount }
    });
  }
  if (!/^https:\/\//i.test(approvedHorizon)) {
    violations.push({
      code: "stellar_mainnet_policy_invalid",
      message: "The approved Stellar public-network Horizon endpoint must use HTTPS.",
      field: "payment.horizon_url"
    });
  } else if (requestedHorizon !== approvedHorizon) {
    violations.push({
      code: "stellar_horizon_not_approved",
      message: "The requested Horizon endpoint is not the approved Stellar public-network endpoint.",
      field: "payment.horizon_url",
      details: { requested: requestedHorizon, approved: approvedHorizon }
    });
  }
  if (payment.stellar_testnet === true || String(payment.stellar_testnet || "").toLowerCase() === "true") {
    violations.push({
      code: "stellar_network_mismatch",
      message: "stellar_public cannot be combined with the Stellar testnet flag.",
      field: "payment.stellar_testnet"
    });
  }
  if (!isValidStellarPublicKey(payment.to)) {
    violations.push({
      code: "invalid_stellar_recipient",
      message: "The Stellar public-network recipient has an invalid StrKey checksum.",
      field: "payment.to"
    });
  }
  if (!whitelist.length) {
    violations.push({
      code: "stellar_mainnet_recipient_allowlist_required",
      message: "A Stellar public-network recipient allowlist is required.",
      field: "payment.to"
    });
  } else if (!whitelist.some((item) => sameAddress(item, payment.to))) {
    violations.push({
      code: "recipient_not_whitelisted",
      message: "Recipient address is not in the configured Stellar public-network allowlist.",
      field: "payment.to",
      details: { recipient: payment.to ?? null }
    });
  }

  return violations;
}

export function dailyLimitExceeded(store, asset, amount, limit) {
  // Compare the running total against the cap in EXACT decimal arithmetic. The old
  // code coerced everything to float64, so accumulated rounding error could leave a
  // payment that truly exceeds the cap comparing as under it (H3). Fail CLOSED: an
  // unparseable amount or a misconfigured limit rejects the payment rather than
  // silently sliding past the cap.
  const amountStr = normalizeDecimalString(amount);
  const limitStr = normalizeDecimalString(limit);
  if (amountStr === null || limitStr === null) return true;
  // F1: count confirmed spend PLUS live reservations (payments already committed
  // against the cap but not yet confirmed). Checking confirmed-only here is what
  // let many concurrent in-flight payments each pass this gate against the same
  // un-incremented total, then all confirm past the cap. Falls back to
  // confirmed-only for any store that predates dailyCommitted.
  const current = typeof store.dailyCommitted === "function"
    ? store.dailyCommitted(asset)
    : store.dailySpent(asset);
  const next = addDecimalStrings(current, amountStr);
  return compareDecimalStrings(next, limitStr) > 0;
}

// M-1: enforce the daily cap and recipient whitelist on the main Payment Request
// path, emitting riskItem-shaped BLOCKERS (so review_status becomes "blocked" and
// signing_allowed becomes false — the device honors that). No store means no policy
// context available (e.g. unit-testing the pure context logic), so skip silently.
export function enforcePolicyLimits(payment, store, env, errors, warnings) {
  const safeEnv = env || {};
  const mainnetViolations = stellarPublicPolicyViolations(payment, safeEnv);
  for (const violation of mainnetViolations) {
    errors.push(riskItem(
      violation.code,
      violation.message,
      violation.field,
      "blocker",
      violation.details
    ));
  }

  if (!store) return;
  const asset = String(payment.asset || "").toUpperCase();
  if (asset) {
    const limit = dailyLimitFor(safeEnv, asset);
    if (dailyLimitExceeded(store, asset, payment.amount, limit)) {
      errors.push(riskItem(
        "daily_limit_exceeded",
        `Daily ${asset} limit exceeded.`,
        "payment.amount",
        "blocker",
        { asset, amount: payment.amount ?? null, limit }
      ));
    }
  }
  // Whitelist only the address families the legacy path guarded (Stellar + EVM).
  // Enforce ONLY when a list is actually configured: an unset whitelist means
  // "not in use", and must not flip every request to needs-review.
  const rail = String(payment.rail || "");
  const whitelistRaw = rail === "stellar_xlm"
    ? safeEnv.ADDRESS_WHITELIST_STELLAR
    : (rail === "evm_erc20" || rail === "base_usdc")
      ? safeEnv.ADDRESS_WHITELIST_EVM
      : null;
  const whitelist = splitList(whitelistRaw);
  if (rail === "stellar_xlm" && String(payment.network || "") === "stellar_public") return;
  if (whitelist.length && !whitelist.some((item) => sameAddress(item, payment.to))) {
    errors.push(riskItem(
      "recipient_not_whitelisted",
      "Recipient address is not in the configured whitelist.",
      "payment.to",
      "blocker",
      { recipient: payment.to ?? null }
    ));
  }
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}
