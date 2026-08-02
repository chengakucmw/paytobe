import { createHash } from "node:crypto";
import {
  BASE_USDC_CONTRACT,
  CANONICAL_PAYMENT_RAILS,
  PAIRING_SCOPES,
  PAYMENT_RAILS,
  PAYMENT_REQUEST_PROTOCOL,
  PAYMENT_STATUSES,
  RISK_SEVERITIES,
  SOURCE_TYPES,
  SUPPORTED_NETWORKS,
  TERMINAL_PAYMENT_STATUSES,
  TRANSACTION_CONTEXT_PROTOCOL,
  TRANSACTION_CONTEXT_STATUSES,
  TRANSACTION_CONTEXT_TYPES,
  VERIFICATION_STATUSES
} from "./constants.js";
import {
  detectUnsupportedTransferTarget,
  findSupportedTransferAsset,
  transferAssetAdapterWarning,
  validateTransferAddress
} from "./transfer-assets.js";
import { DECIMAL_STRING } from "./decimal-format.js";
import { normalizeRecipientVersionV1 } from "./recipient-validation.js";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const STELLAR_PUBLIC_KEY = /^G[A-Z2-7]{55}$/;
// Strict ISO 8601 / RFC 3339 instant: full date + time + an explicit timezone
// (Z or ±HH:MM). The old check accepted anything Date.parse() tolerated, which
// includes ambiguous, locale-dependent forms like "2026/06/20" or a bare
// "2026-06-20T12:00:00" with no zone. A money request must carry one unambiguous
// instant, so the shape is pinned here; Date.parse() then only confirms it names
// a real moment.
const ISO_8601_INSTANT = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/;

export function protocolError(code, message, details = {}) {
  return { code, message, details };
}

export function normalizePaymentRequestV1(payload, options = {}) {
  const errors = [];
  const warnings = [];
  const nowMs = normalizeNow(options.now);

  if (!isRecord(payload)) {
    return failed(protocolError("invalid_payment_request", "Payment Request payload must be an object"));
  }

  requireEqual(payload.protocol, PAYMENT_REQUEST_PROTOCOL, "protocol", PAYMENT_REQUEST_PROTOCOL, errors);
  requireString(payload.request_id, "request_id", errors);
  requireString(payload.connection_id, "connection_id", errors);
  requireIsoTimestamp(payload.created_at, "created_at", errors);
  requireIsoTimestamp(payload.expires_at, "expires_at", errors);

  const status = String(payload.status || "");
  if (!PAYMENT_STATUSES.includes(status)) {
    errors.push(protocolError("invalid_status", "Payment Request status is not supported", { field: "status", status }));
  }

  if (!isRecord(payload.source)) {
    errors.push(protocolError("invalid_payment_request", "source is required", { field: "source" }));
  }
  if (!isRecord(payload.payee)) {
    errors.push(protocolError("invalid_payment_request", "payee is required", { field: "payee" }));
  } else if (!nonEmptyString(payload.payee.name)) {
    errors.push(protocolError("invalid_payment_request", "payee.name is required", { field: "payee.name" }));
  }
  if (!isRecord(payload.payment)) {
    errors.push(protocolError("invalid_payment_request", "payment is required", { field: "payment" }));
  }
  if (!isRecord(payload.policy)) {
    errors.push(protocolError("invalid_payment_request", "policy is required", { field: "policy" }));
  }

  if (errors.length) return failed(errors[0], errors);

  const createdAtMs = Date.parse(payload.created_at);
  const expiresAtMs = Date.parse(payload.expires_at);
  // Structural sanity: an inverted or zero-length window (expires_at at or before
  // created_at) is malformed, not merely expired. Flagging it as its own error
  // stops a forged created_at/expires_at pair from sliding through as a normal
  // request. A maximum validity window is intentionally NOT enforced: the protocol
  // uses a far-future expiry (e.g. 2027-12-31) as a deliberate "effectively never
  // expires" sentinel, and capping it would break that idiom.
  if (expiresAtMs <= createdAtMs) {
    return failed(protocolError("invalid_validity_window", "expires_at must be after created_at", {
      field: "expires_at",
      created_at: payload.created_at,
      expires_at: payload.expires_at
    }));
  }
  if (expiresAtMs <= nowMs || status === "expired") {
    return failed(protocolError("expired_request", "Payment Request is expired", {
      field: "expires_at",
      expires_at: payload.expires_at,
      status
    }));
  }

  if (TERMINAL_PAYMENT_STATUSES.includes(status)) {
    return failed(protocolError("terminal_request", "Terminal Payment Request cannot be signed again", {
      field: "status",
      status
    }));
  }

  const paymentResult = normalizePayment(payload.payment, options);
  if (!paymentResult.ok) return paymentResult;
  warnings.push(...paymentResult.warnings);

  if (payload.policy.requires_user_approval === false) {
    errors.push(protocolError("user_approval_required", "Payment Request v1 requires user approval for real payments", {
      field: "policy.requires_user_approval"
    }));
  }

  if (!payload.idempotency_key) {
    warnings.push(protocolError("missing_idempotency_key", "idempotency_key is recommended", {
      field: "idempotency_key"
    }));
  }

  if (errors.length) return failed(errors[0], errors);

  const normalized = {
    ...payload,
    protocol: PAYMENT_REQUEST_PROTOCOL,
    request_id: String(payload.request_id),
    connection_id: String(payload.connection_id),
    transaction_id: payload.transaction_id ? String(payload.transaction_id) : undefined,
    created_at: new Date(Date.parse(payload.created_at)).toISOString(),
    expires_at: new Date(expiresAtMs).toISOString(),
    status,
    source: { ...payload.source },
    payee: { ...payload.payee },
    payment: paymentResult.value,
    policy: {
      ...payload.policy,
      requires_user_approval: payload.policy.requires_user_approval !== false
    },
    display: isRecord(payload.display) ? { ...payload.display } : payload.display,
    metadata: isRecord(payload.metadata) ? { ...payload.metadata } : payload.metadata
  };

  return succeeded(normalized, warnings);
}

