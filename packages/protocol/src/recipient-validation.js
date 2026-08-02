import { validateNonAuthoritativeMetadata } from "./control-plane.js";
import { isValidStellarPublicKey } from "./stellar-address.js";
import {
  detectUnsupportedTransferTarget,
  findSupportedTransferAsset,
  validateTransferAddress
} from "./transfer-assets.js";

const ASCII_FACT = /^[\x20-\x7E]+$/;
const AUTHORITATIVE_FIELD = /^(?:network|asset|recipient|recipient_id|address|to|contract|token_contract|issuer|memo|tag)$/i;

export function normalizeRecipientVersionV1(input, options = {}) {
  if (!isRecord(input)) return invalid("invalid_recipient", "Recipient facts must be an object", "recipient");
  const override = authoritativeDisplayField(input.display);
  if (override) return invalid("authoritative_display_forbidden", "display cannot override authoritative recipient facts", `display.${override}`);
  const metadata = validateNonAuthoritativeMetadata(input.metadata);
  if (!metadata.ok) return invalid(metadata.error.code, metadata.error.message, metadata.error.field);

  const networkInput = requiredAscii(input.network, "network");
  if (!networkInput.ok) return networkInput;
  const assetInput = requiredAscii(input.asset, "asset");
  if (!assetInput.ok) return assetInput;
  const addressInput = requiredAscii(input.address ?? input.to, "address");
  if (!addressInput.ok) return addressInput;
  const network = networkInput.value.toLowerCase();
  const symbol = assetInput.value.toUpperCase();
  const rail = optionalAscii(input.rail, "rail");
  if (!rail.ok) return rail;

  const blocked = detectUnsupportedTransferTarget({ ...input, network, asset: symbol, address: addressInput.value });
  if (blocked.blocked) return invalid(blocked.code, blocked.message, "network");
  const definition = findSupportedTransferAsset({ rail: rail.value, network, asset: symbol, chain_id: input.chain_id });
  if (!definition) return invalid("unsupported_asset", "Recipient asset and network are not registered for v1 transfers", "asset", {
    network, asset: symbol
  });
  if (!definition.network_aliases.includes(network)) {
    return invalid("unsupported_network", `${definition.symbol} is not supported on ${network}`, "network", {
      expected_network: definition.network
    });
  }
  if (symbol !== definition.symbol) {
    return invalid("recipient_asset_mismatch", `${definition.chain} supports ${definition.symbol} for this rail`, "asset");
  }

  const contract = binding(input.contract ?? input.token_contract, definition.token_contract, "contract", options.requireExplicitBindings);
  if (!contract.ok) return contract;
  const issuer = binding(input.issuer, definition.issuer, "issuer", options.requireExplicitBindings);
  if (!issuer.ok) return issuer;
  if (definition.family === "stellar") {
    if (!isValidStellarPublicKey(addressInput.value)) {
      return invalid("invalid_recipient", "Stellar recipient must be a checksum-valid G... public key", "address");
    }
  } else if (!validateTransferAddress(definition, addressInput.value)) {
    return invalid("invalid_recipient", `${definition.chain} ${definition.symbol} recipient address is invalid`, "address", {
      chain_family: definition.family
    });
  }

  const memo = normalizeMemo(input.memo ?? input.tag, options.memoPolicy || definition.memo_policy);
  if (!memo.ok) return memo;
  const canonicalNetwork = network === "stellar_testnet" ? network : definition.network;
  const canonical = {
    rail: definition.rail,
    network: canonicalNetwork,
    asset: definition.symbol,
    address: addressInput.value,
    memo: memo.value,
    ...(definition.token_contract ? { contract: definition.token_contract } : {}),
    ...(definition.issuer ? { issuer: definition.issuer } : {})
  };
  return {
    ok: true,
    value: {
      ...canonical,
      display: Object.freeze({
        network: networkInput.value,
        asset: assetInput.value,
        address: addressInput.value,
        memo: memo.display
      })
    }
  };
}

function normalizeMemo(value, policy = { mode: "forbidden", max_bytes: 0, charset: "none" }) {
  const input = value === undefined || value === null ? "" : String(value).trim();
  if (input && input.normalize("NFKC") !== input) return invalid("recipient_unicode_confusable", "memo contains compatibility or confusable Unicode", "memo");
  if (policy.mode === "required" && !input) return invalid("recipient_memo_required", "memo or tag is required for this asset", "memo");
  if (policy.mode === "forbidden" && input) return invalid("recipient_memo_forbidden", "memo or tag is not supported for this asset", "memo");
  if (!input) return { ok: true, value: null, display: null };
  if (policy.charset === "digits" && !/^\d+$/.test(input)) {
    return invalid("recipient_memo_charset", "memo or tag must contain decimal digits only", "memo");
  }
  if (policy.charset === "printable_ascii" && !ASCII_FACT.test(input)) {
    return invalid("recipient_memo_charset", "memo contains unsupported characters", "memo");
  }
  if (new TextEncoder().encode(input).byteLength > Number(policy.max_bytes || 0)) {
    return invalid("recipient_memo_too_long", "memo or tag exceeds the asset limit", "memo", { max_bytes: policy.max_bytes });
  }
  if (policy.max_value !== undefined && BigInt(input) > BigInt(policy.max_value)) {
    return invalid("recipient_memo_out_of_range", "memo or tag exceeds the asset range", "memo", { max_value: policy.max_value });
  }
  return { ok: true, value: input, display: input };
}

function binding(value, expected, field, required) {
  const supplied = value === undefined || value === null || value === "" ? "" : String(value).trim();
  if (supplied) {
    const safe = requiredAscii(supplied, field);
    if (!safe.ok) return safe;
  }
  if (!expected && supplied) return invalid(`unexpected_${field}`, `${field} is forbidden for this asset`, field);
  if (expected && required && !supplied) return invalid(`invalid_${field}`, `${field} is required for this asset`, field);
  if (expected && supplied.toLowerCase() !== String(expected).toLowerCase()) {
    return invalid(`invalid_${field}`, `${field} does not match the registered asset`, field);
  }
  return { ok: true, value: expected || null };
}

function requiredAscii(value, field) {
  const result = optionalAscii(value, field);
  return result.ok && !result.value ? invalid("required_field", `${field} is required`, field) : result;
}
function optionalAscii(value, field) {
  if (value === undefined || value === null || value === "") return { ok: true, value: "" };
  const input = String(value).trim();
  if (!input || input.normalize("NFKC") !== input || !ASCII_FACT.test(input)) {
    return invalid("recipient_unicode_confusable", `${field} contains unsafe or confusable characters`, field);
  }
  return { ok: true, value: input };
}
function authoritativeDisplayField(value) {
  if (!isRecord(value)) return "";
  return Object.keys(value).find((field) => AUTHORITATIVE_FIELD.test(field)) || "";
}
function invalid(code, message, field, details = {}) {
  return { ok: false, error: { code, message, field, details } };
}
function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
