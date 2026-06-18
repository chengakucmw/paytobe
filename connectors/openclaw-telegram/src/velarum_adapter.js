import crypto from "crypto";

export const PAYMENT_REQUEST_PROTOCOL = "velarum.payment_request.v1";
export const BASE_USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function buildPaymentRequestPayload(payment, source = {}, options = {}) {
  const normalizedPayment = normalizePayment(payment);
  const now = options.now ? new Date(options.now) : new Date();
  const expiresAt = source.expires_at || options.expires_at || new Date(now.getTime() + DEFAULT_TTL_MS).toISOString();
  const idempotencyKey = source.idempotency_key || source.idempotencyKey || deriveIdempotencyKey(normalizedPayment, source);
  const requestId = source.request_id || stableId("prq", idempotencyKey);
  const transactionId = source.transaction_id || stableId("txn", `${idempotencyKey}:context`);

  const request = {
    protocol: PAYMENT_REQUEST_PROTOCOL,
    request_id: requestId,
    connection_id: source.connection_id || process.env.VELARUMPAY_CONNECTION_ID || process.env.OPENCLAW_CONNECTION_ID || "conn_openclaw_telegram_demo",
    transaction_id: transactionId,
    created_at: source.created_at || now.toISOString(),
    expires_at: expiresAt,
    idempotency_key: idempotencyKey,
    status: "pending",
    source: buildSource(source),
    payee: buildPayee(payment, source),
    payment: normalizedPayment,
    display: buildDisplay(normalizedPayment, source),
    policy: {
      requires_user_approval: true,
      ...(source.policy || {})
    }
  };

  const metadata = buildMetadata(source);
  if (Object.keys(metadata).length) request.metadata = metadata;
  if (source.transaction_context_snapshot) {
    request.transaction_context_snapshot = source.transaction_context_snapshot;
  } else {
    // L5: real-time Telegram payments otherwise carry no transaction context, so the
    // wallet always shows "missing context". Attach a minimal, truthful context
    // derived from the payment itself. payee.verified is left exactly as buildPayee
    // resolved it — this fills the context gap, it never fabricates verification.
    request.transaction_context_snapshot = buildMinimalContextSnapshot(request, normalizedPayment);
  }

  return request;
}

export function buildVelarumRequest(payment, source = {}, options = {}) {
  const paymentRequest = options.paymentRequest || buildPaymentRequestPayload(payment, source, options);
  const request = buildLegacyVelarumEnvelope(paymentRequest, source);
  const canonical = JSON.stringify(request);
  const secret = process.env.VELARUM_SHARED_SECRET || "";
  const signature = secret
    ? `sha256=${crypto.createHmac("sha256", secret).update(canonical).digest("hex")}`
    : "";
  return {
    request_id: request.request_id,
    protocol: PAYMENT_REQUEST_PROTOCOL,
    payload: request,
    payload_hash: `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`,
    signature,
    payment_request: paymentRequest
  };
}

export function normalizePayment(payment = {}) {
  const rail = payment.rail === "evm_erc20" ? "base_usdc" : String(payment.rail || "");
  assertDecimalAmount(payment.amount);
  assertPresent(payment.to, "payment.to");

  if (rail === "base_usdc") {
    if (payment.network !== "base_mainnet") throw new Error("Base USDC requires network base_mainnet");
    if (String(payment.asset || "").toUpperCase() !== "USDC") throw new Error("Base USDC requires asset USDC");
    if (!/^0x[0-9a-fA-F]{40}$/.test(payment.to)) throw new Error("Base USDC recipient must be an EVM 0x address");
    if (payment.token_contract && String(payment.token_contract).toLowerCase() !== BASE_USDC_CONTRACT.toLowerCase()) {
      throw new Error("Base USDC token contract is not allowlisted");
    }
    if (payment.chain_id !== undefined && Number(payment.chain_id) !== 8453) {
      throw new Error("Base USDC chain_id must be 8453");
    }
    if (payment.decimals !== undefined && Number(payment.decimals) !== 6) {
      throw new Error("Base USDC decimals must be 6");
    }
    return compact({
      ...payment,
      rail: "base_usdc",
      network: "base_mainnet",
      asset: "USDC",
      amount: String(payment.amount),
      to: payment.to,
      token_contract: BASE_USDC_CONTRACT,
      chain_id: 8453,
      decimals: 6
    });
  }

  if (rail === "stellar_xlm") {
    if (!["stellar_public", "stellar_testnet"].includes(payment.network)) {
      throw new Error("Stellar XLM requires network stellar_public or stellar_testnet");
    }
    if (String(payment.asset || "").toUpperCase() !== "XLM") throw new Error("Stellar XLM requires asset XLM");
    if (!/^G[A-Z2-7]{55}$/.test(payment.to)) throw new Error("Stellar XLM recipient must be a Stellar G... public key");
    return compact({
      ...payment,
      rail: "stellar_xlm",
      network: payment.network,
      asset: "XLM",
      amount: String(payment.amount),
      to: payment.to
    });
  }

  throw new Error(`Unsupported payment rail: ${rail || "missing"}`);
}

