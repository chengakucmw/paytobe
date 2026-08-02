import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = ["public/index.html", "public/styles.css", "public/fonts/SchibstedGrotesk-Variable.ttf", "public/fonts/HankenGrotesk-Variable.ttf", "public/fonts/SpaceMono-Regular.ttf", "public/fonts/SpaceMono-Bold.ttf", "public/fonts/OFL-Schibsted-Grotesk.txt", "public/fonts/OFL-Hanken-Grotesk.txt", "public/fonts/OFL-Space-Mono.txt", "public/app.js", "public/modules/api-client.js", "public/modules/auth-state.js", "public/modules/view.js", "src/pages/organization/index.js", "src/components/members/view.js", "src/pages/domains/index.js", "src/components/domains/view.js", "src/pages/agents/index.js", "src/components/agents/view.js", "src/pages/recipients/index.js", "src/components/recipients/view.js", "src/pages/webhooks/index.js", "src/pages/audit/index.js", "src/components/webhooks/view.js"];
await Promise.all(required.map((file) => access(path.join(root, file))));
const html = await readFile(path.join(root, "public/index.html"), "utf8");
if (!html.includes('type="module"') || !html.includes('id="app"')) throw new Error("Portal shell entry point is incomplete");
console.log(`Validated ${required.length} static merchant portal assets; no compilation or external assets required.`);
