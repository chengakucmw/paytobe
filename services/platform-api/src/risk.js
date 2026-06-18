import {
  BASE_USDC_CONTRACT,
  detectUnsupportedTransferTarget,
  findSupportedTransferAsset,
  transferAssetAdapterWarning,
  validateTransferAddress
} from "../../../packages/protocol/src/index.js";
import {
  addDecimalParts,
  addDecimalStrings,
  compareDecimalStrings,
  decimalAbsDiff,
  decimalString,
  normalizeDecimalString
} from "./decimal.js";

export const ALLOWED_STATUSES = new Set([
  "pending",
  "signed",
  "broadcasted",
  "confirmed",
  "failed",
  "expired",
  "rejected"
]);

export function evaluateIntent(intent, store, env = process.env) {
  const errors = [];
  const warnings = [];
  const payment = intent.payment || {};
  const expiresAt = Date.parse(intent.expires_at || "");
  if (!expiresAt || expiresAt <= Date.now()) errors.push("Payment request is expired");
  const blocked = detectUnsupportedTransferTarget(payment);
  if (blocked.blocked) errors.push(blocked.message);

  if (payment.rail === "evm_erc20" || payment.rail === "base_usdc") {
    if (payment.network !== "base_mainnet") errors.push("Only base_mainnet is allowlisted for Base USDC payment requests");
    if (Number(payment.chain_id) !== 8453) errors.push("Base USDC chain id must be 8453");
    if ((payment.asset || "").toUpperCase() !== "USDC") errors.push("Only USDC is allowlisted on Base");
    if ((payment.token_contract || "").toLowerCase() !== BASE_USDC_CONTRACT.toLowerCase()) {
      errors.push("Base USDC token contract is not allowlisted");
    }
    if (Number(payment.decimals) !== 6) errors.push("Base USDC decimals must be 6");
    if (!/^0x[0-9a-fA-F]{40}$/.test(payment.to || "")) errors.push("Recipient must be an EVM 0x address");
    checkWhitelist(env.ADDRESS_WHITELIST_EVM, payment.to, "EVM recipient", errors, warnings);
    checkDailyLimit(store, "USDC", payment.amount, env.DAILY_LIMIT_USDC || "1000", errors);
  } else if (payment.rail === "stellar_xlm") {
    if (!["stellar_public", "stellar_testnet"].includes(payment.network)) errors.push("Unsupported Stellar network");
    if ((payment.asset || "").toUpperCase() !== "XLM") errors.push("Only XLM is allowlisted on Stellar");
    if (!/^G[A-Z2-7]{55}$/.test(payment.to || "")) errors.push("Recipient must be a Stellar G... public key");
    checkWhitelist(env.ADDRESS_WHITELIST_STELLAR, payment.to, "Stellar recipient", errors, warnings);
    checkDailyLimit(store, "XLM", payment.amount, env.DAILY_LIMIT_XLM || "1000", errors);
  } else {
    evaluateRegisteredTransferAsset(payment, store, env, errors, warnings);
  }

  if (!intent.idempotency_key) warnings.push("No idempotency key was provided");
  if (!intent.velarum?.request_id) warnings.push("No Velarum request id was provided");
  return { ok: errors.length === 0, errors, warnings };
}

function evaluateRegisteredTransferAsset(payment, store, env, errors, warnings) {
  const asset = findSupportedTransferAsset(payment);
  if (!asset) {
    errors.push("Unsupported payment rail or asset");
    return;
  }
  if (payment.network !== asset.network) errors.push(`${asset.symbol} is supported only on ${asset.network}`);
  if ((payment.asset || "").toUpperCase() !== asset.symbol) errors.push(`Only ${asset.symbol} is allowlisted on ${asset.chain}`);
  if (asset.chain_id !== undefined && Number(payment.chain_id) !== Number(asset.chain_id)) {
    errors.push(`${asset.chain} chain id must be ${asset.chain_id}`);
  }
  if (asset.token_contract && (payment.token_contract || "").toLowerCase() !== asset.token_contract.toLowerCase()) {
    errors.push(`${asset.chain} ${asset.symbol} token contract is not allowlisted`);
  }
  if (asset.decimals !== undefined && payment.decimals !== undefined && Number(payment.decimals) !== Number(asset.decimals)) {
    errors.push(`${asset.chain} ${asset.symbol} decimals must be ${asset.decimals}`);
  }
  if (!validateTransferAddress(asset, payment.to || "")) {
    errors.push(`${asset.chain} ${asset.symbol} recipient address is invalid`);
  }
  if (asset.execution_mode === "prepared_payload") {
    if (!firstNonEmpty(payment.signing_payload, payment.unsigned_payload, payment.payload)) {
      errors.push(`${asset.chain} ${asset.symbol} requires a prepared unsigned transaction payload for local signing`);
    }
    if (!firstNonEmpty(payment.broadcast_url, payment.submit_url)) {
      errors.push(`${asset.chain} ${asset.symbol} requires a broadcast URL for the signed prepared payload`);
    }
  }
  const adapterWarning = transferAssetAdapterWarning(asset);
  if (adapterWarning) warnings.push(adapterWarning.message);
  checkDailyLimit(store, asset.symbol, payment.amount, env[`DAILY_LIMIT_${asset.symbol}`] || "1000", errors);
}

