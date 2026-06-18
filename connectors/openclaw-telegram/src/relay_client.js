import crypto from "crypto";

export async function submitPaymentIntent(intent) {
  const relayUrl = (process.env.VELARUMPAY_API_BASE_URL || process.env.AGENTWALLET_RELAY_URL || process.env.BASE_URL || "http://localhost:8787").replace(/\/+$/, "");
  const body = JSON.stringify(intent);
  const secret = process.env.OPENCLAW_DEVICE_SECRET || "";
  const signature = secret
    ? `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`
    : "";
  const response = await fetch(`${relayUrl}/v1/payment-intents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-device-id": process.env.OPENCLAW_DEVICE_ID || "mac-openclaw-01",
      "x-idempotency-key": intent.idempotency_key || "",
      "x-signature": signature
    },
    body
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Relay HTTP ${response.status}: ${text}`);
  return JSON.parse(text);
}

