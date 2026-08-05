import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import worker from "../dist/server/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageRoutes = ["/", "/personal", "/business", "/security", "/support", "/preview"];
const legalRoutes = ["/legal", "/zh-hans/legal"];
const localePaths = ["zh-hans", "zh-hant", "ja", "ko", "es", "pt-br", "fr"];

async function call(pathname, options = {}, env = {}) {
  return worker.fetch(new Request(`https://velarumpay.example${pathname}`, options), env);
}

test("all public pages render as a clearly labelled Official Testnet", async () => {
  for (const route of pageRoutes) {
    const response = await call(route);
    const html = await response.text();
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get("content-type") || "", /text\/html/, route);
    assert.match(html, /<h1[ >]/, route);
    assert.match(html, /Official Testnet/, route);
    assert.doesNotMatch(html, /Developer Preview/, route);
    assert.doesNotMatch(html, /selected (?:Official Testnet )?pilots?|test and pilot use only|direct-download availability is not announced|production release evidence remains gated/i, route);
    assert.match(html, /https:\/\/docs\.velarumai\.com/, route);
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic|<script[^>]+src="https?:/i, route);
    assert.match(html, /https:\/\/velarumpay\.example\/og\.png/, route);
    assert.match(html, /\/site\.js\?v=i18n-20260804-1/, route);
    assert.match(html, /\/styles\.css\?v=language-20260803-1/, route);
    assert.match(html, /class="language-picker-globe"/, route);
  }
});

test("the language picker navigates to the selected localized route", async () => {
  const script = await (await call("/site.js")).text();
  const listeners = {};
  const picker = {
    value: "/zh-hans/",
    addEventListener(type, listener) {
      listeners[type] = listener;
    }
  };
  const location = { href: "/" };
  vm.runInNewContext(script, {
    document: {
      querySelector() { return null; },
      querySelectorAll(selector) { return selector === "[data-language-picker]" ? [picker] : []; }
    },
    window: { location }
  });
  assert.equal(typeof listeners.change, "function");
  listeners.change();
  assert.equal(location.href, "/zh-hans/");
});

test("local navigation targets resolve", async () => {
  for (const route of pageRoutes) {
    const html = await (await call(route)).text();
    const targets = [...html.matchAll(/href="(\/[^"]*)"/g)]
      .map((match) => match[1].split("#")[0])
      .filter((target) => target && target !== "/download/android" && !target.endsWith(".xml"));
    for (const target of new Set(targets)) {
      const response = await call(target);
      assert.equal(response.status, 200, `${route} -> ${target}`);
    }
  }
});

