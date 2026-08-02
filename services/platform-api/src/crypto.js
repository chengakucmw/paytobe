import crypto from "crypto";

export function hmacHex(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyHmac(secret, payload, signature) {
  if (!secret) return false;
  if (!signature) return false;
  const clean = signature.replace(/^sha256=/, "");
  const expected = hmacHex(secret, payload);
  const a = Buffer.from(clean, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function signWebhookPayload(secret, timestamp, rawBody) {
  const key = String(secret || "");
  const instant = String(timestamp || "");
  if (!key || !/^\d{10,16}$/.test(instant)) throw new TypeError("Webhook secret and timestamp are required");
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const mac = crypto.createHmac("sha256", key)
    .update(Buffer.from(`${instant}.`, "utf8"))
    .update(body)
    .digest("hex");
  return `t=${instant},v1=${mac}`;
}

export function verifyWebhookSignature(secret, rawBody, signatureHeader) {
  const parts = Object.fromEntries(String(signatureHeader || "").split(",").map((part) => {
    const [key, ...value] = part.trim().split("=");
    return [key, value.join("=")];
  }));
  if (!parts.t || !/^[0-9a-f]{64}$/i.test(parts.v1 || "")) return false;
  let expected;
  try { expected = signWebhookPayload(secret, parts.t, rawBody).split("v1=")[1]; } catch { return false; }
  const left = Buffer.from(String(parts.v1), "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function id(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}

export function opaqueToken(prefix, bytes = 32) {
  return `${prefix}_${crypto.randomBytes(bytes).toString("base64url")}`;
}

export function createConnectKey() {
  return `velarumpay-connect:${opaqueToken("ck")}`;
}

// Canonical string that an OpenClaw HMAC signature is computed over. The
// timestamp and nonce are folded INTO the signed material (not merely sent
// alongside it), so an attacker cannot alter either without invalidating the
// signature — which is exactly what lets the relay use them for replay
// protection. The signer (connectors/openclaw-telegram/src/relay_client.js) and
// this verifier MUST build this string identically.
export function openClawCanonicalPayload(timestamp, nonce, body) {
  return `${timestamp}.${nonce}.${body ?? ""}`;
}

// Uniformly-distributed numeric code (e.g. a 6-digit pairing code). Uses
// crypto.randomInt, which rejection-samples internally, so unlike
// `parseInt(hex,16) % 10**digits` there is NO modulo bias and the value is
// cryptographically unpredictable.
export function randomNumericCode(digits = 6) {
  const max = 10 ** digits;
  return String(crypto.randomInt(0, max)).padStart(digits, "0");
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function tokenHash(value) {
  return `sha256:${sha256Hex(String(value || ""))}`;
}

export function verifyTokenHash(value, hash) {
  if (!value || !hash) return false;
  const expected = tokenHash(value);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(hash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function timingSafeTextEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createAes256GcmVault(encodedKey, purpose = "velarumpay.secret.v1") {
  const key = decodeAes256Key(encodedKey);
  const context = String(purpose || "velarumpay.secret.v1");
  return Object.freeze({
    encrypt(plaintext, binding = "") {
      const value = String(plaintext || "");
      if (!value) throw new TypeError("Secret plaintext is required");
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(`${context}\u0000${binding}`, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Object.freeze({
        version: 1,
        algorithm: "A256GCM",
        purpose: context,
        iv: iv.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url")
      });
    },
    decrypt(record, binding = "") {
      if (!record || record.version !== 1 || record.algorithm !== "A256GCM" || record.purpose !== context) {
        throw new TypeError("Encrypted secret record is unsupported");
      }
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(String(record.iv || ""), "base64url"));
      decipher.setAAD(Buffer.from(`${context}\u0000${binding}`, "utf8"));
      decipher.setAuthTag(Buffer.from(String(record.tag || ""), "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(String(record.ciphertext || ""), "base64url")),
        decipher.final()
      ]).toString("utf8");
    }
  });
}

function decodeAes256Key(value) {
  const input = String(value || "").trim();
  let key;
  if (/^[0-9a-f]{64}$/i.test(input)) key = Buffer.from(input, "hex");
  else if (/^[A-Za-z0-9_-]{43}$/.test(input)) key = Buffer.from(input, "base64url");
  else {
    try { key = Buffer.from(input, "base64"); } catch { key = Buffer.alloc(0); }
  }
  if (key.length !== 32) throw new TypeError("AES-256-GCM key must decode to exactly 32 bytes");
  return key;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function normalizeEd25519PublicKey(value) {
  const text = String(value || "").trim();
  if (!text || /PRIVATE KEY|SEED PHRASE|MNEMONIC/i.test(text)) throw new TypeError("Ed25519 public key is invalid");
  let key;
  if (/^-----BEGIN PUBLIC KEY-----/.test(text)) {
    key = crypto.createPublicKey(text);
    if (key.asymmetricKeyType !== "ed25519") throw new TypeError("Ed25519 public key is invalid");
    const jwk = key.export({ format: "jwk" });
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) throw new TypeError("Ed25519 public key is invalid");
    return normalizeRawEd25519Key(jwk.x);
  }
  return normalizeRawEd25519Key(text);
}

export function verifyEd25519Signature(publicKey, payload, signature) {
  try {
    const normalized = normalizeEd25519PublicKey(publicKey);
    const raw = Buffer.from(normalized, "base64url");
    const signatureBytes = decodeCanonicalBase64Url(signature, 64);
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki"
    });
    return crypto.verify(null, Buffer.from(String(payload || ""), "utf8"), key, signatureBytes);
  } catch {
    return false;
  }
}

function normalizeRawEd25519Key(value) {
  const raw = decodeCanonicalBase64Url(value, 32);
  return raw.toString("base64url");
}

function decodeCanonicalBase64Url(value, bytes) {
  const text = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.includes("=")) throw new TypeError("Non-canonical base64url value");
  const decoded = Buffer.from(text, "base64url");
  if (decoded.length !== bytes || decoded.toString("base64url") !== text) throw new TypeError("Invalid base64url length");
  return decoded;
}
