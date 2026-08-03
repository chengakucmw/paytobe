const PAGE_ROUTES = Object.freeze({
  "/": "/index.html",
  "/demo": "/index.html",
  "/personal": "/personal.html",
  "/business": "/business.html",
  "/security": "/security.html",
  "/support": "/support.html",
  "/preview": "/preview.html",
  "/legal": "/legal.html"
});

function securityHeaders(headers = {}) {
  return {
    ...headers,
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  };
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: securityHeaders({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    })
  });
}

function staticResponse(pathname, origin, headOnly) {
  const localizedMatch = pathname.match(new RegExp(`^/(${LOCALIZED_ROUTE_PREFIXES.join("|")})(/.*)?$`));
  const localePrefix = localizedMatch?.[1] || "";
  const routePath = localizedMatch ? localizedMatch[2] || "/" : pathname;
  const page = PAGE_ROUTES[routePath] || routePath;
  const requested = localePrefix && page.endsWith(".html") ? `/${localePrefix}${page}` : PAGE_ROUTES[pathname] || pathname;
  const asset = STATIC_ASSETS[requested];
  if (!asset) return json(404, { ok: false, error: "Not found" });

  const isHtml = asset.type.startsWith("text/html");
  const body = asset.encoding === "base64"
    ? Uint8Array.from(atob(asset.body), (character) => character.charCodeAt(0))
    : isHtml
      ? asset.body.replaceAll("__SITE_ORIGIN__", origin)
      : asset.body;

  return new Response(headOnly ? null : body, {
    headers: securityHeaders({
      "content-type": asset.type,
      "cache-control": isHtml ? "no-store" : "public, max-age=86400"
    })
  });
}

function androidDownload(env) {
  const configured = env?.ANDROID_APK_DOWNLOAD_URL;
  if (!configured) {
    return json(503, { ok: false, error: "Android APK download is not configured" });
  }

  let target;
  try {
    target = new URL(configured);
  } catch {
    return json(503, { ok: false, error: "Android APK download is not configured" });
  }
  if (target.protocol !== "https:") {
    return json(503, { ok: false, error: "Android APK download is not configured" });
  }
  return Response.redirect(target.toString(), 307);
}

async function handle(request, env) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json(200, {
      ok: true,
      service: "VelarumPay-site",
      android_apk_available: Boolean(env?.ANDROID_APK_DOWNLOAD_URL)
    });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  if (url.pathname === "/download/android") {
    return androidDownload(env);
  }

  return staticResponse(url.pathname, url.origin, request.method === "HEAD");
}

export default {
  async fetch(request, env = {}) {
    try {
      return await handle(request, env);
    } catch {
      return json(500, { ok: false, error: "The website could not serve this request" });
    }
  }
};