export function normalizeTransactionContextV1(payload, options = {}) {
  const errors = [];
  const warnings = [];

  if (!isRecord(payload)) {
    return failed(protocolError("invalid_transaction_context", "Transaction Context payload must be an object"));
  }

  requireEqual(payload.protocol, TRANSACTION_CONTEXT_PROTOCOL, "protocol", TRANSACTION_CONTEXT_PROTOCOL, errors);
  requireString(payload.transaction_id, "transaction_id", errors, "invalid_transaction_context");
  requireString(payload.connection_id, "connection_id", errors, "invalid_transaction_context");
  requireString(payload.type, "type", errors, "invalid_transaction_context");
  requireString(payload.title, "title", errors, "invalid_transaction_context");
  requireString(payload.summary, "summary", errors, "invalid_transaction_context");

  const type = String(payload.type || "");
  if (type && !TRANSACTION_CONTEXT_TYPES.includes(type)) {
    errors.push(protocolError("unsupported_context_type", "Transaction Context type is not supported", {
      field: "type",
      type
    }));
  }

  const status = payload.status ? String(payload.status) : "proposed";
  if (!TRANSACTION_CONTEXT_STATUSES.includes(status)) {
    errors.push(protocolError("invalid_context_status", "Transaction Context status is not supported", {
      field: "status",
      status
    }));
  }

  if (payload.created_at !== undefined) requireIsoTimestamp(payload.created_at, "created_at", errors);
  if (payload.updated_at !== undefined) requireIsoTimestamp(payload.updated_at, "updated_at", errors);
  if (payload.expires_at !== undefined) requireIsoTimestamp(payload.expires_at, "expires_at", errors);

  const agentActivity = normalizeArray(payload.agent_activity ?? payload.activity, "agent_activity", errors);
  const items = normalizeArray(payload.items, "items", errors);
  const media = normalizeArray(payload.media, "media", errors);
  const evidence = normalizeArray(payload.evidence, "evidence", errors);
  const truthFields = normalizeArray(payload.truth_fields, "truth_fields", errors);
  const missingContext = normalizeArray(payload.missing_context, "missing_context", errors);
  const riskFindings = normalizeArray(payload.risk_findings ?? payload.risk?.findings, "risk_findings", errors);

  for (const [index, field] of truthFields.entries()) {
    if (!isRecord(field)) {
      errors.push(protocolError("invalid_truth_field", "truth_fields items must be objects", {
        field: `truth_fields.${index}`
      }));
      continue;
    }
    if (!field.field) {
      warnings.push(protocolError("truth_field_missing_path", "Truth field is missing field path", {
        field: `truth_fields.${index}.field`
      }));
    }
    if (field.source_type && !SOURCE_TYPES.includes(field.source_type)) {
      errors.push(protocolError("invalid_source_type", "Truth field source_type is not supported", {
        field: `truth_fields.${index}.source_type`,
        source_type: field.source_type
      }));
    }
    if (field.verification_status && !VERIFICATION_STATUSES.includes(field.verification_status)) {
      errors.push(protocolError("invalid_verification_status", "Truth field verification_status is not supported", {
        field: `truth_fields.${index}.verification_status`,
        verification_status: field.verification_status
      }));
    }
    if (field.source_type === "user_agent_inferred" || field.verification_status === "inferred_only") {
      warnings.push(protocolError("critical_field_ai_inferred", "AI-inferred critical field requires review", {
        field: field.field || `truth_fields.${index}`
      }));
    }
    if (field.source_type === "merchant_ai_claim" || field.verification_status === "ai_claim_only") {
      warnings.push(protocolError("merchant_ai_claim_only", "Merchant AI claim requires explicit review", {
        field: field.field || `truth_fields.${index}`
      }));
    }
  }

  for (const [index, finding] of riskFindings.entries()) {
    if (!isRecord(finding)) continue;
    if (finding.severity && !RISK_SEVERITIES.includes(finding.severity)) {
      errors.push(protocolError("invalid_risk_severity", "Risk severity is not supported", {
        field: `risk_findings.${index}.severity`,
        severity: finding.severity
      }));
    }
  }

  if (!truthFields.length && !missingContext.length) {
    warnings.push(protocolError("missing_truth_context", "truth_fields is empty and no missing_context explanation was provided", {
      field: "truth_fields"
    }));
  }

  if (errors.length) return failed(errors[0], errors);

  const normalized = {
    ...payload,
    protocol: TRANSACTION_CONTEXT_PROTOCOL,
    transaction_id: String(payload.transaction_id),
    connection_id: String(payload.connection_id),
    created_at: payload.created_at ? new Date(Date.parse(payload.created_at)).toISOString() : new Date(normalizeNow(options.now)).toISOString(),
    updated_at: payload.updated_at ? new Date(Date.parse(payload.updated_at)).toISOString() : undefined,
    expires_at: payload.expires_at ? new Date(Date.parse(payload.expires_at)).toISOString() : undefined,
    type,
    status,
    title: String(payload.title),
    summary: String(payload.summary),
    source: isRecord(payload.source) ? { ...payload.source } : {},
    user_intent: isRecord(payload.user_intent) ? { ...payload.user_intent } : payload.agent_goal || {},
    agent_activity: agentActivity,
    items,
    costs: isRecord(payload.costs) ? { ...payload.costs } : {},
    media,
    evidence,
    provenance: isRecord(payload.provenance) ? { ...payload.provenance } : {},
    truth_fields: truthFields,
    missing_context: missingContext,
    risk_findings: riskFindings,
    risk: isRecord(payload.risk) ? { ...payload.risk } : {}
  };

  return succeeded(normalized, warnings);
}

