import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist", "server");
await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
await fs.copyFile(path.join(root, "src", "worker.mjs"), path.join(output, "index.js"));
console.log("Built VelarumPay Connect Platform edge worker");
