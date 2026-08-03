import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addEnglishInternationalMetadata,
  buildSitemap,
  loadCatalogs,
  localizeHtml,
  pageRoutes,
  translatedLocales
} from "./i18n.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDirectory = path.join(root, "public");
const outputDirectory = path.join(root, "dist");
const serverDirectory = path.join(outputDirectory, "server");
const staticDirectory = path.join(outputDirectory, "public");
const workerTemplate = await fs.readFile(path.join(root, "cloud", "worker-template.mjs"), "utf8");
const catalogs = await loadCatalogs(root);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8"
};

const binaryExtensions = new Set([".png", ".ttf"]);
const assets = {};

for (const filePath of await listFiles(publicDirectory)) {
  const relativePath = path.relative(publicDirectory, filePath).split(path.sep).join("/");
  const extension = path.extname(filePath).toLowerCase();
  const body = await fs.readFile(filePath);
  assets[`/${relativePath}`] = {
    body: binaryExtensions.has(extension) ? body.toString("base64") : body.toString("utf8"),
    encoding: binaryExtensions.has(extension) ? "base64" : "utf8",
    type: mimeTypes[extension] || "application/octet-stream"
  };
}

for (const [route, filename] of Object.entries(pageRoutes)) {
  const source = await fs.readFile(path.join(publicDirectory, filename), "utf8");
  assets[`/${filename}`].body = addEnglishInternationalMetadata(source, route);
  for (const locale of translatedLocales) {
    assets[`/${locale.path}/${filename}`] = {
      body: localizeHtml(source, locale, catalogs.get(locale.code), route),
      encoding: "utf8",
      type: mimeTypes[".html"]
    };
  }
}

assets["/sitemap.xml"].body = buildSitemap();

await fs.rm(outputDirectory, { recursive: true, force: true });
await fs.mkdir(serverDirectory, { recursive: true });
await fs.mkdir(staticDirectory, { recursive: true });
for (const [assetPath, asset] of Object.entries(assets)) {
  const destination = path.join(staticDirectory, assetPath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, asset.encoding === "base64" ? Buffer.from(asset.body, "base64") : asset.body);
}
await fs.writeFile(
  path.join(serverDirectory, "index.js"),
  `const STATIC_ASSETS = Object.freeze(${JSON.stringify(assets)});\nconst LOCALIZED_ROUTE_PREFIXES = Object.freeze(${JSON.stringify(translatedLocales.map((locale) => locale.path))});\n${workerTemplate}`
);

console.log(`Built ${Object.keys(assets).length} website assets in dist/server/index.js`);

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files.sort();
}
