import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(appDirectory, "public");
const sourceDirectory = path.join(appDirectory, "src");
const port = Number(process.env.PORT || 8093);
const host = process.env.HOST || "0.0.0.0";
const shellRoutes = new Set(["/", "/verify-email", "/overview", "/organization", "/members", "/domains", "/agents", "/recipients", "/webhooks", "/audit"]);
const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"]
]);

export function createPortalServer() {
  return http.createServer((request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || `localhost:${port}`}`);
    if (url.pathname === "/health") {
      return sendJson(response, 200, { ok: true, service: "Paytobe-merchant-portal" });
    }
    if (request.method === "GET" && url.pathname === "/v1/merchant-sessions/current") {
      return sendJson(response, 401, {
        ok: false,
        error: { code: "merchant_session_unauthenticated", message: "Sign in with a current one-time grant." }
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return sendJson(response, 405, { ok: false, error: "Method not allowed" });
    }
    const pathname = shellRoutes.has(url.pathname) ? "/index.html" : url.pathname;
    return serveFile(pathname, request.method === "HEAD", response);
  });
}

function serveFile(pathname, headOnly, response) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname).replaceAll("\\", "/");
  } catch {
    return sendJson(response, 400, { ok: false, error: "Invalid path" });
  }
  const fromSource = decoded.startsWith("/src/");
  const fromExplicitPublic = decoded.startsWith("/public/");
  const baseDirectory = fromSource ? sourceDirectory : publicDirectory;
  const relativePath = fromSource ? decoded.slice(4) : (fromExplicitPublic ? decoded.slice(7) : decoded);
  const filePath = path.resolve(baseDirectory, `.${relativePath}`);
  if (filePath !== baseDirectory && !filePath.startsWith(`${baseDirectory}${path.sep}`)) {
    return sendJson(response, 403, { ok: false, error: "Forbidden" });
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return sendJson(response, 404, { ok: false, error: "Not found" });
  }
  const extension = path.extname(filePath).toLowerCase();
  const size = statSync(filePath).size;
  response.writeHead(200, securityHeaders({
    "content-type": mime.get(extension) || "application/octet-stream",
    "content-length": size,
    "cache-control": extension === ".html" ? "no-store" : "public, max-age=300"
  }));
  if (headOnly) response.end();
  else createReadStream(filePath).pipe(response);
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, securityHeaders({
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  }));
  response.end(body);
}

function securityHeaders(headers) {
  return {
    ...headers,
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self' https://api.Paytobe.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun && process.env.VP_PORTAL_NO_AUTO_LISTEN !== "1") {
  createPortalServer().listen(port, host, () => {
    console.log(`Paytobe merchant portal listening on http://${host}:${port}`);
  });
}
