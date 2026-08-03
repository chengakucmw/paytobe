const merchants = Object.freeze([
  {
    id: "green-bowl",
    name: "Green Bowl Kitchen",
    cuisine: "Plant-forward bowls",
    description: "Fresh bowls with vegetarian and high-protein options.",
    deliveryMinutes: 24,
    tags: ["vegetarian", "healthy", "salad", "protein"],
    menu: [
      { id: "garden-bowl", name: "Garden tahini bowl", price: "9.50", tags: ["vegetarian", "healthy", "main"] },
      { id: "chili-tofu", name: "Chili tofu bowl", price: "11.20", tags: ["vegetarian", "spicy", "protein", "main"] },
      { id: "citrus-tea", name: "Citrus iced tea", price: "2.40", tags: ["drink"] }
    ]
  },
  {
    id: "noodle-atelier",
    name: "Noodle Atelier",
    cuisine: "Hand-pulled noodles",
    description: "Savory noodle dishes ranging from mild sesame to red chili.",
    deliveryMinutes: 31,
    tags: ["noodles", "spicy", "comfort"],
    menu: [
      { id: "red-chili-noodles", name: "Red chili noodles", price: "12.80", tags: ["spicy", "noodles", "main"] },
      { id: "sesame-noodles", name: "Sesame noodles", price: "10.60", tags: ["vegetarian", "noodles", "main"] },
      { id: "cucumber-side", name: "Smashed cucumber", price: "3.10", tags: ["vegetarian", "side"] }
    ]
  },
  {
    id: "bento-harbor",
    name: "Bento Harbor",
    cuisine: "Japanese-style bento",
    description: "Compact lunch and dinner sets with clearly separated sides.",
    deliveryMinutes: 27,
    tags: ["japanese", "bento", "rice"],
    menu: [
      { id: "miso-salmon-bento", name: "Miso salmon bento", price: "14.40", tags: ["fish", "bento", "main"] },
      { id: "ginger-tofu-bento", name: "Ginger tofu bento", price: "11.90", tags: ["vegetarian", "bento", "main"] },
      { id: "miso-soup", name: "Miso soup", price: "2.20", tags: ["soup", "side"] }
    ]
  }
]);

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function words(value) {
  return String(value || "").toLowerCase().match(/[a-z0-9]+/g) || [];
}

function budgetFrom(message) {
  const match = String(message).match(/(?:under|below|budget(?:\s+of)?|max(?:imum)?)\s*(\d+(?:\.\d{1,2})?)/i)
    || String(message).match(/(\d+(?:\.\d{1,2})?)\s*(?:xlm|units?)/i);
  return match ? Number(match[1]) : 30;
}

function recommend(message, preferredMerchantId) {
  const requested = new Set(words(message));
  const budget = budgetFrom(message);
  const merchant = merchants.map((candidate) => {
    let score = candidate.id === preferredMerchantId ? 10 : 0;
    for (const tag of candidate.tags) if (requested.has(tag)) score += 3;
    for (const token of words(candidate.name)) if (requested.has(token)) score += 1;
    return { candidate, score };
  }).sort((left, right) => right.score - left.score)[0].candidate;

  const rankedItems = merchant.menu.map((item) => {
    let score = item.tags.includes("main") ? 2 : 0;
    for (const tag of item.tags) if (requested.has(tag)) score += 4;
    return { item, score };
  }).sort((left, right) => right.score - left.score || Number(left.item.price) - Number(right.item.price));

  const items = [];
  let total = 0;
  for (const { item } of rankedItems) {
    const price = Number(item.price);
    if (total + price > budget) continue;
    if (items.length < 3) {
      items.push({ ...item, quantity: 1 });
      total += price;
    }
  }
  if (!items.length) throw Object.assign(new Error("No menu item fits the requested demo budget"), { code: "budget_too_low", status: 409 });
  return {
    order_id: `cloud_demo_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    merchant,
    items,
    currency: "XLM",
    total: total.toFixed(2),
    budget: budget.toFixed(2),
    prompt_summary: String(message).trim(),
    demo: true
  };
}

function staticResponse(pathname, origin) {
  const route = STATIC_ASSETS[pathname] ? pathname : "/";
  const asset = STATIC_ASSETS[route];
  const body = asset.encoding === "base64"
    ? Uint8Array.from(atob(asset.body), (character) => character.charCodeAt(0))
    : route === "/"
    ? asset.body
      .replace("Local reference demo", "Cloud real Connect · testnet only")
      .replaceAll("__SITE_ORIGIN__", origin)
    : asset.body;
  return new Response(body, {
    headers: {
      "content-type": asset.type,
      "cache-control": route === "/" ? "no-store" : "public, max-age=86400",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer"
    }
  });
}

function authenticatedUser(request) {
  const email = String(request.headers.get("oai-authenticated-user-email") || "").trim();
  if (!email) return null;
  let name = "";
  if (request.headers.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8") {
    try {
      name = decodeURIComponent(request.headers.get("oai-authenticated-user-full-name") || "").trim();
    } catch {
      name = "";
    }
  }
  return { email, name: name || email };
}

async function handle(request, env) {
  const url = new URL(request.url);
  const realResponse = await handleRealConnectRoute(request, env);
  if (realResponse) return realResponse;
  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    const user = authenticatedUser(request);
    return json(200, { ok: true, authenticated: Boolean(user), user });
  }
  if (request.method === "GET" && url.pathname === "/api/catalog") {
    return json(200, { ok: true, demo: true, hosting_mode: "cloud_real_connect", persistence: env?.DB ? "d1" : "memory", merchants });
  }
  if (request.method === "GET" && Object.prototype.hasOwnProperty.call(STATIC_ASSETS, url.pathname)) {
    return staticResponse(url.pathname, url.origin);
  }
  if (request.method === "GET" && url.pathname.startsWith("/merchants/")) {
    const merchantId = url.pathname.slice("/merchants/".length);
    if (!merchants.some((merchant) => merchant.id === merchantId)) return json(404, { ok: false, error: { code: "merchant_not_found", message: "Demo merchant not found" } });
    return staticResponse("/", url.origin);
  }
  return json(404, { ok: false, error: { code: "not_found", message: "Route not found" } });
}

export default {
  async fetch(request, env = {}) {
    try {
      return await handle(request, env);
    } catch (error) {
      return json(error.status || 500, {
        ok: false,
        error: {
          code: error.code || "cloud_demo_error",
          message: error.status && error.status < 500 ? error.message : "The cloud demo could not complete this request"
        }
      });
    }
  }
};
