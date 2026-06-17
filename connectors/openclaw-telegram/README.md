# OpenClaw AgentWallet Telegram Skill

Local OpenClaw-side bridge for Telegram payment commands.

## Supported commands

```text
send 10 USDC on Base to 0x1111111111111111111111111111111111111111
send 25 XLM to GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF
转账 10 USDC 到 base 0x1111111111111111111111111111111111111111
转账 25 恒星币 到 G...
```

## Flow

1. Telegram message arrives.
2. Skill parses the payment command.
3. Skill creates a Velarum-style request payload.
4. Skill builds an AgentWallet `PaymentIntent`.
5. Skill signs the raw JSON body with `OPENCLAW_DEVICE_SECRET`.
6. Skill submits it to AgentWallet Relay.
7. AgentWallet App receives the WebSocket inbox notification.

## Run

```bash
cd /Users/yang/code/agentwallet/openclaw-telegram-skill-v1
cp .env.example .env
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_ALLOWED_CHAT_IDS=123456 \
AGENTWALLET_RELAY_URL=http://localhost:8787 \
OPENCLAW_DEVICE_SECRET=change-me-openclaw-secret \
TARGET_APP_DEVICE_ID=android-... \
npm start
```

Dry run:

```bash
node src/index.js --dry-run "send 1 USDC on Base to 0x0000000000000000000000000000000000000001"
```

