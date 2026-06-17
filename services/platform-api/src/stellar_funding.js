import crypto from "crypto";

const PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const VERSION_PUBLIC_KEY = 6 << 3;
const VERSION_SEED = 18 << 3;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export async function maybeFundDemoAccount(session, env = process.env) {
  if (env.DEMO_STELLAR_FUNDING_ENABLED !== "true") {
    return { status: "not_configured", reason: "DEMO_STELLAR_FUNDING_ENABLED is not true" };
  }
  if (!env.DEMO_STELLAR_FUNDER_SEED) {
    return { status: "not_configured", reason: "DEMO_STELLAR_FUNDER_SEED is missing" };
  }
  if (!session.stellar_address) {
    return { status: "skipped", reason: "No Stellar address was supplied by the app" };
  }

  const horizonUrl = (env.DEMO_STELLAR_HORIZON_URL || env.STELLAR_HORIZON_URL || "https://horizon.stellar.org").replace(/\/+$/, "");
  const testnet = horizonUrl.includes("testnet") || env.STELLAR_NETWORK === "stellar_testnet";
  const amount = env.DEMO_STELLAR_FUND_AMOUNT_XLM || "2.0000000";

  try {
    const txHash = await sendXlmFunding({
      seed: env.DEMO_STELLAR_FUNDER_SEED,
      destination: session.stellar_address,
      amount,
      horizonUrl,
      testnet
    });
    return {
      status: "submitted",
      asset: "XLM",
      amount,
      horizon_url: horizonUrl,
      tx_hash: txHash,
      submitted_at: new Date().toISOString()
    };
  } catch (error) {
    return {
      status: "failed",
      asset: "XLM",
      amount,
      horizon_url: horizonUrl,
      error: error.message,
      failed_at: new Date().toISOString()
    };
  }
}

async function sendXlmFunding({ seed, destination, amount, horizonUrl, testnet }) {
  const sourceSeed = decodeSeed(seed);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, sourceSeed]),
    format: "der",
    type: "pkcs8"
  });
  const sourcePublic = rawPublicKey(privateKey);
  const sourceAddress = encodeCheck(VERSION_PUBLIC_KEY, sourcePublic);
  const destinationPublic = decodePublicKey(destination);
  const sequence = (await fetchSequence(horizonUrl, sourceAddress)) + 1n;
  const destinationExists = await accountExists(horizonUrl, destination);
  const tx = transactionXdr({
    sourcePublic,
    destinationPublic,
    sequence,
    amountStroops: decimalToUnits(amount, 7),
    createAccount: !destinationExists
  });
  const networkHash = sha256(Buffer.from(testnet ? TESTNET_PASSPHRASE : PUBLIC_PASSPHRASE, "utf8"));
  const signatureBase = Buffer.concat([networkHash, int32(2), tx]);
  const txHashBytes = sha256(signatureBase);
  const signature = crypto.sign(null, txHashBytes, privateKey);
  const envelope = envelopeXdr(tx, sourcePublic, signature);
  const envelope64 = envelope.toString("base64");
  const body = `tx=${encodeURIComponent(envelope64)}`;
  const response = await fetch(`${horizonUrl}/transactions`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Horizon HTTP ${response.status}: ${text}`);
  const data = JSON.parse(text);
  return data.hash || txHashBytes.toString("hex");
}

async function fetchSequence(horizonUrl, accountId) {
  const response = await fetch(`${horizonUrl}/accounts/${accountId}`);
  const text = await response.text();
  if (!response.ok) throw new Error(`Funder account lookup failed: HTTP ${response.status}: ${text}`);
  return BigInt(JSON.parse(text).sequence);
}

async function accountExists(horizonUrl, accountId) {
  const response = await fetch(`${horizonUrl}/accounts/${accountId}`);
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Destination account lookup failed: HTTP ${response.status}: ${await response.text()}`);
  return true;
}