export function createTransactionContextSnapshot(context, options = {}) {
  const normalized = normalizeTransactionContextV1(context, options);
  if (!normalized.ok) return normalized;
  const value = normalized.value;
  const snapshot = {
    transaction_id: value.transaction_id,
    snapshot_created_at: new Date(normalizeNow(options.now)).toISOString(),
    truth_fields: value.truth_fields,
    evidence: value.evidence,
    missing_context: value.missing_context,
    risk_findings: value.risk_findings
  };
  snapshot.snapshot_hash = `sha256:${sha256(stableStringify(snapshot))}`;
  return succeeded(snapshot, normalized.warnings);
}

export function assertEnumCoverage() {
  return {
    rails: [...PAYMENT_RAILS],
    canonical_rails: [...CANONICAL_PAYMENT_RAILS],
    statuses: [...PAYMENT_STATUSES],
    source_types: [...SOURCE_TYPES],
    verification_statuses: [...VERIFICATION_STATUSES],
    risk_severities: [...RISK_SEVERITIES],
    scopes: [...PAIRING_SCOPES],
    networks: [...SUPPORTED_NETWORKS]
  };
}

function normalizePayment(payment, options = {}) {
  const warnings = [];
  const blocked = detectUnsupportedTransferTarget(payment);
  if (blocked.blocked) {
    return failed(protocolError(blocked.code, blocked.message, {
      field: "payment",
      rail: payment.rail,
      network: payment.network,
      asset: payment.asset
    }));
  }
  const rail = String(payment.rail || "");
  if (!PAYMENT_RAILS.includes(rail)) {
    return failed(protocolError("unsupported_rail", "Payment rail is not supported", {
      field: "payment.rail",
      rail
    }));
  }

  if (!payment.to) {
    return failed(protocolError("invalid_payment_request", "payment.to is required", {
      field: "payment.to"
    }));
  }

  if (typeof payment.amount !== "string" || !DECIMAL_STRING.test(payment.amount)) {
    return failed(protocolError("invalid_decimal_string", "payment.amount must be a decimal string", {
      field: "payment.amount",
      received_type: typeof payment.amount
    }));
  }
  // Amount > 0 without floating point. DECIMAL_STRING already proved the value is
  // a non-negative base-10 string (no sign, no leading zeros), so it equals zero
  // iff it contains no non-zero digit — a pure string test that honors the
  // never-float64 money rule. (The old Number(amount) <= 0 round-tripped money
  // through a double, which the rest of the stack is careful never to do.)
  if (!/[1-9]/.test(payment.amount)) {
    return failed(protocolError("invalid_decimal_string", "payment.amount must be greater than zero", {
      field: "payment.amount"
    }));
  }

  const recipient = normalizeRecipientVersionV1({
    rail: payment.rail,
    network: payment.network,
    asset: payment.asset,
    address: payment.to,
    contract: payment.token_contract ?? payment.contract,
    issuer: payment.issuer,
    memo: payment.memo ?? payment.tag,
    metadata: payment.metadata,
    display: payment.display,
    chain_id: payment.chain_id
  }, { requireExplicitBindings: true });
  if (!recipient.ok) {
    return failed(protocolError(recipient.error.code, recipient.error.message, {
      ...recipient.error.details,
      field: `payment.${recipient.error.field}`
    }));
  }
  payment = {
    ...payment,
    network: recipient.value.network,
    asset: recipient.value.asset,
    to: recipient.value.address,
    memo: recipient.value.memo,
    ...(recipient.value.contract ? { token_contract: recipient.value.contract } : {}),
    ...(recipient.value.issuer ? { issuer: recipient.value.issuer } : {})
  };

  if (rail === "stellar_xlm") return normalizeStellarXlm(payment);
  if (rail === "base_usdc" || rail === "evm_erc20") return normalizeBaseUsdc(payment, rail, options, warnings);
  return normalizeRegisteredTransferAsset(payment, options, warnings);
}

