import {
  addDecimalParts,
  compareDecimalStrings,
  decimalAbsDiff,
  decimalString
} from "../decimal.js";
import { riskItem } from "./findings.js";
import {
  isAiOnlyOrObservedCriticalField,
  isAmountField,
  isAssetField,
  isNetworkField,
  isPayeeField,
  isPayeeOrRecipientField,
  isRecipientField,
  sameAddress,
  sameText,
  sameToken
} from "./matchers.js";

// Compares the server-built Transaction Context against the Payment Request facts
// (costs, truth fields, imported context risk findings) and pushes structured
// errors/warnings. Pure: callers own the errors/warnings arrays.

export function compareContextCosts(payment, costs, errors, warnings) {
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

export function compareFeeBasis(payment, costs, warnings) {
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

export function compareTruthFields(request, truthFields, errors, warnings) {
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

export function importContextRiskFindings(findings, errors, warnings) {
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

export function mapContextRiskCode(code, field = "") {
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
