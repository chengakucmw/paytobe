import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import worker from "../dist/server/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageRoutes = ["/", "/personal", "/business", "/security", "/support", "/preview"];

async function call(pathname, options = {}) {
  return worker.fetch(new Request(`https://velarumpay.example${pathname}`, options));
}

test("all public pages render as a clearly labelled Preview", async () => {
  for (const route of pageRoutes) {
    const response = await call(route);
    const html = await response.text();
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get("content-type") || "", /text\/html/, route);
    assert.match(html, /<h1[ >]/, route);
    assert.match(html, /Developer Preview/, route);
    assert.match(html, /https:\/\/docs\.velarumpay\.com/, route);
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic|<script[^>]+src="https?:/i, route);
    assert.match(html, /https:\/\/velarumpay\.example\/og\.png/, route);
  }
});

test("local navigation targets resolve", async () => {
  for (const route of pageRoutes) {
    const html = await (await call(route)).text();
    const targets = [...html.matchAll(/href="(\/[^"]*)"/g)]
      .map((match) => match[1].split("#")[0])
      .filter((target) => target && !target.endsWith(".xml"));
    for (const target of new Set(targets)) {
      const response = await call(target);
      assert.equal(response.status, 200, `${route} -> ${target}`);
    }
  }
});

test("the pilot flow is explicit and does not post form data to the website", async () => {
  const html = await (await call("/business")).text();
  const script = await (await call("/site.js")).text();
  assert.match(html, /data-pilot-form/);
  assert.doesNotMatch(html, /<form[^>]+action=/i);
  assert.match(html, /website does not transmit or store the form/i);
  assert.match(script, /mailto:pilot@velarumpay\.com/);
  assert.match(script, /Do not|No additional notes|Preview pilot request/);
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
