import crypto from "node:crypto";
import { addDecimal, multiplyDecimal } from "./money.mjs";

export const catalog = Object.freeze([
  Object.freeze({
    id: "green-bowl",
    name: "Green Bowl Kitchen",
    cuisine: "Plant-forward bowls",
    description: "Fresh bowls with vegetarian and high-protein options.",
    deliveryMinutes: 24,
    tags: Object.freeze(["vegetarian", "healthy", "salad", "protein"]),
    mock: true,
    items: Object.freeze([
      Object.freeze({ id: "garden-bowl", name: "Garden tahini bowl", mock_price: "9.50", tags: Object.freeze(["vegetarian", "healthy", "main"]) }),
      Object.freeze({ id: "chili-tofu", name: "Chili tofu bowl", mock_price: "11.20", tags: Object.freeze(["vegetarian", "spicy", "protein", "main"]) }),
      Object.freeze({ id: "citrus-tea", name: "Citrus iced tea", mock_price: "2.40", tags: Object.freeze(["drink"]) })
    ])
  }),
  Object.freeze({
    id: "noodle-atelier",
    name: "Noodle Atelier",
    cuisine: "Hand-pulled noodles",
    description: "Savory noodle dishes ranging from mild sesame to red chili.",
    deliveryMinutes: 31,
    tags: Object.freeze(["noodles", "spicy", "comfort"]),
    mock: true,
    items: Object.freeze([
      Object.freeze({ id: "red-chili-noodles", name: "Red chili noodles", mock_price: "12.80", tags: Object.freeze(["spicy", "noodles", "main"]) }),
      Object.freeze({ id: "sesame-noodles", name: "Sesame noodles", mock_price: "10.60", tags: Object.freeze(["vegetarian", "noodles", "main"]) }),
      Object.freeze({ id: "cucumber-side", name: "Smashed cucumber", mock_price: "3.10", tags: Object.freeze(["vegetarian", "side"]) })
    ])
  }),
  Object.freeze({
    id: "bento-harbor",
    name: "Bento Harbor",
    cuisine: "Japanese-style bento",
    description: "Compact lunch and dinner sets with clearly separated sides.",
    deliveryMinutes: 27,
    tags: Object.freeze(["japanese", "bento", "rice"]),
    mock: true,
    items: Object.freeze([
      Object.freeze({ id: "miso-salmon-bento", name: "Miso salmon bento", mock_price: "14.40", tags: Object.freeze(["fish", "bento", "main"]) }),
      Object.freeze({ id: "ginger-tofu-bento", name: "Ginger tofu bento", mock_price: "11.90", tags: Object.freeze(["vegetarian", "bento", "main"]) }),
      Object.freeze({ id: "miso-soup", name: "Miso soup", mock_price: "2.20", tags: Object.freeze(["soup", "side"]) })
    ])
  })
]);

export function publicCatalog() {
  return {
    data_mode: "mock",
    currency: "MOCK_CREDITS",
    fulfillment: "none",
    merchants: catalog.map((merchant) => ({
      id: merchant.id,
      name: merchant.name,
      cuisine: merchant.cuisine,
      description: merchant.description,
      deliveryMinutes: merchant.deliveryMinutes,
      tags: [...merchant.tags],
      mock: true,
      menu: merchant.items.map((item) => ({ id: item.id, name: item.name, price: item.mock_price, tags: [...item.tags], mock: true })),
      items: merchant.items.map((item) => ({ ...item, mock: true }))
    }))
  };
}

export function recommendMockOrder(message, preferredMerchantId = "") {
  const words = new Set(String(message || "").toLowerCase().match(/[a-z0-9]+/g) || []);
  const budgetMatch = String(message || "").match(/(?:under|below|budget(?:\s+of)?|max(?:imum)?)\s*(\d+(?:\.\d{1,2})?)/i)
    || String(message || "").match(/(\d+(?:\.\d{1,2})?)\s*(?:xlm|units?)/i);
  const budget = normalizeMoney(budgetMatch?.[1] || "30.00");
  const ranked = catalog.map((merchant) => {
    let score = merchant.id === preferredMerchantId ? 10 : 0;
    for (const tag of merchant.tags) if (words.has(tag)) score += 3;
    return { merchant, score };
  }).sort((left, right) => right.score - left.score);
  const merchant = ranked[0].merchant;
  const candidates = merchant.items.map((item) => {
    let score = item.tags.includes("main") ? 2 : 0;
    for (const tag of item.tags) if (words.has(tag)) score += 4;
    return { item, score };
  }).sort((left, right) => right.score - left.score || Number(minorUnits(left.item.mock_price) - minorUnits(right.item.mock_price)));
  const items = [];
  let total = 0n;
  for (const { item } of candidates) {
    const price = minorUnits(item.mock_price);
    if (total + price > budget) continue;
    if (items.length < 3) {
      items.push({ id: item.id, name: item.name, price: item.mock_price, quantity: 1 });
      total += price;
    }
  }
  if (!items.length) throw clientError(400, "budget_too_low", "No mock menu item fits that budget");
  return {
    order_id: `plan_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    reference_label: "Mock recommendation",
    merchant: { id: merchant.id, name: merchant.name },
    items,
    total: decimal(total),
    currency: "MOCK_CREDITS",
    data_mode: "mock",
    fulfillment: "none"
  };
}

function minorUnits(value) {
  const [whole = "0", fraction = ""] = String(value).split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

function normalizeMoney(value) {
  return minorUnits(value);
}

function decimal(units) {
  return `${units / 100n}.${String(units % 100n).padStart(2, "0")}`;
}

export function buildMockOrder(payload, paymentAmountXlm, now = new Date()) {
  const merchantId = String(payload?.merchant_id || "").trim();
  const merchant = catalog.find((candidate) => candidate.id === merchantId);
  if (!merchant) throw clientError(400, "merchant_not_found", "Mock merchant was not found");
  if (!Array.isArray(payload?.items) || payload.items.length < 1 || payload.items.length > 10) {
    throw clientError(400, "invalid_items", "items must contain between 1 and 10 mock catalog entries");
  }

  let mockTotal = "0";
  const items = payload.items.map((requested) => {
    const itemId = String(requested?.item_id || "").trim();
    const item = merchant.items.find((candidate) => candidate.id === itemId);
    const quantity = Number(requested?.quantity || 1);
    if (!item) throw clientError(400, "item_not_found", `Mock item was not found: ${itemId}`);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10) {
      throw clientError(400, "invalid_quantity", "Each mock item quantity must be an integer between 1 and 10");
    }
    const mockLineTotal = multiplyDecimal(item.mock_price, quantity);
    mockTotal = addDecimal(mockTotal, mockLineTotal);
    return {
      item_id: item.id,
      name: item.name,
      quantity,
      mock_unit_price: item.mock_price,
      mock_line_total: mockLineTotal
    };
  });

  return {
    order_id: `afo_${crypto.randomUUID().replaceAll("-", "")}`,
    status: "mock_order_created",
    data_mode: "mock_commerce_live_payment",
    fulfillment: "none",
    merchant: { id: merchant.id, name: merchant.name, mock: true },
    items,
    mock_quote: { total: mockTotal, currency: "MOCK_CREDITS", authoritative: false },
    settlement: {
      amount: paymentAmountXlm,
      asset: "XLM",
      network: "stellar_testnet",
      purpose: "official_testnet_demonstration",
      real_transaction_process: true,
      real_value_transfer: false,
      purchases_food: false
    },
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    platform_payment_request: null
  };
}

function clientError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
