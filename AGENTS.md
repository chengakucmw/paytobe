# VelarumPayCode Agent Instructions

1. The main product is VelarumPay.
2. Default development root is `/Users/yang/code/VelarumPayCode`.
3. Product workspace and archive live in `/Users/yang/code/VelarumPay`; do not modify archive files unless the user explicitly asks.
4. Android mainline lives in `apps/android`.
5. iOS mainline lives in `apps/ios`.
6. Backend mainline lives in `services/platform-api`.
7. Website mainline lives in `apps/website`.
8. OpenClaw connector lives in `connectors/openclaw-telegram`.
9. AgentFood is a demo, not wallet core.
10. New payment features should use the Payment Request abstraction instead of hard-coded business flows.
11. Keep server-side zero private keys: signing must happen in the user wallet.
12. Keep user approval as the default for real payments.
13. Do not commit `.env`, logs, APKs, build outputs, `node_modules`, Gradle caches, or runtime store JSON.
14. Formal documents, task cards, prototypes, and design assets live in `/Users/yang/code/VelarumPay`; do not add formal docs to this code repo.
15. Code-repository documentation should be limited to concise READMEs or comments that are necessary to build, run, test, or understand nearby code.
