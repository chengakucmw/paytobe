# AgentFood Platform Agent Reference Demo

> **Last modified**
> - **Taipei Time:** 2026-08-03 14:23:45 Asia/Taipei (UTC+08:00)
> - **UTC:** 2026-08-03 06:23:45 UTC

This dependency-free example is a runnable external food-delivery platform and platform-owned Agent. It demonstrates the wallet-created, one-time Connect Key flow against a local VelarumPay Platform API.

The site contains three representative merchant cases:

- Green Bowl Kitchen
- Noodle Atelier
- Bento Harbor

All merchants, menus, prices, evidence, recipients, and orders are mock data. Payment Requests are labelled for Stellar testnet review. The example never reads private keys, never signs, and never broadcasts a transaction.

## Hosted preview

The public OpenAI Sites demo is available at:

<https://agentfood-velarumpay-demo.chengakucmw.chatgpt.site>

The browser calls only the AgentFood site's same-origin `/api/chat` and `/api/connect` endpoints. The hosted Worker source then calls the canonical Platform API with an Ed25519 Agent Assertion, a registered Agent identity, a standard Recipient, wallet-approved Connect, and standard Payment Request contracts. Its old local write routes return `410 legacy_agentfood_path_retired` and emit compatibility telemetry; only historical reads remain pending the removal gate. This task did not deploy that Worker, so the currently published preview must not be treated as migration evidence until deployment is separately authorized and verified.

The hosted deployment uses public Sites access so VelarumPay mobile clients can call the same cloud API without a Sites bypass credential.

Its interface now follows the AgentFood design system: the conversation is the primary product surface, supported by a focused restaurant list and payment-safety context. Desktop keeps the product and the food agent side by side; narrow screens place the conversation first. The visual system uses warm near-black and maroon surfaces, a single crimson-pink accent, pill controls, inset hairlines, restrained glow, and sentence-case product copy. Food and social-card imagery was generated specifically for this demo and is stored locally.

The site self-hosts Poppins, DM Sans, and JetBrains Mono from the official Google Fonts repository. All three are licensed under OFL-1.1, and their license files are preserved in `public/fonts/`. The site has no external image, font, icon, or runtime UI dependency.

OpenAI Sites provides the hosted browser sign-in boundary. The page's **Continue with Google** action starts the real Sign in with ChatGPT flow, where a visitor may use a Google-backed ChatGPT account. After sign-in, the dispatcher forwards the verified visitor identity to the worker and the header shows the visitor's name and email with a working sign-out action. This is not a separate app-owned Google OAuth client: Google credentials never reach AgentFood. Browser identity does not grant wallet authority and remains separate from the Connect Key capability flow.

## Run

Start the Platform API from the repository root:

```bash
npm --prefix services/platform-api start
```

Start the AgentFood site in another terminal:

```bash
node examples/agentfood-platform-demo/server.mjs
```

Open `http://127.0.0.1:8790`.

To use a Platform API on another local address:

```bash
VELARUMPAY_API_URL=http://127.0.0.1:8788 PORT=8790 node examples/agentfood-platform-demo/server.mjs
```

## Demo flow

1. Register a local wallet device with the Platform API.
2. Create a Connect Invitation using `POST /v1/connect-invitations` and copy the returned `connect_key`.
3. Paste the key into AgentFood chat. AgentFood recognizes and claims it automatically.
4. Review the server-derived registered Merchant, Agent, credential, and requested scopes in VelarumPay, then approve the invitation.
5. AgentFood detects approval, exchanges its claim token for a connection token, and marks the session connected.
6. Ask for food and a budget. AgentFood creates a Transaction Context and Payment Request through the Platform API.
7. Review or reject the resulting request in VelarumPay. The Agent cannot approve or sign it.

The hosted Worker requires `VELARUMPAY_CONNECT_PLATFORM_URL`, `AGENTFOOD_AGENT_ID`, `AGENTFOOD_AGENT_CLIENT_ID`, `AGENTFOOD_AGENT_CREDENTIAL_KID`, and `AGENTFOOD_AGENT_CREDENTIAL_PRIVATE_KEY_JWK`. The private JWK must be injected as a secret. A missing or invalid standard configuration fails closed and never falls back to the legacy self-declared path.

Every blocked old write emits a structured `agentfood.legacy_path_attempt` log with a normalized route, classification, disposition, method, status, surface, schema version, and timestamp. When the optional `AGENTFOOD_LEGACY_METRICS` Analytics Engine binding is configured, the Worker also writes an aggregate-safe data point. Tokens, keys, request bodies, and raw resource identifiers are excluded, and a telemetry write failure does not reopen or break the retired route.

## Verify

```bash
npm --prefix examples/agentfood-platform-demo run check
npm --prefix examples/agentfood-platform-demo test
```

The hosted worker uses a Sites-managed D1 binding named `DB`; the local server continues to use the Platform API configured by `VELARUMPAY_API_URL`. The example uses only Node.js built-ins, Web Platform APIs, repository APIs, and original generated image assets. It adds no third-party dependency, font, icon set, or externally licensed asset.
