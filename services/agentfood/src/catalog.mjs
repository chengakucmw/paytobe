import crypto from "node:crypto";
import { addDecimal, multiplyDecimal } from "./money.mjs";

export const catalog = Object.freeze([
  Object.freeze({
    id: "green-bowl",
    name: "Green Bowl Kitchen",
    mock: true,
    items: Object.freeze([
      Object.freeze({ id: "garden-bowl", name: "Garden tahini bowl", mock_price: "9.50" }),
      Object.freeze({ id: "chili-tofu", name: "Chili tofu bowl", mock_price: "11.20" }),
      Object.freeze({ id: "citrus-tea", name: "Citrus iced tea", mock_price: "2.40" })
    ])
  }),
  Object.freeze({
    id: "noodle-atelier",
    name: "Noodle Atelier",
    mock: true,
    items: Object.freeze([
      Object.freeze({ id: "red-chili-noodles", name: "Red chili noodles", mock_price: "12.80" }),
      Object.freeze({ id: "sesame-noodles", name: "Sesame noodles", mock_price: "10.60" }),
      Object.freeze({ id: "cucumber-side", name: "Smashed cucumber", mock_price: "3.10" })
    ])
  }),
  Object.freeze({
    id: "bento-harbor",
    name: "Bento Harbor",
    mock: true,
    items: Object.freeze([
      Object.freeze({ id: "miso-salmon-bento", name: "Miso salmon bento", mock_price: "14.40" }),
      Object.freeze({ id: "ginger-tofu-bento", name: "Ginger tofu bento", mock_price: "11.90" }),
      Object.freeze({ id: "miso-soup", name: "Miso soup", mock_price: "2.20" })
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
      mock: true,
      items: merchant.items.map((item) => ({ ...item, mock: true }))
    }))
  };
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
      network: "stellar_public",
      purpose: "small_mainnet_demonstration",
      real_value_transfer: true,
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