function normalizeBaseUsdc(payment, rail, options, warnings) {
  if (rail === "evm_erc20") {
    warnings.push(protocolError("legacy_rail_alias", "evm_erc20 is accepted as a migration alias for base_usdc", {
      field: "payment.rail",
      canonical_rail: "base_usdc"
    }));
  }

  if (payment.network !== "base_mainnet") {
    return failed(protocolError("unsupported_network", "Base USDC is supported only on base_mainnet", {
      field: "payment.network",
      network: payment.network
    }));
  }
  if (options.enabledNetworks && !options.enabledNetworks.includes("base_mainnet")) {
    return failed(protocolError("network_disabled", "base_mainnet is supported but disabled for this wallet", {
      field: "payment.network",
      network: "base_mainnet"
    }));
  }
  if (String(payment.asset || "").toUpperCase() !== "USDC") {
    return failed(protocolError("unsupported_asset", "Base rail supports only USDC", {
      field: "payment.asset",
      asset: payment.asset
    }));
  }
  if (Number(payment.chain_id) !== 8453) {
    return failed(protocolError("invalid_chain_id", "Base USDC chain_id must be 8453", {
      field: "payment.chain_id",
      chain_id: payment.chain_id
    }));
  }
  if (String(payment.token_contract || "").toLowerCase() !== BASE_USDC_CONTRACT.toLowerCase()) {
    return failed(protocolError("invalid_token_contract", "Base USDC token contract is not allowlisted", {
      field: "payment.token_contract",
      token_contract: payment.token_contract
    }));
  }
  if (Number(payment.decimals) !== 6) {
    return failed(protocolError("invalid_decimals", "Base USDC decimals must be 6", {
      field: "payment.decimals",
      decimals: payment.decimals
    }));
  }
  if (!EVM_ADDRESS.test(payment.to)) {
    return failed(protocolError("invalid_recipient", "Base USDC recipient must be an EVM 0x address", {
      field: "payment.to"
    }));
  }

  return succeeded({
    ...payment,
    rail: "base_usdc",
    network: "base_mainnet",
    asset: "USDC",
    amount: payment.amount,
    to: payment.to,
    chain_id: 8453,
    token_contract: BASE_USDC_CONTRACT,
    decimals: 6
  }, warnings);
}

