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

export function id(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
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
