import http from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const builtPublicDir = path.join(__dirname, "dist", "public");
const publicDir = existsSync(builtPublicDir) ? builtPublicDir : path.join(__dirname, "public");
const apkDownloadName = "VelarumPay-Android-Official-Testnet.apk";
// APKs stay outside the public code repository. Operators replace the stable file in
// releases/android, while the public /download/android URL remains unchanged.
const apkPath = process.env.VELARUMPAY_APK_PATH
  ? path.resolve(process.env.VELARUMPAY_APK_PATH)
  : path.resolve(__dirname, "..", "..", "..", "releases", "android", "VelarumPay-latest.apk");
const port = Number(process.env.PORT || 8091);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8"
};

const pageRoutes = new Map([
  ["/", "/index.html"],
  ["/demo", "/index.html"],
  ["/personal", "/personal.html"],
  ["/business", "/business.html"],
  ["/security", "/security.html"],
  ["/support", "/support.html"],
  ["/preview", "/preview.html"],
  ["/legal", "/legal.html"]
]);
const localePaths = new Set(["zh-hans", "zh-hant", "ja", "ko", "es", "pt-br", "fr"]);

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `localhost:${port}`}`);

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "VelarumPay-site",
      android_apk_available: isAvailableApk(),
      time: new Date().toISOString()
    });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  if (url.pathname === "/download/android") {
    if (!isAvailableApk()) {
      sendJson(res, 404, { ok: false, error: "Android APK is not available yet" });
      return;
    }
    const apkStat = statSync(apkPath);
    res.writeHead(200, securityHeaders({
      "content-type": "application/vnd.android.package-archive",
      "content-length": apkStat.size,
      "cache-control": "no-cache, must-revalidate",
      "content-disposition": `attachment; filename="${apkDownloadName}"`,
      "last-modified": apkStat.mtime.toUTCString()
    }));
    if (req.method === "HEAD") res.end();
    else createReadStream(apkPath).pipe(res);
    return;
  }

  serveStatic(url.pathname, url.origin, req.method === "HEAD", res);
});

server.listen(port, () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  console.log(`VelarumPay site listening on http://localhost:${boundPort}`);
});

function isAvailableApk() {
  return existsSync(apkPath) && statSync(apkPath).isFile();
}

function serveStatic(pathname, origin, headOnly, res) {
  const clean = decodeURIComponent(pathname).replace(/\\/g, "/");
  const segments = clean.split("/").filter(Boolean);
  const localePath = localePaths.has(segments[0]) ? segments.shift() : "";
  const localizedRoute = `/${segments.join("/")}`;
  const page = pageRoutes.get(localizedRoute) || localizedRoute;
  const requested = localePath && page.endsWith(".html") ? `/${localePath}${page}` : pageRoutes.get(clean) || clean;
  const filePath = path.normalize(path.join(publicDir, requested));

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(res, 404, { ok: false, error: "Not found" });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const headers = securityHeaders({
    "content-type": mime[ext] || "application/octet-stream",
    "cache-control": ext === ".html" ? "no-store" : "public, max-age=86400"
  });

  if (ext === ".html") {
    const body = readFileSync(filePath, "utf8").replaceAll("__SITE_ORIGIN__", origin);
    res.writeHead(200, { ...headers, "content-length": Buffer.byteLength(body) });
    res.end(headOnly ? undefined : body);
    return;
  }

  const size = statSync(filePath).size;
  res.writeHead(200, { ...headers, "content-length": size });
  if (headOnly) res.end();
  else createReadStream(filePath).pipe(res);
}

function sendJson(res, status, payload) {
  res.writeHead(status, securityHeaders({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  }));
  res.end(JSON.stringify(payload, null, 2));
}

function securityHeaders(headers) {
  return {
    ...headers,
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  };
}
