// Pure value comparators and Transaction-Context field classifiers used by the
// risk evaluation. No I/O, no state — just predicates over strings/fields.

export function sameAddress(left, right) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (a.startsWith("0x") || b.startsWith("0x")) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

export function sameText(left, right) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

export function sameToken(left, right) {
  return String(left || "").trim().toUpperCase() === String(right || "").trim().toUpperCase();
}

export function isAmountField(field) {
  const value = String(field || "").toLowerCase();
  return value === "payment.amount" || value === "pricing.total" || value === "costs.total";
}

export function isPayeeField(field) {
  const value = String(field || "").toLowerCase();
  return value === "payee.name" || value === "payee.domain" || value.includes("merchant_identity");
}

export function isRecipientField(field) {
  const value = String(field || "").toLowerCase();
  return value === "payment.to" || value.includes("recipient") || value.includes("address_binding");
}

export function isPayeeOrRecipientField(field) {
  return isPayeeField(field) || isRecipientField(field);
}

export function isAssetField(field) {
  const value = String(field || "").toLowerCase();
  return value === "payment.asset" || value === "asset" || value === "costs.currency" || value === "pricing.currency";
}

export function isNetworkField(field) {
  const value = String(field || "").toLowerCase();
  return value === "payment.network" || value === "network";
}

export function isCriticalField(field) {
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

export function isAiOnlyOrObservedCriticalField(field) {
  if (!isCriticalField(field.field)) return false;
  return ["merchant_ai_claim", "user_agent_inferred"].includes(field.source_type)
    || ["ai_claim_only", "inferred_only", "observed_only", "unverified", "missing"].includes(field.verification_status);
}