function normalizeStellarXlm(payment) {
  if (!["stellar_public", "stellar_testnet"].includes(payment.network)) {
    return failed(protocolError("unsupported_network", "Stellar XLM requires stellar_public or stellar_testnet", {
      field: "payment.network",
      network: payment.network
    }));
  }
  if (String(payment.asset || "").toUpperCase() !== "XLM") {
    return failed(protocolError("unsupported_asset", "Stellar rail supports only XLM", {
      field: "payment.asset",
      asset: payment.asset
    }));
  }
  if (!STELLAR_PUBLIC_KEY.test(payment.to)) {
    return failed(protocolError("invalid_recipient", "Stellar XLM recipient must be a Stellar G... public key", {
      field: "payment.to"
    }));
  }
  return succeeded({
    ...payment,
    rail: "stellar_xlm",
    asset: "XLM",
    amount: payment.amount,
    to: payment.to
  });
}

function normalizeRegisteredTransferAsset(payment, options, warnings) {
  const asset = findSupportedTransferAsset(payment);
  if (!asset) {
    return failed(protocolError("unsupported_asset", "Payment asset is not registered for v1 real transfers", {
      field: "payment.asset",
      rail: payment.rail,
      network: payment.network,
      asset: payment.asset
    }));
  }
  if (payment.network !== asset.network) {
    return failed(protocolError("unsupported_network", `${asset.symbol} is supported only on ${asset.network}`, {
      field: "payment.network",
      network: payment.network,
      expected_network: asset.network
    }));
  }
  if (options.enabledNetworks && !options.enabledNetworks.includes(asset.network)) {
    return failed(protocolError("network_disabled", `${asset.network} is supported but disabled for this wallet`, {
      field: "payment.network",
      network: asset.network
    }));
  }
  if (String(payment.asset || "").toUpperCase() !== asset.symbol) {
    return failed(protocolError("unsupported_asset", `${asset.chain} rail supports only ${asset.symbol}`, {
      field: "payment.asset",
      asset: payment.asset,
      expected_asset: asset.symbol
    }));
  }
  if (asset.chain_id !== undefined && Number(payment.chain_id) !== Number(asset.chain_id)) {
    return failed(protocolError("invalid_chain_id", `${asset.chain} chain_id must be ${asset.chain_id}`, {
      field: "payment.chain_id",
      chain_id: payment.chain_id,
      expected_chain_id: asset.chain_id
    }));
  }
  if (asset.token_contract && String(payment.token_contract || "").toLowerCase() !== asset.token_contract.toLowerCase()) {
    return failed(protocolError("invalid_token_contract", `${asset.chain} ${asset.symbol} token contract is not allowlisted`, {
      field: "payment.token_contract",
      token_contract: payment.token_contract
    }));
  }
  if (asset.decimals !== undefined && payment.decimals !== undefined && Number(payment.decimals) !== Number(asset.decimals)) {
    return failed(protocolError("invalid_decimals", `${asset.chain} ${asset.symbol} decimals must be ${asset.decimals}`, {
      field: "payment.decimals",
      decimals: payment.decimals,
      expected_decimals: asset.decimals
    }));
  }
  if (!validateTransferAddress(asset, payment.to)) {
    return failed(protocolError("invalid_recipient", `${asset.chain} ${asset.symbol} recipient address is invalid`, {
      field: "payment.to",
      chain_family: asset.family
    }));
  }
  const preparedPayload = firstNonEmptyValue(payment.signing_payload, payment.unsigned_payload, payment.payload);
  const broadcastUrl = firstNonEmptyValue(payment.broadcast_url, payment.submit_url);
  if (asset.execution_mode === "prepared_payload") {
    if (!nonEmptyString(preparedPayload)) {
      return failed(protocolError("prepared_payload_required", `${asset.chain} ${asset.symbol} requires a prepared unsigned transaction payload for local signing`, {
        field: "payment.signing_payload",
        rail: asset.rail,
        execution_mode: asset.execution_mode
      }));
    }
    if (!nonEmptyString(broadcastUrl)) {
      return failed(protocolError("broadcast_url_required", `${asset.chain} ${asset.symbol} requires a broadcast URL for the signed prepared payload`, {
        field: "payment.broadcast_url",
        rail: asset.rail,
        execution_mode: asset.execution_mode
      }));
    }
  }

  const adapterWarning = transferAssetAdapterWarning(asset);
  if (adapterWarning) warnings.push(protocolError(adapterWarning.code, adapterWarning.message, adapterWarning.details));

  return succeeded({
    ...payment,
    rail: asset.rail,
    network: asset.network,
    asset: asset.symbol,
    amount: payment.amount,
    to: payment.to,
    chain_family: asset.family,
    signer_status: asset.signer_status,
    execution_mode: asset.execution_mode,
    key_curve: asset.key_curve,
    ...(asset.coin_type !== undefined ? { coin_type: asset.coin_type } : {}),
    ...(asset.execution_mode === "prepared_payload" ? {
      signing_payload: String(preparedPayload).trim(),
      signing_payload_encoding: String(firstNonEmptyValue(payment.signing_payload_encoding, payment.payload_encoding, "hex")).trim().toLowerCase(),
      signing_payload_is_digest: Boolean(payment.signing_payload_is_digest || payment.payload_is_digest),
      broadcast_url: String(broadcastUrl).trim()
    } : {}),
    decimals: asset.decimals,
    ...(asset.chain_id !== undefined ? { chain_id: asset.chain_id } : {}),
    ...(asset.token_contract ? { token_contract: asset.token_contract } : {})
  }, warnings);
}