function buildLegacyVelarumEnvelope(paymentRequest, source) {
  const payment = paymentRequest.payment;
  return {
    velarum_version: "1.0",
    protocol: PAYMENT_REQUEST_PROTOCOL,
    request_id: paymentRequest.request_id,
    transaction_id: paymentRequest.transaction_id,
    connection_id: paymentRequest.connection_id,
    invoice_id: `tg_${source.telegram_update_id || paymentRequest.request_id}`,
    recipient: {
      name: paymentRequest.payee.name,
      address: payment.to
    },
    asset: {
      rail: payment.rail,
      network: payment.network,
      symbol: payment.asset,
      contract: payment.token_contract || "",
      decimals: payment.decimals
    },
    amount: payment.amount,
    memo: payment.memo || "",
    expires_at: paymentRequest.expires_at,
    payment_request: paymentRequest
  };
}

function buildSource(source) {
  return compact({
    agent_id: source.agent_id || process.env.OPENCLAW_AGENT_ID || "agt_openclaw_telegram",
    agent_name: source.agent_name || process.env.OPENCLAW_AGENT_NAME || "OpenClaw Telegram",
    runtime: source.runtime || "openclaw",
    channel: source.channel || "telegram",
    device_id: process.env.OPENCLAW_DEVICE_ID || "mac-openclaw-01",
    telegram_chat_id_hash: source.telegram_chat_id_hash || ""
  });
}

function buildPayee(payment, source) {
  const metadata = source.metadata || {};
  const foodOrder = source.food_order || metadata.food_order || {};
  const restaurant = foodOrder.restaurant || {};
  return {
    name: source.payee?.name || source.payee_name || payment.payee_name || restaurant.name || "Telegram recipient",
    domain: source.payee?.domain || source.payee_domain || "",
    verified: Boolean(source.payee?.verified || source.payee_verified)
  };
}

function buildDisplay(payment, source) {
  const display = source.display || {};
  return {
    title: display.title || source.title || `Pay ${payment.amount} ${payment.asset}`,
    summary: display.summary || source.summary || "OpenClaw requested a payment from Telegram.",
    primary_action: display.primary_action || display.button || "Pay"
  };
}

function buildMetadata(source) {
  const metadata = { ...(source.metadata || {}) };
  if (source.food_order) {
    metadata.type = metadata.type || "food_order";
    metadata.food_order = source.food_order;
  }
  if (source.telegram_update_id || source.telegram_chat_id_hash) {
    metadata.openclaw = compact({
      telegram_update_id: source.telegram_update_id || "",
      telegram_chat_id_hash: source.telegram_chat_id_hash || ""
    });
    metadata.type = metadata.type || "openclaw_telegram";
  }
  return metadata;
}

function deriveIdempotencyKey(payment, source) {
  if (source.telegram_update_id) return `telegram:${source.telegram_update_id}`;
  const seed = JSON.stringify({
    rail: payment.rail,
    network: payment.network,
    asset: payment.asset,
    amount: payment.amount,
    to: payment.to,
    memo: payment.memo || ""
  });
  return `openclaw:${hash(seed).slice(0, 32)}`;
}

function stableId(prefix, seed) {
  return `${prefix}_${hash(seed || crypto.randomBytes(16).toString("hex")).slice(0, 24)}`;
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

// L5: build a minimal Transaction Context snapshot for OpenClaw payments that would
// otherwise arrive with no context. Mirrors the shape (and snapshot_hash scheme) of
// the protocol's createTransactionContextSnapshot so the wallet renders it normally,
// while keeping this connector self-contained (no protocol-package dependency). The
// truth fields are the literal transfer parameters, tagged as unverified facts of the
// payment request — context for the user to review, never a verification claim.
function buildMinimalContextSnapshot(request, payment) {
  const snapshot = {
    transaction_id: request.transaction_id,
    snapshot_created_at: request.created_at,
    truth_fields: [
      { field: "payment.amount", value: payment.amount, currency: payment.asset, source_type: "payment_request_fact", verification_status: "unverified" },
      { field: "payment.to", value: payment.to, source_type: "payment_request_fact", verification_status: "unverified" },
      { field: "payment.asset", value: `${payment.asset} on ${payment.network}`, source_type: "payment_request_fact", verification_status: "unverified" }
    ],
    evidence: [],
    missing_context: [],
    risk_findings: []
  };
  snapshot.snapshot_hash = `sha256:${hash(stableContextString(snapshot))}`;
  return snapshot;
}

// Deterministic (sorted-key) serialization used only for the snapshot hash above,
// matching the protocol package's stableStringify so hashes stay consistent.
function stableContextString(value) {
  if (Array.isArray(value)) return `[${value.map(stableContextString).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableContextString(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertPresent(value, field) {
  if (!value) throw new Error(`${field} is required`);
}

function assertDecimalAmount(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value) || Number(value) <= 0) {
    throw new Error("payment.amount must be a positive decimal string");
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== undefined && item !== null));
}
