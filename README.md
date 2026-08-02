# VelarumPayCode

> **Last modified / 最后修改时间**
> - **Taipei Time / 台北时间:** 2026-07-21 21:50:07 Asia/Taipei (UTC+08:00)
> - **UTC / 协调世界时:** 2026-07-21 13:50:07 UTC


VelarumPayCode is the clean development repository for VelarumPay.

VelarumPay is a non-custodial wallet and payment request platform for local AI agents. Agents can request payments, but the user reviews and signs from their own wallet.

## Active Structure

```text
apps/android                 Android wallet app
apps/ios                     iOS wallet app
apps/website                 VelarumPay website
services/platform-api        Current relay backend, evolving into Platform API
connectors/openclaw-telegram OpenClaw Telegram connector
examples                     Demo and integration examples
packages                     Future shared protocol and SDK packages
scripts                      Development, deploy, and release scripts
tests                        Cross-component tests
```

## Current Mainline

- Android source was copied from `agentwallet/android-agent-relay-v1-ui-optimized-v5-order-media`.
- iOS source was copied from `agentwallet/ios-VelarumPay`.
- Backend source was copied from `agentwallet/relay-backend-v1`.
- Website source now lives in `VelarumPayCode/apps/website`.
- OpenClaw connector was copied from `agentwallet/openclaw-telegram-skill-v1`.

Generated files, logs, `.env`, APKs, build folders, Gradle caches, and `node_modules` were intentionally excluded.

## Product Workspace

Formal product, design, architecture, engineering, operations, and task-card documents are kept outside this repo at:

```text
/Users/yang/code/VelarumPay/docs
```

This code repository should keep only concise READMEs that are needed to build, run, test, or understand nearby code. Do not add formal documentation, prototypes, UI design files, screenshots, or design assets here.

Key formal engineering docs:

- `/Users/yang/code/VelarumPay/docs/English/Architecture/00056-00003-00019-2-velarumpay-v0-1-engineering-baseline-2026-06-16.md`
- `/Users/yang/code/VelarumPay/docs/English/Architecture/00056-00003-00013-2-velarumpay-platform-api-v0-1-engineering-contract-2026-06-16.md`
- `/Users/yang/code/VelarumPay/docs/English/Architecture/00056-00003-00012-2-velarumpay-payment-request-v1-engineering-spec-2026-06-16.md`
- `/Users/yang/code/VelarumPay/docs/English/task/00056-00012-00001-2-00-velarumpay-v0-1-development-execution-task-index-2026-06-16.md`

## Next Engineering Goal

Build VelarumPay Open Platform v0.1:

1. Standardize `velarum.payment_request.v1`.
2. Add local agent to wallet pairing.
3. Convert wallet inbox from demo-specific intent handling to generic payment request handling.
4. Keep transaction contexts generic (for example `metadata.food_order`) instead of hard-coding app-specific demo flows.
5. Add MCP / OpenClaw / Hermes connectors around the same protocol.

## Useful Commands

Backend:

```bash
cd services/platform-api
npm install
cp .env.example .env
npm start
```

OpenClaw connector:

```bash
cd connectors/openclaw-telegram
npm install
cp .env.example .env
npm start
```

Website:

```bash
cd apps/website
node server.mjs
```

Android:

```bash
cd apps/android
./gradlew assembleDebug
```

Release gate:

```bash
npm run release:gate
```

The release gate runs workspace checks, unit tests, quickstart smoke, cross-component smoke, Android `testDebugUnitTest` + `assembleDebug`, and the iOS simulator build. For non-release local checks on a machine without mobile toolchains, run `npm run release:gate -- --node-only`.
