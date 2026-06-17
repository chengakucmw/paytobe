import crypto from "crypto";
import { buildPaymentIntent } from "./intent_builder.js";
import { parsePaymentCommand } from "./parser.js";
import { submitPaymentIntent } from "./relay_client.js";

const args = process.argv.slice(2);

if (args[0] === "--dry-run") {
  const text = args.slice(1).join(" ") || "send 1 USDC on Base to 0x0000000000000000000000000000000000000001";
  const payment = parsePaymentCommand(text);
  const intent = buildPaymentIntent(payment, {
    telegram_update_id: "dry-run",
    telegram_chat_id_hash: "sha256:dry-run",
    idempotency_key: `dry-run:${crypto.createHash("sha256").update(text).digest("hex")}`
  });
  console.log(JSON.stringify(intent, null, 2));
  process.exit(0);
}

const token = process.env.TELEGRAM_BOT_TOKEN || "";
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

let offset = 0;
console.log("OpenClaw AgentWallet Telegram skill started");

while (true) {
  try {
    const updates = await telegram("getUpdates", {
      offset,
      timeout: 25,
      allowed_updates: ["message"]
    });
    for (const update of updates.result || []) {
      offset = update.update_id + 1;
      await handleUpdate(update);
    }
  } catch (error) {
    console.error(error.message);
    await sleep(3000);
  }
}

async function handleUpdate(update) {
  const message = update.message || {};
  const chatId = String(message.chat?.id || "");
  if (!isAllowedChat(chatId)) {
    if (chatId) await sendMessage(chatId, "This Telegram chat is not allowed for AgentWallet payments.");
    return;
  }
  const text = message.text || "";
  if (!text) return;
  try {
    const payment = parsePaymentCommand(text);
    const intent = buildPaymentIntent(payment, {
      telegram_update_id: update.update_id,
      telegram_chat_id_hash: `sha256:${crypto.createHash("sha256").update(chatId).digest("hex")}`,
      idempotency_key: `telegram:${update.update_id}`
    });
    const result = await submitPaymentIntent(intent);
    await sendMessage(chatId, `Payment request sent to AgentWallet.\nIntent: ${result.intent.intent_id}\nOpen the app to review and tap Pay.`);
  } catch (error) {
    await sendMessage(chatId, `Payment request was not created: ${error.message}`);
  }
}

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function sendMessage(chatId, text) {
  await telegram("sendMessage", { chat_id: chatId, text });
}

function isAllowedChat(chatId) {
  const allowed = String(process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return allowed.length === 0 || allowed.includes(chatId);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