export function evaluatePaymentRequest(request, contextResult = {}) {
  const errors = [];
  const warnings = [];
  const payment = request.payment || {};
  const ref = contextResult.ref || request.transaction_context_ref || {};
  const context = contextResult.context || null;
  const snapshot = contextResult.snapshot || request.transaction_context_snapshot || null;
  const reviewContext = context || snapshot || {};
  const truthFields = Array.isArray(reviewContext.truth_fields) ? reviewContext.truth_fields : [];
  const riskFindings = Array.isArray(reviewContext.risk_findings) ? reviewContext.risk_findings : [];
  const contextMissing = !request.transaction_id || ref.status === "missing";

  if (contextMissing) {
    warnings.push(riskItem(
      "context_missing",
      request.transaction_id
        ? "Transaction Context is not available for this Payment Request."
        : "Payment Request has no transaction_id.",
      "transaction_id",
      "review_required",
      { transaction_id: request.transaction_id || null }
    ));
  }

  compareContextCosts(payment, reviewContext.costs, errors, warnings);
  compareTruthFields(request, truthFields, errors, warnings);
  importContextRiskFindings(riskFindings, errors, warnings);

  return summarizePaymentRequestRisk(errors, warnings, { contextMissing });
}

export function canTransition(status) {
  return ALLOWED_STATUSES.has(status);
}

export function shouldRecordSpent(status) {
  return status === "confirmed";
}

function checkWhitelist(raw, address, label, errors, warnings) {
  const list = splitList(raw);
  if (!list.length) {
    warnings.push(`No ${label} whitelist is configured`);
    return;
  }
  const found = list.some((item) => item.toLowerCase() === String(address || "").toLowerCase());
  if (!found) errors.push(`${label} is not in the whitelist`);
}

