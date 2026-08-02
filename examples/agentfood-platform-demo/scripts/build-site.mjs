import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "dist");
const serverDirectory = path.join(outputDirectory, "server");

const [
  html,
  css,
  app,
  foodImage,
  socialImage,
  displayFont,
  bodyFont,
  monoRegularFont,
  monoBoldFont,
  displayFontLicense,
  bodyFontLicense,
  monoFontLicense,
  connectStore,
  connectApi,
  workerTemplate
] = await Promise.all([
  fs.readFile(path.join(root, "public/index.html"), "utf8"),
  fs.readFile(path.join(root, "public/styles.css"), "utf8"),
  fs.readFile(path.join(root, "public/app.js"), "utf8"),
  fs.readFile(path.join(root, "public/assets/agentfood-dishes-v2.jpg")),
  fs.readFile(path.join(root, "public/assets/agentfood-social-v2.jpg")),
  fs.readFile(path.join(root, "public/fonts/SchibstedGrotesk-Variable.ttf")),
  fs.readFile(path.join(root, "public/fonts/HankenGrotesk-Variable.ttf")),
  fs.readFile(path.join(root, "public/fonts/SpaceMono-Regular.ttf")),
  fs.readFile(path.join(root, "public/fonts/SpaceMono-Bold.ttf")),
  fs.readFile(path.join(root, "public/fonts/OFL-Schibsted-Grotesk.txt"), "utf8"),
  fs.readFile(path.join(root, "public/fonts/OFL-Hanken-Grotesk.txt"), "utf8"),
  fs.readFile(path.join(root, "public/fonts/OFL-Space-Mono.txt"), "utf8"),
  fs.readFile(path.join(root, "cloud/real-connect-store.mjs"), "utf8"),
  fs.readFile(path.join(root, "cloud/real-connect-api.mjs"), "utf8"),
  fs.readFile(path.join(root, "cloud/worker-template.mjs"), "utf8")
]);

const assets = {
  "/": { body: html, type: "text/html; charset=utf-8" },
  "/styles.css": { body: css, type: "text/css; charset=utf-8" },
  "/app.js": { body: app, type: "text/javascript; charset=utf-8" },
  "/assets/agentfood-dishes-v2.jpg": { body: foodImage.toString("base64"), type: "image/jpeg", encoding: "base64" },
  "/assets/agentfood-social-v2.jpg": { body: socialImage.toString("base64"), type: "image/jpeg", encoding: "base64" },
  "/fonts/SchibstedGrotesk-Variable.ttf": { body: displayFont.toString("base64"), type: "font/ttf", encoding: "base64" },
  "/fonts/HankenGrotesk-Variable.ttf": { body: bodyFont.toString("base64"), type: "font/ttf", encoding: "base64" },
  "/fonts/SpaceMono-Regular.ttf": { body: monoRegularFont.toString("base64"), type: "font/ttf", encoding: "base64" },
  "/fonts/SpaceMono-Bold.ttf": { body: monoBoldFont.toString("base64"), type: "font/ttf", encoding: "base64" },
  "/fonts/OFL-Schibsted-Grotesk.txt": { body: displayFontLicense, type: "text/plain; charset=utf-8" },
  "/fonts/OFL-Hanken-Grotesk.txt": { body: bodyFontLicense, type: "text/plain; charset=utf-8" },
  "/fonts/OFL-Space-Mono.txt": { body: monoFontLicense, type: "text/plain; charset=utf-8" }
};

await fs.rm(outputDirectory, { recursive: true, force: true });
await fs.mkdir(serverDirectory, { recursive: true });
await fs.writeFile(
  path.join(serverDirectory, "index.js"),
  `const STATIC_ASSETS = Object.freeze(${JSON.stringify(assets)});\n${connectStore}\n${connectApi}\n${workerTemplate}`
);

console.log("Built AgentFood Sites Worker in dist/server/index.js");
