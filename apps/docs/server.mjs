import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 8092);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf"
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `localhost:${port}`}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, service: "VelarumPay-docs", time: new Date().toISOString() }));
    return;
  }

  serveStatic(url.pathname, res);
});

server.listen(port, () => {
  console.log(`VelarumPay docs listening on http://localhost:${port}`);
});

function serveStatic(pathname, res) {
  const clean = decodeURIComponent(pathname).replace(/\\/g, "/");
  const requested = clean === "/" ? "/index.html" : clean;
  const filePath = path.normalize(path.join(publicDir, requested));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden" }));
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
