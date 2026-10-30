import { isPublicAddress, normalizeDomain } from "../../application/merchant-domains/service.js";

const MAX_RESPONSE_BYTES = 8 * 1024;

export class WebhookEndpointVerifier {
  constructor({ resolver, fetcher }) {
    if (!resolver || !fetcher) throw new TypeError("Webhook resolver and fetcher are required");
    this.resolver = resolver;
    this.fetcher = fetcher;
  }

  async inspect(value) {
    const url = normalizeWebhookUrl(value);
    const addresses = await resolvePublic(this.resolver, url.hostname);
    return { url: url.toString(), hostname: url.hostname, addresses };
  }

  async verifyChallenge(value, expectedChallengeHash, hash) {
    const url = normalizeWebhookUrl(value);
    const before = await resolvePublic(this.resolver, url.hostname);
    const challengeUrl = new URL(url);
    challengeUrl.searchParams.set("Paytobe_challenge", "1");
    const response = await this.fetcher.fetch(challengeUrl.toString(), {
      method: "GET",
      redirect: "manual",
      timeout_ms: 5_000,
      headers: { accept: "application/json", "user-agent": "Paytobe-Webhook-Verifier/1" }
    });
    if (response.status >= 300 && response.status < 400) return failed("webhook_redirect_forbidden", "Webhook verification redirects are forbidden");
    if (response.status !== 200) return failed("webhook_verification_failed", "Webhook verification endpoint did not return 200");
    const text = await readTextLimited(response);
    let payload;
    try { payload = JSON.parse(text); } catch { return failed("webhook_response_invalid", "Webhook verification response is invalid"); }
    const challenge = String(payload?.challenge || "").trim();
    if (!challenge || hash(challenge) !== expectedChallengeHash) return failed("webhook_challenge_mismatch", "Webhook ownership challenge did not match");
    const after = await resolvePublic(this.resolver, url.hostname);
    if (before.join(",") !== after.join(",")) return failed("webhook_dns_rebinding", "Webhook DNS addresses changed during verification");
    return { ok: true, evidence_digest: hash(`${url.hostname}:${before.join(",")}:${expectedChallengeHash}`) };
  }
}

export function normalizeWebhookUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw new TypeError("Webhook URL is invalid"); }
  if (url.protocol !== "https:") throw new TypeError("Webhook URL must use HTTPS");
  if (url.username || url.password) throw new TypeError("Webhook URL credentials are forbidden");
  if (url.port && url.port !== "443") throw new TypeError("Webhook URL must use standard HTTPS port 443");
  if (url.hash) throw new TypeError("Webhook URL fragments are forbidden");
  url.hostname = normalizeDomain(url.hostname);
  url.port = "";
  return url;
}

async function resolvePublic(resolver, hostname) {
  const addresses = [...new Set((await resolver.resolve(hostname)).map((value) => String(value).trim().toLowerCase()))].sort();
  if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) {
    throw Object.assign(new Error("Webhook hostname does not resolve to public addresses"), { code: "webhook_non_public_address" });
  }
  return addresses;
}

async function readTextLimited(response) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES) throw Object.assign(new Error("Webhook verification response is too large"), { code: "webhook_response_too_large" });
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw Object.assign(new Error("Webhook verification response is too large"), { code: "webhook_response_too_large" });
  }
  return text;
}

function failed(code, message) { return { ok: false, status: 422, code, message }; }
