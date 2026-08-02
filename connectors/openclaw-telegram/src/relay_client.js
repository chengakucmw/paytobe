import crypto from "crypto";

export async function submitPaymentIntent(intent) {
  const deviceId = process.env.OPENCLAW_DEVICE_ID || "";
  if (!deviceId) {
    throw new Error("OPENCLAW_DEVICE_ID must be set before submitting an OpenClaw intent to the relay (no demo device fallback).");
  }
  const relayUrl = (process.env.VELARUMPAY_API_BASE_URL || process.env.AGENTWALLET_RELAY_URL || process.env.BASE_URL || "http://localhost:8787").replace(/\/+$/, "");
  const body = JSON.stringify(intent);
  const secret = process.env.OPENCLAW_DEVICE_SECRET || "";

  // Replay protection: bind a fresh timestamp + one-time nonce INTO the signed
  // material so the relay can reject a captured-and-resent request. The relay
  // rebuilds the same canonical string (openClawCanonicalPayload in the
  // platform-api crypto module) and checks the timestamp window + the nonce.
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString("hex");
  const canonical = `${timestamp}.${nonce}.${body}`;
  const signature = secret
    ? `sha256=${crypto.createHmac("sha256", secret).update(canonical).digest("hex")}`
    : "";
  const response = await fetch(`${relayUrl}/v1/payment-intents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-device-id": deviceId,
      "x-idempotency-key": intent.idempotency_key || "",
      "x-timestamp": timestamp,
      "x-nonce": nonce,
      "x-signature": signature
    },
    body
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Relay HTTP ${response.status}: ${text}`);
  return JSON.parse(text);
}

