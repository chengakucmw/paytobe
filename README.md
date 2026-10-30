# Paytobe

> **Last modified**
> - **Taipei Time:** 2026-10-29 13:41:42 Asia/Taipei (UTC+08:00)
> - **UTC:** 2026-10-29 05:41:42 UTC

Paytobe is a non-custodial wallet and Payment Request platform for people,
local AI agents, and trusted applications. Agents and applications can request
wallet capabilities, while the user reviews the real transaction facts and
signs locally from their own wallet.

This repository contains the public Apache-2.0 source tree. It does not include
production credentials, private product documents, user data, signing material,
or private deployment and operations configuration.

## Security Model

- Private keys, seed phrases, and derived signing material remain on the user's device.
- The Platform API validates, routes, stores request state, and synchronizes status; it does not sign user transactions.
- Agent and application connections are scoped, revocable, and unable to grant themselves signing authority.
- Payment facts such as network, asset, amount, recipient, contract or issuer, memo, and fee outrank display or metadata text.
- Real payments require user review and approval by default.

Please report vulnerabilities through GitHub private vulnerability reporting as described in [SECURITY.md](SECURITY.md).

## Repository Structure

```text
apps/android                 Android wallet app
apps/ios                     iOS wallet app
apps/website                 Paytobe website
services/platform-api        Current relay backend, evolving into Platform API
connectors/openclaw-telegram OpenClaw Telegram connector
examples                     Demo and integration examples
packages                     Shared protocol and SDK packages
scripts                      Development, deploy, and release scripts
tests                        Cross-component tests
```

Machine-readable protocol contracts live in `packages/protocol/schema`, and the
Platform API contract lives in `services/platform-api/openapi`. Concise module
READMEs document the nearby code. Private product specifications, prototypes,
screenshots, and operations material are intentionally outside this repository.

Generated files, logs, local `.env` files, APKs, build folders, dependency
caches, and `node_modules` are intentionally excluded.

## Current Scope

The v0.1 development tree includes:

- The versioned `Paytobe.payment_request.v1` protocol and Transaction Context.
- Scoped agent-to-wallet pairing and revocation.
- Native Android and iOS wallet clients backed by a shared Rust wallet core.
- The Platform API, JavaScript SDK, MCP server, OpenClaw connector, and Hermes connector.
- Website, developer documentation, merchant portal, examples, and cross-component tests.

The project is under active development. Review the applicable package README
and security boundaries before using it in a production or mainnet environment.

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
./gradlew testStandardDebugUnitTest assembleStandardDebug
```

Release gate:

```bash
npm run release:gate
```

The full release gate runs license and workspace checks, unit tests, quickstart
and cross-component smoke tests, Android builds, the controlled signed testnet
build, and iOS simulator tests. The signed build requires maintainer-managed
credentials. Contributors without the mobile toolchains or signing environment
can run `npm run release:gate -- --node-only`.

## Contributing and License

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. The source
code is licensed under [Apache-2.0](LICENSE). Paytobe names, logos, wordmarks,
and other brand identifiers are not granted for third-party use by that license;
see [NOTICE](NOTICE) for attribution and trademark boundaries.
