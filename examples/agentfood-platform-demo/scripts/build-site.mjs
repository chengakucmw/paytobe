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
  poppinsRegular,
  poppinsSemibold,
  poppinsBold,
  dmSans,
  jetBrainsMono,
  poppinsLicense,
  dmSansLicense,
  jetBrainsMonoLicense,
  connectApi,
  workerTemplate
] = await Promise.all([
  fs.readFile(path.join(root, "public/index.html"), "utf8"),
  fs.readFile(path.join(root, "public/styles.css"), "utf8"),
  fs.readFile(path.join(root, "public/app.js"), "utf8"),
  fs.readFile(path.join(root, "public/assets/agentfood-dishes-v2.jpg")),
  fs.readFile(path.join(root, "public/assets/agentfood-social-v3.png")),
  fs.readFile(path.join(root, "public/fonts/Poppins-Regular.ttf")),
  fs.readFile(path.join(root, "public/fonts/Poppins-SemiBold.ttf")),
  fs.readFile(path.join(root, "public/fonts/Poppins-Bold.ttf")),
  fs.readFile(path.join(root, "public/fonts/DMSans-Variable.ttf")),
  fs.readFile(path.join(root, "public/fonts/JetBrainsMono-Variable.ttf")),
  fs.readFile(path.join(root, "public/fonts/OFL-Poppins.txt"), "utf8"),
  fs.readFile(path.join(root, "public/fonts/OFL-DM-Sans.txt"), "utf8"),
  fs.readFile(path.join(root, "public/fonts/OFL-JetBrains-Mono.txt"), "utf8"),
  fs.readFile(path.join(root, "cloud/real-connect-api.mjs"), "utf8"),
  fs.readFile(path.join(root, "cloud/worker-template.mjs"), "utf8")
]);

const assets = {
  "/": { body: html, type: "text/html; charset=utf-8" },
  "/styles.css": { body: css, type: "text/css; charset=utf-8" },
  "/app.js": { body: app, type: "text/javascript; charset=utf-8" },
  "/assets/agentfood-dishes-v2.jpg": { body: foodImage.toString("base64"), type: "image/jpeg", encoding: "base64" },
  "/assets/agentfood-social-v3.png": { body: socialImage.toString("base64"), type: "image/png", encoding: "base64" },
  "/fonts/Poppins-Regular.ttf": { body: poppinsRegular.toString("base64"), type: "font/ttf", encoding: "base64" },
  "/fonts/Poppins-SemiBold.ttf": { body: poppinsSemibold.toString("base64"), type: "font/ttf", encoding: "base64" },
  "/fonts/Poppins-Bold.ttf": { body: poppinsBold.toString("base64"), type: "font/ttf", encoding: "base64" },
  "/fonts/DMSans-Variable.ttf": { body: dmSans.toString("base64"), type: "font/ttf", encoding: "base64" },
  "/fonts/JetBrainsMono-Variable.ttf": { body: jetBrainsMono.toString("base64"), type: "font/ttf", encoding: "base64" },
  "/fonts/OFL-Poppins.txt": { body: poppinsLicense, type: "text/plain; charset=utf-8" },
  "/fonts/OFL-DM-Sans.txt": { body: dmSansLicense, type: "text/plain; charset=utf-8" },
  "/fonts/OFL-JetBrains-Mono.txt": { body: jetBrainsMonoLicense, type: "text/plain; charset=utf-8" }
};

await fs.rm(outputDirectory, { recursive: true, force: true });
await fs.mkdir(serverDirectory, { recursive: true });
await fs.writeFile(
  path.join(serverDirectory, "index.js"),
  `const STATIC_ASSETS = Object.freeze(${JSON.stringify(assets)});\n${connectApi}\n${workerTemplate}`
);

console.log("Built AgentFood Sites Worker in dist/server/index.js");
