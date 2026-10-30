const MAX_RESPONSE_BYTES = 8 * 1024;
const RESERVED_SUFFIX = /(?:^|\.)(?:localhost|local|internal|invalid|test|example)$|(?:^|\.)example\.(?:com|net|org)$/i;

export class MerchantDomainService {
  constructor({ repository, clock, random, hash, resolver, fetcher }) {
    for (const [name, value] of Object.entries({ repository, clock, random, hash, resolver, fetcher })) {
      if (!value) throw new TypeError(`Merchant domain ${name} dependency is required`);
    }
    this.repository = repository;
    this.clock = clock;
    this.random = random;
    this.hash = hash;
    this.resolver = resolver;
    this.fetcher = fetcher;
  }

  create(scope, input) {
    const domain = normalizeDomain(input?.domain);
    const method = normalizeMethod(input?.method);
    const challenge = this.random.opaqueToken("vdomain", 32);
    const at = this.clock.nowIso();
    const domainRecord = this.repository.create(scope, {
      domain_id: this.random.id("domain"),
      domain,
      method,
      challenge_hash: this.hash(challenge),
      status: "pending",
      version: 1,
      created_at: at,
      updated_at: at
    });
    return domainRecord
      ? { ok: true, merchant_domain: domainRecord, challenge, dns_name: `_Paytobe.${domain}`, https_url: verificationUrl(domain) }
      : conflict("domain_conflict", "Domain is already registered");
  }

  async verify(scope, domainId) {
    const record = this.repository.get(scope, domainId);
    if (!record) return notFound();
    if (!["pending", "reverification_required"].includes(record.status)) return conflict("domain_not_verifiable", "Domain is not awaiting verification");
    try {
      const before = await resolvePublic(this.resolver, record.domain);
      let proofHash = "";
      if (record.method === "dns_txt") {
        const values = await this.resolver.resolveTxt(`_Paytobe.${record.domain}`);
        const proof = values.find((value) => this.hash(String(value).trim()) === record.challenge_hash);
        if (!proof) return failed("domain_challenge_mismatch", "Domain challenge was not found");
        proofHash = this.hash(proof);
      } else {
        const response = await this.fetcher.fetch(verificationUrl(record.domain), { redirect: "manual", timeout_ms: 5_000 });
        if (response.status >= 300 && response.status < 400) return failed("domain_redirect_forbidden", "Domain verification redirects are forbidden");
        if (response.status !== 200) return failed("domain_http_failed", "Domain verification endpoint did not return 200");
        const text = await readTextLimited(response, MAX_RESPONSE_BYTES);
        let payload;
        try { payload = JSON.parse(text); } catch { return failed("domain_response_invalid", "Domain verification response is invalid"); }
        const proof = String(payload?.challenge || "").trim();
        if (!proof || this.hash(proof) !== record.challenge_hash) return failed("domain_challenge_mismatch", "Domain challenge did not match");
        proofHash = this.hash(proof);
      }
      const after = await resolvePublic(this.resolver, record.domain);
      if (before.join(",") !== after.join(",")) return failed("domain_dns_rebinding", "Domain addresses changed during verification");
      const verifiedAt = this.clock.nowIso();
      const evidenceDigest = this.hash(`${record.method}:${record.domain}:${before.join(",")}:${proofHash}`);
      const committed = this.repository.markVerified(scope, domainId, record.version, {
        verified_at: verifiedAt,
        evidence_digest: evidenceDigest,
        updated_at: verifiedAt
      });
      if (!committed) return conflict("domain_conflict", "Domain is already verified for another merchant");
      if (committed.reason === "merchant_not_activatable") {
        return conflict("merchant_not_activatable", "Merchant cannot be activated from its current verification state");
      }
      return {
        ok: true,
        merchant_domain: committed.merchant_domain,
        merchant: committed.merchant,
        merchant_activated: committed.merchant_activated
      };
    } catch (error) {
      if (error?.code === "response_too_large") return failed("domain_response_too_large", "Domain verification response is too large");
      return failed("domain_verification_failed", "Domain verification failed");
    }
  }

  beginReverification(scope, domainId) {
    const record = this.repository.get(scope, domainId);
    if (!record) return notFound();
    const challenge = this.random.opaqueToken("vdomain", 32);
    const at = this.clock.nowIso();
    const updated = this.repository.beginReverification(scope, domainId, record.version, this.hash(challenge), at);
    return updated ? { ok: true, merchant_domain: updated, challenge } : conflict("concurrency_conflict", "Domain changed concurrently");
  }
}

