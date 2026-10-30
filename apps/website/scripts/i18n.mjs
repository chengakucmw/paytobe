import fs from "node:fs/promises";
import path from "node:path";

export const sourceLocale = Object.freeze({
  code: "en",
  path: "",
  label: "English",
  shortLabel: "EN"
});

export const translatedLocales = Object.freeze([
  { code: "zh-Hans", path: "zh-hans", label: "简体中文", shortLabel: "简中" },
  { code: "zh-Hant-TW", path: "zh-hant", label: "繁體中文", shortLabel: "繁中" },
  { code: "ja", path: "ja", label: "日本語", shortLabel: "JA" },
  { code: "ko", path: "ko", label: "한국어", shortLabel: "KO" },
  { code: "es-419", path: "es", label: "Español", shortLabel: "ES" },
  { code: "pt-BR", path: "pt-br", label: "Português (Brasil)", shortLabel: "PT" },
  { code: "fr", path: "fr", label: "Français", shortLabel: "FR" }
]);

export const allLocales = Object.freeze([sourceLocale, ...translatedLocales]);

export const pageRoutes = Object.freeze({
  "": "index.html",
  personal: "personal.html",
  business: "business.html",
  security: "security.html",
  support: "support.html",
  preview: "preview.html"
});

const origin = "https://paytobe.com";
const neutralStrings = new Set([
  "P",
  "Paytobe",
  "REST API",
  "JavaScript",
  "JavaScript SDK",
  "MCP server",
  "Connector",
  "01",
  "02",
  "03",
  "04"
]);

export async function loadCatalogs(root) {
  const catalogs = new Map();
  for (const locale of translatedLocales) {
    const filePath = path.join(root, "i18n", `${locale.path}.json`);
    catalogs.set(locale.code, JSON.parse(await fs.readFile(filePath, "utf8")));
  }
  return catalogs;
}

export function extractTranslatableStrings(html) {
  const strings = new Set();

  html.replace(/>([^<>]+)</g, (_match, rawText) => {
    const value = decodeEntities(rawText.trim());
    if (isTranslatable(value)) strings.add(value);
    return _match;
  });

  html.replace(/\b(?:aria-label|placeholder|data-i18n-[a-z-]+)="([^"]+)"/g, (_match, value) => {
    const decoded = decodeEntities(value.trim());
    if (isTranslatable(decoded)) strings.add(decoded);
    return _match;
  });

  html.replace(/<meta\s+(?:name|property)="(?:description|og:title|og:description|twitter:title|twitter:description)"\s+content="([^"]+)"/g, (_match, value) => {
    const decoded = decodeEntities(value.trim());
    if (isTranslatable(decoded)) strings.add(decoded);
    return _match;
  });

  strings.add("Language");
  return [...strings].sort((a, b) => a.localeCompare(b, "en"));
}

export function localizeHtml(source, locale, catalog, route) {
  const required = extractTranslatableStrings(source);
  const missing = required.filter((value) => typeof catalog[value] !== "string" || !catalog[value].trim());
  if (missing.length) {
    throw new Error(`${locale.code} is missing ${missing.length} translations:\n${missing.map((value) => `- ${value}`).join("\n")}`);
  }

  let html = source.replace('<html lang="en">', `<html lang="${locale.code}">`);

  html = html.replace(/>([^<>]+)</g, (match, rawText) => {
    const leading = rawText.match(/^\s*/)?.[0] || "";
    const trailing = rawText.match(/\s*$/)?.[0] || "";
    const value = decodeEntities(rawText.trim());
    return isTranslatable(value) ? `>${leading}${escapeHtml(catalog[value])}${trailing}<` : match;
  });

  html = html.replace(/\b(aria-label|placeholder|data-i18n-[a-z-]+)="([^"]+)"/g, (match, name, rawValue) => {
    const value = decodeEntities(rawValue.trim());
    return isTranslatable(value) ? `${name}="${escapeAttribute(catalog[value])}"` : match;
  });

  html = html.replace(/(<meta\s+(?:name|property)="(?:description|og:title|og:description|twitter:title|twitter:description)"\s+content=")([^"]+)(")/g, (match, before, rawValue, after) => {
    const value = decodeEntities(rawValue.trim());
    return isTranslatable(value) ? `${before}${escapeAttribute(catalog[value])}${after}` : match;
  });

  html = html.replace(/href="(\/(?!\/)[^"]*)"/g, (_match, href) => `href="${localizedHref(href, locale.path)}"`);
  html = html.replace(/(<meta property="og:url" content=")__SITE_ORIGIN__(\/[^"]*)(" \/>)/, (_match, before, pathname, after) => `${before}__SITE_ORIGIN__/${locale.path}${pathname === "/" ? "/" : pathname}${after}`);

  const canonicalPath = route ? `/${locale.path}/${route}` : `/${locale.path}/`;
  html = html.replace(/<link rel="canonical" href="[^"]+" \/>/, `<link rel="canonical" href="${origin}${canonicalPath}" />`);
  html = html.replace("</head>", `${alternateLinks(route)}\n</head>`);
  html = html.replace(/(<nav\b[^>]*data-site-nav[^>]*>[\s\S]*?<\/nav>)/, `$1\n${languagePicker(route, locale, catalog.Language)}`);
  return html;
}

