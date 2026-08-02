import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(scriptDirectory, "..");
const codeRoot = path.resolve(docsRoot, "../..");
const target = path.join(docsRoot, "public/contracts");

const contracts = [
  [
    path.join(codeRoot, "services/platform-api/openapi/velarumpay-platform-api-v0.1.openapi.json"),
    path.join(target, "velarumpay-platform-api-v0.1.openapi.json")
  ],
  [
    path.join(codeRoot, "packages/protocol/schema/velarum.payment_request.v1.schema.json"),
    path.join(target, "velarum.payment_request.v1.schema.json")
  ],
  [
    path.join(codeRoot, "packages/protocol/schema/velarum.transaction_context.v1.schema.json"),
    path.join(target, "velarum.transaction_context.v1.schema.json")
  ]
];

mkdirSync(target, { recursive: true });
for (const [source, destination] of contracts) copyFileSync(source, destination);
console.log(`Synchronized ${contracts.length} VelarumPay contracts to ${target}`);