export class SqliteMerchantDomainRepository {
  constructor(db) {
    if (!db) throw new TypeError("SQLite database is required");
    this.db = db;
    const columns = new Set(db.prepare("PRAGMA table_info(merchant_domains)").all().map((row) => row.name));
    if (!columns.has("evidence_digest")) db.exec("ALTER TABLE merchant_domains ADD COLUMN evidence_digest TEXT");
  }
  create(scope, value) {
    assertScope(scope);
    if (this.db.prepare("SELECT 1 FROM merchant_domains WHERE domain = ? AND status IN ('pending', 'verified', 'reverification_required')")
      .get(value.domain)) return null;
    this.db.prepare(`INSERT INTO merchant_domains
      (domain_id, merchant_id, domain, method, challenge_hash, status, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(value.domain_id, scope.merchant_id, value.domain, value.method, value.challenge_hash, value.status, value.version, value.created_at, value.updated_at);
    return this.get(scope, value.domain_id);
  }
  get(scope, id) {
    assertScope(scope);
    const row = this.db.prepare("SELECT * FROM merchant_domains WHERE merchant_id = ? AND domain_id = ?").get(scope.merchant_id, id);
    return row ? { ...row } : null;
  }
  markVerified(scope, id, version, value) {
    assertScope(scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`UPDATE merchant_domains SET status = 'verified', verified_at = ?, evidence_digest = ?,
        version = version + 1, updated_at = ? WHERE merchant_id = ? AND domain_id = ? AND version = ?
        AND status IN ('pending', 'reverification_required')`)
        .run(value.verified_at, value.evidence_digest, value.updated_at, scope.merchant_id, id, version);
      if (Number(result.changes || 0) !== 1) return rollbackNull(this.db);
      const merchantBefore = this.db.prepare(`SELECT merchant_id, display_name, legal_name, status, verification_state,
        version, created_at, updated_at FROM merchants WHERE merchant_id = ?`).get(scope.merchant_id);
      if (!merchantBefore) return rollbackNull(this.db);
      let merchantActivated = false;
      if (merchantBefore.status === "pending_verification") {
        if (merchantBefore.verification_state !== "email_verified") {
          this.db.exec("ROLLBACK");
          return { reason: "merchant_not_activatable" };
        }
        const activated = this.db.prepare(`UPDATE merchants SET status = 'active', verification_state = 'verified',
          version = version + 1, updated_at = ?
          WHERE merchant_id = ? AND status = 'pending_verification' AND verification_state = 'email_verified'`)
          .run(value.updated_at, scope.merchant_id);
        if (Number(activated.changes || 0) !== 1) return rollbackNull(this.db);
        merchantActivated = true;
      } else if (merchantBefore.status !== "active") {
        this.db.exec("ROLLBACK");
        return { reason: "merchant_not_activatable" };
      } else if (merchantBefore.verification_state !== "verified") {
        this.db.prepare(`UPDATE merchants SET verification_state = 'verified', version = version + 1, updated_at = ?
          WHERE merchant_id = ? AND status = 'active'`).run(value.updated_at, scope.merchant_id);
      }
      const merchantDomain = this.get(scope, id);
      const merchant = this.db.prepare(`SELECT merchant_id, display_name, legal_name, status, verification_state,
        version, created_at, updated_at FROM merchants WHERE merchant_id = ?`).get(scope.merchant_id);
      this.db.exec("COMMIT");
      return { merchant_domain: merchantDomain, merchant: { ...merchant }, merchant_activated: merchantActivated };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      if (String(error?.message || "").includes("UNIQUE constraint failed")) return null;
      throw error;
    }
  }
  beginReverification(scope, id, version, challengeHash, at) {
    assertScope(scope);
    const result = this.db.prepare(`UPDATE merchant_domains SET status = 'reverification_required', challenge_hash = ?,
      evidence_digest = NULL, version = version + 1, updated_at = ? WHERE merchant_id = ? AND domain_id = ? AND version = ?
      AND status IN ('verified', 'failed')`).run(challengeHash, at, scope.merchant_id, id, version);
    return Number(result.changes || 0) === 1 ? this.get(scope, id) : null;
  }
}

export class MemoryMerchantDomainRepository {
  create() { return null; }
  get() { return null; }
  markVerified() { return null; }
  beginReverification() { return null; }
}

export function normalizeDomain(value) {
  const input = String(value || "").normalize("NFKC").trim().replace(/\.$/, "");
  if (!input || input.includes("/") || input.includes("@") || input.includes(":")) throw new TypeError("Domain is invalid");
  let hostname;
  try { hostname = new URL(`https://${input}/`).hostname.toLowerCase(); } catch { throw new TypeError("Domain is invalid"); }
  if (hostname.length > 253 || !hostname.includes(".") || RESERVED_SUFFIX.test(hostname) || isIpAddress(hostname)) throw new TypeError("Domain is invalid");
  const labels = hostname.split(".");
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) throw new TypeError("Domain is invalid");
  return hostname;
}

export function isPublicAddress(address) {
  const value = String(address || "").trim().toLowerCase();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return isPublicIpv4(value);
  if (!value.includes(":")) return false;
  if (["::", "::1"].includes(value) || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value)
      || value.startsWith("2001:db8:") || value.startsWith("ff") || value.startsWith("::ffff:")) return false;
  return /^[0-9a-f:]+$/.test(value);
}

async function resolvePublic(resolver, domain) {
  const values = [...new Set((await resolver.resolve(domain)).map((value) => String(value).toLowerCase()))].sort();
  if (!values.length || values.some((value) => !isPublicAddress(value))) throw new Error("non_public_address");
  return values;
}

async function readTextLimited(response, limit) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > limit) throw Object.assign(new Error("response_too_large"), { code: "response_too_large" });
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Object.assign(new Error("response_too_large"), { code: "response_too_large" });
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > limit) throw Object.assign(new Error("response_too_large"), { code: "response_too_large" });
  return text;
}

function isPublicIpv4(value) {
  const octets = value.split(".").map(Number);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || b === 0 || (b === 0 && c === 2))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}
function isIpAddress(value) { return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) || value.includes(":"); }
function normalizeMethod(value) { const method = String(value || "dns_txt"); if (!["dns_txt", "https_well_known"].includes(method)) throw new TypeError("Domain method is invalid"); return method; }
function verificationUrl(domain) { return `https://${domain}/.well-known/Paytobe-domain-verification`; }
function assertScope(scope) { if (!scope || !Object.isFrozen(scope) || !scope.merchant_id) throw new TypeError("Immutable TenantScope is required"); }
function rollbackNull(db) { db.exec("ROLLBACK"); return null; }
function failed(code, message) { return { ok: false, status: 422, code, message }; }
function conflict(code, message) { return { ok: false, status: 409, code, message }; }
function notFound() { return { ok: false, status: 404, code: "resource_not_found", message: "Resource not found" }; }