function requireEqual(actual, expected, field, expectedValue, errors) {
  if (actual !== expected) {
    errors.push(protocolError(field === "protocol" ? "invalid_protocol" : "invalid_value", `${field} must be ${expectedValue}`, {
      field,
      expected: expectedValue,
      received: actual
    }));
  }
}

function requireString(value, field, errors, code = "invalid_payment_request") {
  if (!nonEmptyString(value)) {
    errors.push(protocolError(code, `${field} is required`, { field }));
  }
}

function requireIsoTimestamp(value, field, errors) {
  if (!nonEmptyString(value) || !ISO_8601_INSTANT.test(value.trim()) || Number.isNaN(Date.parse(value))) {
    errors.push(protocolError("invalid_timestamp", `${field} must be an ISO 8601 timestamp with a timezone, e.g. 2026-06-20T12:34:56Z`, { field, value }));
  }
}

function normalizeArray(value, field, errors) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(protocolError("invalid_array", `${field} must be an array`, { field }));
    return [];
  }
  return value.map((item) => isRecord(item) ? { ...item } : item);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function firstNonEmptyValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim().length > 0) return value;
  }
  return "";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeNow(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "string" || typeof now === "number") return new Date(now).getTime();
  return Date.now();
}

function failed(error, errors = [error]) {
  return { ok: false, error, errors };
}

function succeeded(value, warnings = []) {
  return { ok: true, value, warnings };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