function checkDailyLimit(store, asset, amount, limit, errors) {
  // Compare the running total against the cap in EXACT decimal arithmetic.
  // The old code coerced everything to float64, so accumulated rounding
  // error could leave a payment that truly exceeds the cap comparing as
  // under it (H3). Fail CLOSED: an unparseable amount or a misconfigured
  // limit rejects the payment rather than silently sliding past the cap
  // (the old `next > NaN` quietly evaluated to false → allowed).
  const amountStr = normalizeDecimalString(amount);
  const limitStr = normalizeDecimalString(limit);
  if (amountStr === null || limitStr === null) {
    errors.push(`Daily ${asset} limit exceeded`);
    return;
  }
  const next = addDecimalStrings(store.dailySpent(asset), amountStr);
  if (compareDecimalStrings(next, limitStr) > 0) errors.push(`Daily ${asset} limit exceeded`);
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function firstNonEmpty(...values) {
  return values.some((value) => value !== undefined && value !== null && String(value).trim().length > 0);
}

function compareContextCosts(payment, costs, errors, warnings) {
  if (!costs || typeof costs !== "object") return;
  if (costs.currency && payment.asset && !sameToken(costs.currency, payment.asset)) {
    errors.push(riskItem(
      "context_asset_mismatch",
      "Transaction Context currency differs from Payment Request asset.",
      "payment.asset",
      "blocker",
      { context_currency: costs.currency, payment_asset: payment.asset }
    ));
  }

  if (!decimalString(costs.total) || !decimalString(payment.amount)) return;
  const comparison = compareDecimalStrings(costs.total, payment.amount);
  if (comparison === 0) {
    compareFeeBasis(payment, costs, warnings);
    return;
  }

  const diff = decimalAbsDiff(costs.total, payment.amount);
  const fee = payment.estimated_fee || payment.fee || costs.fee || costs.fees || costs.service_fee || "";
  if (decimalString(fee) && compareDecimalStrings(diff, fee) <= 0) {
    warnings.push(riskItem(
      "context_fee_basis_warning",
      "Transaction Context total and Payment Request amount differ by fee, tax, or rounding basis.",
      "payment.amount",
      "warning",
      { context_total: costs.total, payment_amount: payment.amount, difference: diff, fee_basis: fee }
    ));
    return;
  }

  if (compareDecimalStrings(diff, "0.01") <= 0) {
    warnings.push(riskItem(
      "context_fee_basis_warning",
      "Transaction Context total and Payment Request amount differ only by rounding basis.",
      "payment.amount",
      "warning",
      { context_total: costs.total, payment_amount: payment.amount, difference: diff }
    ));
    return;
  }

  errors.push(riskItem(
    "context_amount_mismatch",
    "Transaction Context total differs from Payment Request amount.",
    "payment.amount",
    "blocker",
    { context_total: costs.total, payment_amount: payment.amount, difference: diff }
  ));
}

function compareFeeBasis(payment, costs, warnings) {
  const fee = payment.estimated_fee || payment.fee || "";
  const componentTotal = addDecimalParts([
    costs.subtotal,
    costs.tax,
    costs.taxes,
    costs.service_fee,
    costs.fee,
    costs.fees,
    costs.shipping,
    costs.delivery_fee
  ]);
  if (componentTotal && costs.total && compareDecimalStrings(componentTotal, costs.total) !== 0) {
    warnings.push(riskItem(
      "context_fee_basis_warning",
      "Transaction Context cost components do not add up to the stated total.",
      "costs.total",
      "warning",
      { component_total: componentTotal, context_total: costs.total }
    ));
  }
  if (fee && costs.total && payment.total && compareDecimalStrings(payment.total, costs.total) !== 0) {
    warnings.push(riskItem(
      "context_fee_basis_warning",
      "Payment Request total includes network fee separately from Transaction Context total.",
      "payment.total",
      "warning",
      { payment_total: payment.total, context_total: costs.total, network_fee: fee }
    ));
  }
}

function compareTruthFields(request, truthFields, errors, warnings) {
  const payment = request.payment || {};
  const payee = request.payee || {};
  for (const [index, field] of truthFields.entries()) {
    if (!field || typeof field !== "object") continue;
    const fieldPath = String(field.field || "");
    const value = field.value;
    const details = { truth_field: fieldPath, value, index };

    if (isAiOnlyOrObservedCriticalField(field)) {
      warnings.push(riskItem(
        "ai_only_critical_field",
        "A critical context field is AI-only, inferred-only, observed-only, or unverified.",
        fieldPath || `truth_fields.${index}`,
        "review_required",
        {
          ...details,
          source_type: field.source_type || null,
          verification_status: field.verification_status || null
        }
      ));
    }

    if (field.verification_status === "conflicted" && isPayeeOrRecipientField(fieldPath)) {
      errors.push(riskItem(
        "context_payee_mismatch",
        "Transaction Context marks payee or recipient evidence as conflicted.",
        fieldPath || `truth_fields.${index}`,
        "blocker",
        details
      ));
      continue;
    }

    if (value === undefined || value === null || value === "") continue;
    if (isAmountField(fieldPath) && decimalString(value) && decimalString(payment.amount)) {
      const comparison = compareDecimalStrings(String(value), payment.amount);
      if (comparison !== 0) {
        errors.push(riskItem(
          "context_amount_mismatch",
          "Transaction Context amount evidence differs from Payment Request amount.",
          "payment.amount",
          "blocker",
          { ...details, payment_amount: payment.amount }
        ));
      }
      continue;
    }
    if (isRecipientField(fieldPath) && payment.to && !sameAddress(value, payment.to)) {
      errors.push(riskItem(
        "context_payee_mismatch",
        "Transaction Context recipient evidence differs from Payment Request recipient.",
        "payment.to",
        "blocker",
        { ...details, payment_to: payment.to }
      ));
      continue;
    }
    if (isPayeeField(fieldPath) && payee.name && !sameText(value, payee.name)) {
      errors.push(riskItem(
        "context_payee_mismatch",
        "Transaction Context payee evidence differs from Payment Request payee.",
        "payee.name",
        "blocker",
        { ...details, payment_payee: payee.name }
      ));
      continue;
    }
    if (isAssetField(fieldPath) && payment.asset && !sameToken(value, payment.asset)) {
      errors.push(riskItem(
        "context_asset_mismatch",
        "Transaction Context asset evidence differs from Payment Request asset.",
        "payment.asset",
        "blocker",
        { ...details, payment_asset: payment.asset }
      ));
      continue;
    }
    if (isNetworkField(fieldPath) && payment.network && !sameText(value, payment.network)) {
      errors.push(riskItem(
        "context_network_mismatch",
        "Transaction Context network evidence differs from Payment Request network.",
        "payment.network",
        "blocker",
        { ...details, payment_network: payment.network }
      ));
    }
  }
}

function importContextRiskFindings(findings, errors, warnings) {
  for (const [index, finding] of findings.entries()) {
    if (!finding || typeof finding !== "object") continue;
    const severity = finding.severity || "warning";
    const target = severity === "blocker" ? errors : warnings;
    const code = mapContextRiskCode(finding.code, finding.field);
    target.push(riskItem(
      code,
      finding.message || "Transaction Context reported a risk finding.",
      finding.field || `risk_findings.${index}`,
      severity === "blocker" ? "blocker" : severity,
      { source_code: finding.code || null, index }
    ));
  }
}

function mapContextRiskCode(code, field = "") {
  const value = String(code || "").toLowerCase();
  const fieldPath = String(field || "").toLowerCase();
  if (value.includes("amount")) return "context_amount_mismatch";
  if (value.includes("asset")) return "context_asset_mismatch";
  if (value.includes("network")) return "context_network_mismatch";
  if (value.includes("payee") || value.includes("recipient") || value.includes("address")) {
    return "context_payee_mismatch";
  }
  if (value.includes("ai") || value.includes("inferred") || value.includes("merchant_ai")) {
    return "ai_only_critical_field";
  }
  if (value.includes("missing") || fieldPath.includes("missing")) return "context_missing";
  return "context_fee_basis_warning";
}

function summarizePaymentRequestRisk(errors, warnings, options = {}) {
  const hasContextMissing = options.contextMissing || warnings.some((warning) => warning.code === "context_missing");
  const level = errors.length ? "danger" : warnings.length ? "caution" : "safe";
  const reviewStatus = errors.length
    ? "blocked"
    : hasContextMissing
      ? "missing_context"
      : warnings.some((warning) => warning.code === "ai_only_critical_field")
        ? "source_review_required"
        : warnings.length
          ? "needs_review"
          : "ready";
  const signingAllowed = errors.length === 0 && !hasContextMissing;
  return {
    ok: errors.length === 0,
    level,
    review_status: reviewStatus,
    signing_allowed: signingAllowed,
    errors,
    warnings
  };
}

function riskItem(code, message, field, severity = "warning", details = {}) {
  const item = {
    code,
    message,
    severity
  };
  if (field) item.field = field;
  if (Object.keys(details).length) item.details = details;
  return item;
}

function isAiOnlyOrObservedCriticalField(field) {
  if (!isCriticalField(field.field)) return false;
  return ["merchant_ai_claim", "user_agent_inferred"].includes(field.source_type)
    || ["ai_claim_only", "inferred_only", "observed_only", "unverified", "missing"].includes(field.verification_status);
}

function isCriticalField(field) {
  const value = String(field || "").toLowerCase();
  return isAmountField(value)
    || isPayeeOrRecipientField(value)
    || isAssetField(value)
    || isNetworkField(value)
    || value.includes("pricing.")
    || value.includes("refund")
    || value.includes("subscription.")
    || value.includes("api_paid_call.")
    || value.includes("virtual_goods.")
    || value.includes("fulfillment.")
    || value.includes("merchant_identity");
}

function isAmountField(field) {
  const value = String(field || "").toLowerCase();
  return value === "payment.amount" || value === "pricing.total" || value === "costs.total";
}

function isPayeeOrRecipientField(field) {
  return isPayeeField(field) || isRecipientField(field);
}

function isPayeeField(field) {
  const value = String(field || "").toLowerCase();
  return value === "payee.name" || value === "payee.domain" || value.includes("merchant_identity");
}

function isRecipientField(field) {
  const value = String(field || "").toLowerCase();
  return value === "payment.to" || value.includes("recipient") || value.includes("address_binding");
}

function isAssetField(field) {
  const value = String(field || "").toLowerCase();
  return value === "payment.asset" || value === "asset" || value === "costs.currency" || value === "pricing.currency";
}

function isNetworkField(field) {
  const value = String(field || "").toLowerCase();
  return value === "payment.network" || value === "network";
}

function sameAddress(left, right) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (a.startsWith("0x") || b.startsWith("0x")) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function sameText(left, right) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

function sameToken(left, right) {
  return String(left || "").trim().toUpperCase() === String(right || "").trim().toUpperCase();
}

// Exact decimal helpers (decimalString, compareDecimalStrings,
// decimalAbsDiff, addDecimalParts) now live in ./decimal.js and are shared
// with store.js so the daily spend cap and these context-cost comparisons
// use one consistent BigInt implementation. See decimal.js for the H3 fix.

export { BASE_USDC_CONTRACT };
