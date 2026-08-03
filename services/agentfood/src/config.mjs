import path from "node:path";
import { compareDecimal, normalizeDecimal } from "./money.mjs";

const OFFICIAL_TESTNET_HORIZON = "https://horizon-testnet.stellar.org";
const FORBIDDEN_KEY_ENV = [
  "AGENTFOOD_STELLAR_SECRET",
  "STELLAR_SECRET_KEY",
  "STELLAR_SEED",
  "AGENTFOOD_PRIVATE_KEY"
];
const FORBIDDEN_MAINNET_ENV = [
  "AGENTFOOD_STELLAR_MAINNET_ENABLED",
  "AGENTFOOD_STELLAR_MAINNET_MAX_XLM",
  "STELLAR_PUBLIC_ENABLED",
  "STELLAR_PUBLIC_HORIZON_URL"
];

export function loadConfig(env = process.env) {
  const runtimeEnv = String(env.AGENTFOOD_RUNTIME_ENV || env.NODE_ENV || "development").trim().toLowerCase();
  const production = runtimeEnv === "production";
  return {
    runtimeEnv,
    production,
    siteOnly: parseBool(env.AGENTFOOD_SITE_ONLY, false),
    port: positiveInt(env.PORT, 8791),
    publicBaseUrl: cleanUrl(env.AGENTFOOD_PUBLIC_BASE_URL || "http://127.0.0.1:8791"),
    domainVerificationChallenge: String(env.AGENTFOOD_DOMAIN_VERIFICATION_CHALLENGE || "").trim(),
    apiKey: String(env.AGENTFOOD_API_KEY || ""),
    storePath: String(env.AGENTFOOD_STORE_PATH || "data/agentfood-store.json").trim(),
    platform: {
      baseUrl: cleanUrl(env.PLATFORM_API_URL || "http://127.0.0.1:8787"),
      timeoutMs: positiveInt(env.PLATFORM_TIMEOUT_MS, 10_000),
      merchantId: String(env.AGENTFOOD_MERCHANT_ID || "agentfood").trim(),
      agentId: String(env.AGENTFOOD_AGENT_ID || "agentfood-testnet").trim(),
      clientId: String(env.AGENTFOOD_AGENT_CLIENT_ID || "agentfood-service").trim(),
      credentialKid: String(env.AGENTFOOD_AGENT_CREDENTIAL_KID || "").trim(),
      assertionAudience: String(env.AGENTFOOD_AGENT_ASSERTION_AUDIENCE || "https://api.velarumai.com/v1/agent-auth/token").trim(),
      signerConfigured: Boolean(String(env.AGENTFOOD_AGENT_CREDENTIAL_PRIVATE_KEY_PKCS8_B64 || "").trim()),
      scopes: [
        "payment.requests.create",
        "payment.requests.read",
        "transaction_contexts.create",
        "transaction_contexts.read"
      ]
    },
    webhook: {
      secret: String(env.AGENTFOOD_WEBHOOK_SECRET || "").trim(),
      toleranceSeconds: positiveInt(env.AGENTFOOD_WEBHOOK_TOLERANCE_SECONDS, 300)
    },
    stellar: {
      enabled: parseBool(env.AGENTFOOD_STELLAR_TESTNET_ENABLED, false),
      maxXlm: String(env.AGENTFOOD_STELLAR_TESTNET_MAX_XLM || "100").trim(),
      paymentAmountXlm: String(env.AGENTFOOD_STELLAR_PAYMENT_AMOUNT_XLM || "0.1").trim(),
      horizonUrl: cleanUrl(env.AGENTFOOD_STELLAR_HORIZON_URL || OFFICIAL_TESTNET_HORIZON),
      recipientId: String(env.AGENTFOOD_RECIPIENT_ID || "").trim(),
      recipientVersionId: String(env.AGENTFOOD_RECIPIENT_VERSION_ID || "").trim()
    },
    forbiddenKeyInputs: FORBIDDEN_KEY_ENV.filter((name) => String(env[name] || "").trim()).map((name) => name),
    forbiddenMainnetInputs: FORBIDDEN_MAINNET_ENV.filter((name) => String(env[name] || "").trim()).map((name) => name)
  };
}

