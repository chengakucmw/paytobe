import { createHash } from "node:crypto";

import { normalizeRecipientVersionV1 } from "../../../../../packages/protocol/src/recipient-validation.js";
import { findSupportedTransferAsset } from "../../../../../packages/protocol/src/transfer-assets.js";
import { assertTenantScope } from "../../ports/tenant-repository.js";

const AUTHORITATIVE_RECIPIENT_FIELD = /^(?:network|asset|recipient|recipient_id|address|to|contract|token_contract|issuer|memo|tag)$/i;
const CLIENT_PAYMENT_FIELDS = new Set(["amount"]);

export async function bindRecipientPaymentRequest({ recipientService, scope, input, hash = defaultHash }) {
  assertTenantScope(scope);
  if (!recipientService) throw new TypeError("Recipient service is required");
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid("invalid_payment_request", "Payment Request body must be an object");

  const recipientId = requiredText(input.recipient_id);
  if (!recipientId) return invalid("recipient_required", "recipient_id is required for a standard Payment Request");
  const requestedVersionId = optionalText(input.recipient_version_id);
  const suppliedPayment = input.payment;
  if (!suppliedPayment || typeof suppliedPayment !== "object" || Array.isArray(suppliedPayment)) {
    return invalid("invalid_payment_request", "payment.amount is required");
  }
  const override = Object.keys(suppliedPayment).find((field) => !CLIENT_PAYMENT_FIELDS.has(field));
  if (override) {
    return invalid("recipient_facts_override_forbidden", "Payment recipient facts are derived from recipient_version", 400, {
      field: `payment.${override}`
    });
  }
  const presentationOverride = findAuthoritativePresentationField(input.display, "display")
    || findAuthoritativePresentationField(input.metadata, "metadata");
  if (presentationOverride) {
    return invalid("authoritative_display_forbidden", "display and metadata cannot override Recipient facts", 400, {
      field: presentationOverride
    });
  }

  const selected = await recipientService.usableForNewRequest(scope, recipientId, requestedVersionId);
  if (!selected.ok) return selected;
  const normalized = normalizeRecipientVersionV1(selected.recipient_version);
  if (!normalized.ok) {
    return invalid(normalized.error.code, normalized.error.message, 409, {
      field: normalized.error.field,
      ...(normalized.error.details || {})
    });
  }
  const definition = findSupportedTransferAsset(normalized.value);
  if (!definition) return invalid("unsupported_recipient_version", "Recipient version is not supported for Payment Request v1", 409);

  const facts = Object.freeze({
    recipient_id: selected.recipient.recipient_id,
    recipient_version_id: selected.recipient_version.recipient_version_id,
    rail: normalized.value.rail,
    network: normalized.value.network,
    asset: normalized.value.asset,
    address: normalized.value.address,
    memo: normalized.value.memo,
    contract: normalized.value.contract || null,
    issuer: normalized.value.issuer || null
  });
  const factsHash = recipientPaymentFactsHash(facts, hash);
  const transactionId = transactionContextId(input);
  if (transactionId === null) {
    return invalid("transaction_context_mismatch", "transaction_id and transaction_context_ref must identify the same Transaction Context");
  }

  const payment = {
    amount: suppliedPayment.amount,
    rail: definition.rail,
    network: facts.network,
    asset: facts.asset,
    to: facts.address,
    memo: facts.memo
  };
  if (definition.chain_id !== undefined) payment.chain_id = definition.chain_id;
  if (definition.decimals !== undefined) payment.decimals = definition.decimals;
  if (facts.contract) payment.token_contract = facts.contract;
  if (facts.issuer) payment.issuer = facts.issuer;

  return {
    ok: true,
    value: {
      ...(input.expires_at ? { expires_at: input.expires_at } : {}),
      ...(transactionId ? { transaction_id: transactionId } : {}),
      ...(input.display !== undefined ? { display: input.display } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      payment,
      payee: {
        name: selected.recipient.name,
        verified: true,
        recipient_id: facts.recipient_id
      },
      policy: { requires_user_approval: true },
      recipient_id: facts.recipient_id,
      recipient_version_id: facts.recipient_version_id,
      recipient_facts_hash: factsHash,
      recipient_snapshot: facts
    },
    recipient: selected.recipient,
    recipient_version: selected.recipient_version,
    recipient_facts: facts,
    recipient_facts_hash: factsHash
  };
}

export function recipientPaymentFactsHash(facts, hash = defaultHash) {
  return hash(JSON.stringify([
    "velarum.recipient_payment_facts.v1",
    facts.recipient_id,
    facts.recipient_version_id,
    facts.rail,
    facts.network,
    facts.asset,
    facts.address,
    facts.memo ?? null,
    facts.contract ?? null,
    facts.issuer ?? null
  ]));
}

function transactionContextId(input) {
  const direct = optionalText(input.transaction_id);
  const referenced = optionalText(input.transaction_context_ref?.transaction_id);
  if (direct && referenced && direct !== referenced) return null;
  return direct || referenced || "";
}

function findAuthoritativePresentationField(value, prefix) {
  if (!value || typeof value !== "object") return "";
  for (const [key, nested] of Object.entries(value)) {
    const path = `${prefix}.${key}`;
    if (AUTHORITATIVE_RECIPIENT_FIELD.test(key)) return path;
    const found = findAuthoritativePresentationField(nested, path);
    if (found) return found;
  }
  return "";
}

function requiredText(value) { return String(value || "").trim(); }
function optionalText(value) { return value === undefined || value === null ? "" : String(value).trim(); }
function defaultHash(value) { return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`; }
function invalid(code, message, status = 400, details = {}) { return { ok: false, status, code, message, details }; }
