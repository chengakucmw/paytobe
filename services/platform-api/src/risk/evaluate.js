import {
  BASE_USDC_CONTRACT,
  detectUnsupportedTransferTarget,
  findSupportedTransferAsset,
  transferAssetAdapterWarning,
  validateTransferAddress
} from "../../../../packages/protocol/src/index.js";
import {
  compareContextCosts,
  compareTruthFields,
  importContextRiskFindings
} from "./context-review.js";
import { riskItem, summarizePaymentRequestRisk } from "./findings.js";
import {
  checkDailyLimit,
  checkWhitelist,
  dailyLimitFor,
  enforcePolicyLimits,
  stellarPublicPolicyViolations
} from "./limits.js";

// The top-level risk evaluators. evaluateIntent is the legacy intent path;
// evaluatePaymentRequest is the main Payment Request path. Both compose the
// asset-validation, policy-gate, and context-review helpers from the sibling
// modules and return plain { errors, warnings, ... } results.

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
    checkDailyLimit(store, "USDC", payment.amount, dailyLimitFor(env, "USDC"), errors);
  } else if (payment.rail === "stellar_xlm") {
    if (!["stellar_public", "stellar_testnet"].includes(payment.network)) errors.push("Unsupported Stellar network");
    if ((payment.asset || "").toUpperCase() !== "XLM") errors.push("Only XLM is allowlisted on Stellar");
    if (!/^G[A-Z2-7]{55}$/.test(payment.to || "")) errors.push("Recipient must be a Stellar G... public key");
    if (payment.network === "stellar_public") {
      errors.push(...stellarPublicPolicyViolations(payment, env).map((item) => item.message));
    } else {
      checkWhitelist(env.ADDRESS_WHITELIST_STELLAR, payment.to, "Stellar recipient", errors, warnings);
    }
    checkDailyLimit(store, "XLM", payment.amount, dailyLimitFor(env, "XLM"), errors);
  } else {
    evaluateRegisteredTransferAsset(payment, store, env, errors, warnings);
  }

  if (!intent.idempotency_key) warnings.push("No idempotency key was provided");
  if (!intent.Paytobe?.request_id) warnings.push("No Paytobe request id was provided");
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
  checkDailyLimit(store, asset.symbol, payment.amount, dailyLimitFor(env, asset.symbol), errors);
}

export function evaluatePaymentRequest(request, contextResult = {}, store = null, env = process.env) {
  const errors = [];
  const warnings = [];
  const payment = request.payment || {};
  const ref = contextResult.ref || request.transaction_context_ref || {};
  const context = contextResult.context || null;
  // M7: trust ONLY the server-built snapshot passed in via contextResult. The
  // request's own `transaction_context_snapshot` is client-supplied and could be
  // forged to look "safe", so it must never feed risk scoring.
  const snapshot = contextResult.snapshot || null;
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
  // M-1: the daily spend cap and the recipient whitelist used to be enforced ONLY
  // on the legacy evaluateIntent path. Wire both gates in here, on the path real
  // traffic uses, so the cap is actually enforced and a configured whitelist
  // actually blocks off-list recipients.
  enforcePolicyLimits(payment, store, env, errors, warnings);

  return summarizePaymentRequestRisk(errors, warnings, { contextMissing });
}

function firstNonEmpty(...values) {
  return values.some((value) => value !== undefined && value !== null && String(value).trim().length > 0);
}