export function addEnglishInternationalMetadata(source, route) {
  let html = source.replace("</head>", `${alternateLinks(route)}\n</head>`);
  html = html.replace(/(<nav\b[^>]*data-site-nav[^>]*>[\s\S]*?<\/nav>)/, `$1\n${languagePicker(route, sourceLocale, "Language")}`);
  return html;
}

export function buildSitemap() {
  const locations = [];
  for (const locale of allLocales) {
    for (const route of Object.keys(pageRoutes)) {
      locations.push(`${origin}${routePath(route, locale.path)}`);
    }
  }
  locations.push(`${origin}/legal`, `${origin}/zh-hans/legal`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locations.map((location) => `  <url><loc>${location}</loc></url>`).join("\n")}\n</urlset>\n`;
}

function alternateLinks(route) {
  const links = allLocales.map((locale) => `  <link rel="alternate" hreflang="${locale.code}" href="${origin}${routePath(route, locale.path)}" />`);
  links.push(`  <link rel="alternate" hreflang="x-default" href="${origin}${routePath(route, "")}" />`);
  return links.join("\n");
}

function languagePicker(route, selectedLocale, ariaLabel) {
  const options = allLocales.map((locale) => {
    const selected = locale.code === selectedLocale.code ? " selected" : "";
    return `<option value="${routePath(route, locale.path)}"${selected}>${locale.label}</option>`;
  }).join("");
  return `      <label class="language-picker"><span class="language-picker-globe" aria-hidden="true"></span><span class="language-picker-code" aria-hidden="true">${escapeHtml(selectedLocale.shortLabel)}</span><span class="language-picker-chevron" aria-hidden="true"></span><select aria-label="${escapeAttribute(ariaLabel)}" data-language-picker>${options}</select></label>`;
}

function routePath(route, localePath) {
  const prefix = localePath ? `/${localePath}` : "";
  return route ? `${prefix}/${route}` : `${prefix}/`;
}

function localizedHref(href, localePath) {
  const [pathname, suffix = ""] = href.split(/(?=[?#])/u, 2);
  if (pathname === "/legal") {
    return `${localePath === "zh-hans" ? "/zh-hans/legal" : "/legal"}${suffix}`;
  }
  if (!Object.prototype.hasOwnProperty.call(pageRoutes, pathname.replace(/^\//, ""))) return href;
  return `${routePath(pathname.replace(/^\//, ""), localePath)}${suffix}`;
}

function isTranslatable(value) {
  if (!value || neutralStrings.has(value)) return false;
  if (/^(?:https?:|mailto:|__SITE_ORIGIN__|#[0-9A-F]{3,8}$)/i.test(value)) return false;
  if (/^0x[0-9a-f…]+$/i.test(value) || /^[A-Z0-9.-]{2,10}$/.test(value)) return false;
  if (/^[\d\s.,:·→&+/-]+$/u.test(value)) return false;
  if (/^(?:Paytobe\.|pilot@|support@|security@)/i.test(value)) return false;
  return /[A-Za-z]/.test(value);
}

function decodeEntities(value) {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function escapeHtml(value) {
  return escapeAttribute(value).replaceAll('"', "&quot;");
}

function escapeAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