export function validateConfig(config) {
  const errors = [];
  const max = normalizeDecimal(config.stellar.maxXlm);
  const amount = normalizeDecimal(config.stellar.paymentAmountXlm);

  if (config.forbiddenKeyInputs.length) {
    errors.push(`Private signing material is forbidden in AgentFood: ${config.forbiddenKeyInputs.join(", ")}`);
  }
  if (config.forbiddenMainnetInputs.length) {
    errors.push(`Mainnet configuration is forbidden in the official testnet environment: ${config.forbiddenMainnetInputs.join(", ")}`);
  }
  if (config.apiKey.length < 32) errors.push("AGENTFOOD_API_KEY must contain at least 32 characters.");
  if (!config.siteOnly) {
    if (!safeId(config.platform.merchantId)) errors.push("AGENTFOOD_MERCHANT_ID must be a stable identifier.");
    if (!safeId(config.platform.agentId)) errors.push("AGENTFOOD_AGENT_ID must be a stable identifier.");
    if (!safeId(config.platform.clientId)) errors.push("AGENTFOOD_AGENT_CLIENT_ID must be a stable identifier.");
    if (!safeId(config.platform.credentialKid)) errors.push("AGENTFOOD_AGENT_CREDENTIAL_KID must be configured.");
    if (!config.platform.signerConfigured) errors.push("AGENTFOOD_AGENT_CREDENTIAL_PRIVATE_KEY_PKCS8_B64 must configure the local Agent Assertion signer.");
    if (config.webhook.secret.length < 24) errors.push("AGENTFOOD_WEBHOOK_SECRET must contain at least 24 characters.");
    if (!config.stellar.enabled) errors.push("AGENTFOOD_STELLAR_TESTNET_ENABLED must be true for this connector.");
  }
  if (max === null || compareDecimal(max, "0") <= 0) {
    errors.push("AGENTFOOD_STELLAR_TESTNET_MAX_XLM must be a positive decimal.");
  }
  if (amount === null || compareDecimal(amount, "0") <= 0) {
    errors.push("AGENTFOOD_STELLAR_PAYMENT_AMOUNT_XLM must be a positive decimal.");
  } else if (max !== null && compareDecimal(amount, max) > 0) {
    errors.push("AGENTFOOD_STELLAR_PAYMENT_AMOUNT_XLM exceeds the configured testnet maximum.");
  }
  if (config.stellar.horizonUrl !== OFFICIAL_TESTNET_HORIZON) {
    errors.push(`AGENTFOOD_STELLAR_HORIZON_URL must be ${OFFICIAL_TESTNET_HORIZON}.`);
  }
  if (!config.siteOnly && !safeId(config.stellar.recipientId)) errors.push("AGENTFOOD_RECIPIENT_ID must identify a registered Recipient.");
  if (!config.siteOnly && !safeId(config.stellar.recipientVersionId)) errors.push("AGENTFOOD_RECIPIENT_VERSION_ID must identify an active Recipient version.");
  if (config.production) {
    if (!isHttpsUrl(config.publicBaseUrl)) errors.push("AGENTFOOD_PUBLIC_BASE_URL must use HTTPS in production.");
    if (!isHttpsUrl(config.platform.baseUrl)) errors.push("PLATFORM_API_URL must use HTTPS in production.");
    if (!path.isAbsolute(config.storePath)) errors.push("AGENTFOOD_STORE_PATH must be absolute in production.");
  } else if (!isHttpUrl(config.platform.baseUrl)) {
    errors.push("PLATFORM_API_URL must be an HTTP(S) URL.");
  }
  if (config.domainVerificationChallenge && !/^vdomain_[A-Za-z0-9_-]{43}$/.test(config.domainVerificationChallenge)) {
    errors.push("AGENTFOOD_DOMAIN_VERIFICATION_CHALLENGE must be a canonical domain challenge.");
  }

  return { ok: errors.length === 0, errors };
}

export function assertConfig(config) {
  const validation = validateConfig(config);
  if (!validation.ok) throw Object.assign(new Error(`AgentFood configuration is not deployable:\n- ${validation.errors.join("\n- ")}`), { validation });
  return validation;
}

export function configHealth(config) {
  const validation = validateConfig(config);
  const paymentValidation = validateConfig({ ...config, siteOnly: false });
  return {
    ok: validation.ok,
    runtime_env: config.runtimeEnv,
    production: config.production,
    site_only: config.siteOnly,
    site_ready: validation.ok,
    payment_ready: paymentValidation.ok,
    testnet_enabled: config.stellar.enabled,
    mainnet_forbidden: true,
    official_testnet_horizon: config.stellar.horizonUrl === OFFICIAL_TESTNET_HORIZON,
    recipient_configured: safeId(config.stellar.recipientId) && safeId(config.stellar.recipientVersionId),
    platform_agent_signer_configured: config.platform.signerConfigured,
    webhook_secret_configured: config.webhook.secret.length >= 24,
    store_path_absolute: path.isAbsolute(config.storePath),
    errors: validation.errors,
    payment_errors: paymentValidation.errors
  };
}

function cleanUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(String(value || ""));
}
