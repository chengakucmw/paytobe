import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
// Configurable APK source. Defaults to a repo-local downloads dir; the /download/android
// route already 404s gracefully when the file is absent. (Previously hardcoded to an
// external workspace path that does not exist in this repo.)
const apkPath = process.env.VELARUMPAY_APK_PATH
  ? path.resolve(process.env.VELARUMPAY_APK_PATH)
  : path.join(publicDir, "downloads", "VelarumPay-android-demo.apk");
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
  ".ico": "image/x-icon"
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `localhost:${port}`}`);

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "VelarumPay-site",
      time: new Date().toISOString()
    });
    return;
  }

  if (url.pathname === "/download/android") {
    if (!existsSync(apkPath)) {
      sendJson(res, 404, { ok: false, error: "Android APK is not available yet" });
      return;
    }
    const size = statSync(apkPath).size;
    res.writeHead(200, {
      "content-type": "application/vnd.android.package-archive",
      "content-length": size,
      "cache-control": "public, max-age=300",
      "content-disposition": 'attachment; filename="VelarumPay-android-demo.apk"'
    });
    createReadStream(apkPath).pipe(res);
    return;
  }

  serveStatic(url.pathname, res);
});

server.listen(port, () => {
  console.log(`VelarumPay site listening on http://localhost:${port}`);
});

function serveStatic(pathname, res) {
  const clean = decodeURIComponent(pathname).replace(/\\/g, "/");
  const requested = clean === "/" || clean === "/demo" ? "/index.html" : clean;
  const filePath = path.normalize(path.join(publicDir, requested));

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return;
  }

  const finalPath = existsSync(filePath) && statSync(filePath).isFile() ? filePath : path.join(publicDir, "index.html");
  const ext = path.extname(finalPath).toLowerCase();
  res.writeHead(200, {
    "content-type": mime[ext] || "application/octet-stream",
    "cache-control": ext === ".html" ? "no-store" : "public, max-age=86400"
  });
  createReadStream(finalPath).pipe(res);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload, null, 2));
}
