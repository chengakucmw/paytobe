const STELLAR_PUBLIC_KEY_VERSION = 6 << 3;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function isValidStellarPublicKey(value) {
  const text = String(value || "").trim().toUpperCase();
  if (!/^G[A-Z2-7]{55}$/.test(text)) return false;
  const decoded = decodeBase32(text);
  if (!decoded || decoded.length !== 35 || decoded[0] !== STELLAR_PUBLIC_KEY_VERSION) return false;
  const payload = decoded.subarray(0, 33);
  const checksum = crc16Xmodem(payload);
  return decoded[33] === (checksum & 0xff) && decoded[34] === ((checksum >>> 8) & 0xff);
}

function decodeBase32(value) {
  const output = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of value) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) return null;
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((accumulator >>> bits) & 0xff);
      accumulator &= bits ? (1 << bits) - 1 : 0;
    }
  }
  if (bits && accumulator !== 0) return null;
  return Uint8Array.from(output);
}

function crc16Xmodem(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc;
}
