import { assertTenantScope } from "../../ports/tenant-repository.js";

export const RECIPIENT_EVIDENCE_TYPES = Object.freeze([
  "domain_proof",
  "address_control",
  "reviewed_operational"
]);

export class SqliteRecipientEvidenceVerifier {
  constructor(db) {
    if (!db) throw new TypeError("SQLite database is required");
    this.db = db;
  }

  verify(scope, _recipientVersion, input, now) {
    assertTenantScope(scope);
    const type = String(input?.type || "").trim();
    const sourceId = String(input?.source_id || "").trim();
    if (!RECIPIENT_EVIDENCE_TYPES.includes(type) || !sourceId) return invalid("recipient_evidence_invalid", "Recipient evidence type or source is invalid");
    const source = this.db.prepare(`SELECT * FROM recipient_verification_sources
      WHERE merchant_id = ? AND source_id = ? AND type = ? AND status = 'verified'`)
      .get(scope.merchant_id, sourceId, type);
    if (!source) return notFound();
    if (source.verified_at > now) return invalid("clock_rollback_detected", "Evidence verification time is ahead of the trusted Clock", 409);
    if (source.expires_at && source.expires_at <= now) return invalid("recipient_evidence_expired", "Recipient evidence has expired", 409);
    return { ok: true, source: { ...source } };
  }
}

export class MemoryRecipientEvidenceVerifier {
  verify() { return invalid("recipient_evidence_unavailable", "Recipient evidence verification is unavailable", 503); }
}

function invalid(code, message, status = 422) { return { ok: false, status, code, message }; }
function notFound() { return invalid("resource_not_found", "Resource not found", 404); }
