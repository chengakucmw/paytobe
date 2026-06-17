import crypto from "crypto";

export function buildVelarumRequest(payment, source) {
  const request = {
    velarum_version: "1.0",
    request_id: `velarum_${crypto.randomBytes(12).toString("hex")}`,
    invoice_id: `tg_${source.telegram_update_id || Date.now()}`,
    recipient: {
      name: "Telegram recipient",
      address: payment.to
    },
    asset: {
      network: payment.network,
      symbol: payment.asset,
      contract: payment.token_contract || "",
      decimals: payment.decimals
    },
    amount: payment.amount,
    memo: payment.memo || "",
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
  };
  const canonical = JSON.stringify(request);
  const secret = process.env.VELARUM_SHARED_SECRET || "";
  const signature = secret
    ? `sha256=${crypto.createHmac("sha256", secret).update(canonical).digest("hex")}`
    : "";
  return {
    request_id: request.request_id,
    payload: request,
    payload_hash: `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`,
    signature
  };
}

