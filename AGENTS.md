# VelarumPay Code Module Instructions

> **Last modified**
> - **Taipei Time:** 2026-08-01 17:27:01 Asia/Taipei (UTC+08:00)
> - **UTC:** 2026-08-01 09:27:01 UTC

1. The main product is VelarumPay.
2. Default development root is `/Users/yang/code/VelarumPay/code`.
3. Product workspace and archive live in `/Users/yang/code/VelarumPay/docs`; do not modify archive files unless the user explicitly asks.
4. Private deployment configuration lives in `/Users/yang/code/VelarumPay/cloud`.
5. Android mainline lives in `apps/android`.
6. iOS mainline lives in `apps/ios`.
7. Backend mainline lives in `services/platform-api`.
8. Website mainline lives in `apps/website`.
9. OpenClaw connector lives in `connectors/openclaw-telegram`.
10. Keep the wallet core generic; do not ship app-specific demo flows (such as the former AgentFood demo) in wallet code.
11. New payment features should use the Payment Request abstraction instead of hard-coded business flows.
12. Keep server-side zero private keys: signing must happen in the user wallet.
13. Keep user approval as the default for real payments.
14. Do not commit `.env`, logs, APKs, build outputs, `node_modules`, Gradle caches, or runtime store JSON.
15. Formal documents, task cards, prototypes, and design assets live in `/Users/yang/code/VelarumPay/docs`; do not add formal docs to this code repo.
16. Code-repository documentation should be limited to concise READMEs or comments that are necessary to build, run, test, or understand nearby code.
17. The complete first-party `code/` tree is licensed under Apache-2.0. Production secrets, private documentation, cloud operations, and VelarumPay trademarks are outside that grant.
18. Reviewed CC0-1.0 code dependencies are allowed only with verified provenance, locked versions, SBOM evidence, and patent-risk review. Strong copyleft and source-available dependencies remain prohibited.
19. Unicode-3.0 is approved for reviewed code dependencies when its copyright and permission notice are preserved. The current exact approval is `unicode-ident` `1.0.24`, using `(Apache-2.0 AND Unicode-3.0)`; any version or graph change requires review.