function transactionXdr({ sourcePublic, destinationPublic, sequence, amountStroops, createAccount }) {
  const chunks = [];
  writeMuxedAccount(chunks, sourcePublic);
  chunks.push(int32(100));
  chunks.push(int64(sequence));
  chunks.push(int32(0));
  chunks.push(int32(0));
  chunks.push(int32(1));
  chunks.push(int32(0));
  if (createAccount) {
    chunks.push(int32(0));
    writeAccountId(chunks, destinationPublic);
    chunks.push(int64(amountStroops));
  } else {
    chunks.push(int32(1));
    writeMuxedAccount(chunks, destinationPublic);
    chunks.push(int32(0));
    chunks.push(int64(amountStroops));
  }
  chunks.push(int32(0));
  return Buffer.concat(chunks);
}

function envelopeXdr(tx, sourcePublic, signature) {
  return Buffer.concat([
    int32(2),
    tx,
    int32(1),
    sourcePublic.subarray(28, 32),
    opaque(signature)
  ]);
}

function writeAccountId(chunks, publicKey) {
  chunks.push(int32(0));
  chunks.push(publicKey);
}

function writeMuxedAccount(chunks, publicKey) {
  chunks.push(int32(0));
  chunks.push(publicKey);
}

function opaque(value) {
  const padding = (4 - (value.length % 4)) % 4;
  return Buffer.concat([int32(value.length), value, Buffer.alloc(padding)]);
}

function int32(value) {
  const out = Buffer.alloc(4);
  out.writeInt32BE(value);
  return out;
}

function int64(value) {
  const out = Buffer.alloc(8);
  out.writeBigInt64BE(BigInt(value));
  return out;
}

function rawPublicKey(privateKey) {
  const der = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return Buffer.from(der).subarray(-32);
}

function decodeSeed(value) {
  const decoded = base32Decode(value);
  if (decoded.length !== 35 || decoded[0] !== VERSION_SEED) throw new Error("Invalid Stellar funder seed");
  verifyChecksum(decoded);
  return decoded.subarray(1, 33);
}

function decodePublicKey(value) {
  const decoded = base32Decode(value);
  if (decoded.length !== 35 || decoded[0] !== VERSION_PUBLIC_KEY) throw new Error("Invalid Stellar destination address");
  verifyChecksum(decoded);
  return decoded.subarray(1, 33);
}

function encodeCheck(version, payload) {
  const versioned = Buffer.concat([Buffer.from([version]), payload]);
  const crc = crc16Xmodem(versioned);
  return base32NoPadding(Buffer.concat([versioned, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]));
}

function verifyChecksum(decoded) {
  const body = decoded.subarray(0, decoded.length - 2);
  const expected = crc16Xmodem(body);
  const actual = decoded[decoded.length - 2] | (decoded[decoded.length - 1] << 8);
  if (expected !== actual) throw new Error("Invalid Stellar checksum");
}

function base32Decode(input) {
  const clean = String(input || "").trim().replaceAll("=", "").toUpperCase();
  let buffer = 0;
  let bitsLeft = 0;
  const out = [];
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new Error("Invalid Stellar base32 character");
    buffer = (buffer << 5) | value;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      out.push((buffer >> (bitsLeft - 8)) & 0xff);
      bitsLeft -= 8;
    }
  }
  return Buffer.from(out);
}

function base32NoPadding(data) {
  let buffer = 0;
  let bitsLeft = 0;
  let out = "";
  for (const byte of data) {
    buffer = (buffer << 8) | byte;
    bitsLeft += 8;
    while (bitsLeft >= 5) {
      out += BASE32[(buffer >> (bitsLeft - 5)) & 31];
      bitsLeft -= 5;
    }
  }
  if (bitsLeft > 0) out += BASE32[(buffer << (5 - bitsLeft)) & 31];
  return out;
}

function crc16Xmodem(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc & 0xffff;
}

function decimalToUnits(value, scale) {
  const text = String(value || "0").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`Invalid XLM amount: ${text}`);
  const [whole, fraction = ""] = text.split(".");
  const padded = `${fraction}${"0".repeat(scale)}`.slice(0, scale);
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(padded || "0");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest();
}
