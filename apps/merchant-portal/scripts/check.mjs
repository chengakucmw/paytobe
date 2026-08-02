import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = (await Promise.all([walk(path.join(root, "public")), walk(path.join(root, "src"))])).flat();
const sources = await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")]));
const forbidden = [/\blocalStorage\b/, /\bsessionStorage\b/, /Authorization\s*:/i, /session_token/i];
for (const [file, source] of sources) {
  for (const pattern of forbidden) {
    if (pattern.test(source)) throw new Error(`${path.relative(root, file)} contains forbidden client credential storage or transport: ${pattern}`);
  }
}
const externalAsset = sources.find(([, source]) => /(?:src|href)=["']https?:\/\//i.test(source));
if (externalAsset) throw new Error(`${path.relative(root, externalAsset[0])} references an unreviewed external asset`);
console.log(`Checked ${files.length} portal assets: no browser credential storage, authorization header, raw session token, or external asset.`);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
  return nested.flat().filter((file) => /\.(?:html|css|js)$/.test(file));
}