test("the effective bilingual legal center publishes the complete testnet document set", async () => {
  for (const route of legalRoutes) {
    const response = await call(route);
    const html = await response.text();
    assert.equal(response.status, 200, route);
    assert.match(html, /Vivbase LLC/, route);
    assert.match(html, /DigitalOcean/, route);
    assert.match(html, /Sydney/, route);
    assert.match(html, /1021 E Lincolnway/, route);
    assert.match(html, /Suite #9996/, route);
    assert.doesNotMatch(html, /Velarum Labs LLC|Contracted non-Singapore VPS|签约的非新加坡 VPS/, route);
    assert.match(html, /2026-08-03|August 3, 2026/, route);
    assert.match(html, /00056-00006-00004/, route);
    assert.match(html, /00056-00006-00011/, route);
    assert.match(html, /legal@velarumai\.com/, route);
    assert.match(html, /privacy@velarumai\.com/, route);
    assert.match(html, /Stellar testnet/, route);
    assert.match(html, /United States federal law|美国联邦法/, route);
    assert.match(html, /Wyoming/, route);
    assert.match(html, /FinCEN/, route);
    assert.doesNotMatch(html, /Taiwan PDPA|台湾个人资料保护法|EU GDPR/, route);
    assert.doesNotMatch(html, /release-gated|Preview language is intentionally limited|\[VELARUM_/i, route);
  }
});

test("the personal page exposes one stable Android APK download URL", async () => {
  for (const locale of ["", ...localePaths]) {
    const route = locale ? `/${locale}/personal` : "/personal";
    const html = await (await call(route)).text();
    assert.equal([...html.matchAll(/href="\/download\/android"/g)].length, 2, route);
    assert.equal([...html.matchAll(/data-download-android/g)].length, 2, route);
  }

  const unavailable = await call("/download/android");
  assert.equal(unavailable.status, 503);

  const configured = await call("/download/android", {}, {
    ANDROID_APK_DOWNLOAD_URL: "https://downloads.example/VelarumPay-latest.apk"
  });
  assert.equal(configured.status, 307);
  assert.equal(configured.headers.get("location"), "https://downloads.example/VelarumPay-latest.apk");
});

test("the self-hosted download route serves the current APK with download headers", async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "velarumpay-site-apk-"));
  const temporaryApk = path.join(temporaryDirectory, "VelarumPay-latest.apk");
  const apkBytes = Buffer.from("test-apk-bytes");
  await fs.writeFile(temporaryApk, apkBytes);

  const child = spawn(process.execPath, [path.join(root, "server.mjs")], {
    env: { ...process.env, PORT: "0", VELARUMPAY_APK_PATH: temporaryApk },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Website server did not start")), 5_000);
    child.once("error", reject);
    child.stderr.on("data", (chunk) => reject(new Error(chunk.toString())));
    child.stdout.on("data", (chunk) => {
      const match = chunk.toString().match(/localhost:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    });
  });

  const response = await fetch(`http://127.0.0.1:${port}/download/android`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/vnd.android.package-archive");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="VelarumPay-Android-Official-Testnet.apk"');
  assert.equal(response.headers.get("cache-control"), "no-cache, must-revalidate");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), apkBytes);

  const head = await fetch(`http://127.0.0.1:${port}/download/android`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test("all translated pages are complete, discoverable, and locally navigable", async () => {
  for (const locale of localePaths) {
    for (const route of pageRoutes) {
      const localizedRoute = `/${locale}${route === "/" ? "/" : route}`;
      const response = await call(localizedRoute);
      const html = await response.text();
      assert.equal(response.status, 200, localizedRoute);
      assert.match(html, new RegExp(`<html lang="(?:${locale === "zh-hant" ? "zh-Hant-TW" : locale === "es" ? "es-419" : locale === "pt-br" ? "pt-BR" : locale === "zh-hans" ? "zh-Hans" : locale})">`), localizedRoute);
      assert.match(html, /data-language-picker/, localizedRoute);
      assert.match(html, new RegExp(`rel="canonical" href="https://velarumai\\.com/${locale}/`), localizedRoute);
      assert.match(html, /hreflang="x-default"/, localizedRoute);
      assert.match(html, /property="og:image" content="https:\/\/velarumpay\.example\/og\.png"/, localizedRoute);

      const targets = [...html.matchAll(/href="(\/[^"#?]*)/g)]
        .map((match) => match[1])
        .filter((target) => target.startsWith(`/${locale}/`));
      for (const target of new Set(targets)) {
        assert.equal((await call(target)).status, 200, `${localizedRoute} -> ${target}`);
      }
    }
  }
});

test("sitemap lists every English and translated page", async () => {
  const sitemap = await (await call("/sitemap.xml")).text();
  assert.equal([...sitemap.matchAll(/<url>/g)].length, pageRoutes.length * (localePaths.length + 1) + legalRoutes.length);
  for (const locale of localePaths) {
    assert.match(sitemap, new RegExp(`<loc>https://velarumai\\.com/${locale}/</loc>`));
  }
  assert.match(sitemap, /<loc>https:\/\/velarumai\.com\/legal<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/velarumai\.com\/zh-hans\/legal<\/loc>/);
});

test("the Official Testnet integration-support flow is explicit and does not post form data to the website", async () => {
  const html = await (await call("/business")).text();
  const script = await (await call("/site.js")).text();
  assert.match(html, /data-pilot-form/);
  assert.doesNotMatch(html, /<form[^>]+action=/i);
  assert.match(html, /website does not transmit or store the form/i);
  assert.match(script, /mailto:pilot@velarumai\.com/);
  assert.match(script, /Do not|No additional notes|Official Testnet integration support/);
});

test("static assets and security headers are served", async () => {
  for (const asset of ["/styles.css", "/site.js", "/robots.txt", "/sitemap.xml", "/og.png"]) {
    const response = await call(asset);
    assert.equal(response.status, 200, asset);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", asset);
    assert.equal(response.headers.get("x-frame-options"), "DENY", asset);
    assert.match(response.headers.get("content-security-policy") || "", /default-src 'self'/, asset);
  }
  const socialCard = await fs.stat(path.join(root, "public", "og.png"));
  assert.ok(socialCard.size > 10_000);
});

test("unknown routes and unsupported methods fail closed", async () => {
  assert.equal((await call("/not-a-page")).status, 404);
  assert.equal((await call("/", { method: "POST" })).status, 405);
  assert.equal((await call("/personal", { method: "HEAD" })).status, 200);
});
