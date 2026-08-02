import crypto from "node:crypto";

export const CONNECT_KEY_PATTERN = /velarumpay-connect:ck_[A-Za-z0-9_-]{43}/;

export const merchants = Object.freeze([
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

function minorUnits(value) {
  const [whole = "0", fraction = ""] = String(value).split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

function decimal(units) {
  const whole = units / 100n;
  const fraction = String(units % 100n).padStart(2, "0");
  return `${whole}.${fraction}`;
}

function normalizedWords(text) {
  return String(text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
}

function requestedBudget(text) {
  const match = String(text || "").match(/(?:under|below|budget(?:\s+of)?|max(?:imum)?)\s*(\d+(?:\.\d{1,2})?)/i)
    || String(text || "").match(/(\d+(?:\.\d{1,2})?)\s*(?:xlm|units?)/i);
  return match ? match[1] : "30.00";
}

export function extractConnectKey(text) {
  return String(text || "").match(CONNECT_KEY_PATTERN)?.[0] || null;
}

export function recommendOrder(message, preferredMerchantId = "") {
  const words = new Set(normalizedWords(message));
  const budget = requestedBudget(message);
  const budgetUnits = minorUnits(budget);
  const ranked = merchants.map((merchant) => {
    let score = merchant.id === preferredMerchantId ? 10 : 0;
    for (const tag of merchant.tags) if (words.has(tag)) score += 3;
    for (const token of normalizedWords(merchant.name)) if (words.has(token)) score += 1;
    return { merchant, score };
  }).sort((left, right) => right.score - left.score);
  const merchant = ranked[0].merchant;

  const rankedItems = merchant.menu.map((item) => {
    let score = item.tags.includes("main") ? 2 : 0;
    for (const tag of item.tags) if (words.has(tag)) score += 4;
    return { item, score };
  }).sort((left, right) => right.score - left.score || Number(minorUnits(left.item.price) - minorUnits(right.item.price)));

  const items = [];
  let totalUnits = 0n;
  for (const { item } of rankedItems) {
    const price = minorUnits(item.price);
    if (totalUnits + price > budgetUnits) continue;
    if (!items.length || items.length < 3) {
      items.push({ ...item, quantity: 1 });
      totalUnits += price;
    }
  }
  if (!items.length) {
    throw Object.assign(new Error("No menu item fits the requested budget"), { code: "budget_too_low" });
  }

  return {
    order_id: `demo_order_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    merchant,
    items,
    currency: "XLM",
    total: decimal(totalUnits),
    budget: decimal(budgetUnits),
    prompt_summary: String(message || "").trim(),
    demo: true
  };
}

export function createVelarumArtifacts(order, options = {}) {
  const now = new Date();
  const createdAt = now.toISOString();
  const transactionId = `txn_${order.order_id}`;
  const connectionId = options.connectionId || "";
  const quote = JSON.stringify({
    merchant: order.merchant.id,
    items: order.items.map((item) => [item.id, item.quantity, item.price]),
    total: order.total,
    currency: order.currency
  });
  const evidenceHash = `sha256:${crypto.createHash("sha256").update(quote).digest("hex")}`;
  const sourceUrl = `${options.demoBaseUrl || "http://127.0.0.1:8790"}/merchants/${order.merchant.id}`;
  const source = {
    agent_id: "agentfood-reference-demo",
    agent_name: "AgentFood Reference Demo",
    runtime: "node",
    channel: "demo_website"
  };

  const transactionContext = {
    protocol: "velarum.transaction_context.v1",
    transaction_id: transactionId,
    connection_id: connectionId,
    created_at: createdAt,
    type: "generic",
    status: "awaiting_payment",
    title: `Demo order from ${order.merchant.name}`,
    summary: `AgentFood prepared a local reference order totaling ${order.total} XLM testnet units.`,
    source,
    user_intent: { prompt_summary: order.prompt_summary },
    agent_activity: [
      {
        at: createdAt,
        action: "cart_built",
        label: "Built a demo cart",
        summary: `Selected ${order.items.length} demo menu item(s) within the requested budget.`,
        source_type: "merchant_web_observed"
      },
      {
        at: createdAt,
        action: "payment_requested",
        label: "Created a Payment Request",
        summary: "Prepared a Stellar testnet request for wallet review; no signing was performed by the Agent.",
        source_type: "payment_request_fact"
      }
    ],
    items: [],
    costs: {},
    media: [],
    evidence: [
      {
        evidence_id: `evidence_${order.order_id}`,
        type: "web_snapshot",
        title: "AgentFood local demo quote",
        source_url: sourceUrl,
        captured_at: createdAt,
        hash: evidenceHash
      }
    ],
    provenance: { model: "truth_layer_v1" },
    truth_fields: [
      {
        field: "pricing.total",
        value: order.total,
        currency: order.currency,
        source_type: "merchant_web_observed",
        verification_status: "observed_only",
        evidence_ref: `evidence_${order.order_id}`,
        confidence: "medium",
        observed_at: createdAt
      }
    ],
    missing_context: ["recipient_facts_are_bound_by_platform"],
    risk_findings: [],
    metadata: {
      food_order: {
        order_id: order.order_id,
        merchant: { id: order.merchant.id, name: order.merchant.name },
        items: order.items.map((item) => ({
          item_id: item.id,
          name: item.name,
          quantity: item.quantity,
          unit_amount: item.price,
          currency: order.currency
        })),
        quote: { total: order.total, currency: order.currency },
        demo: true
      }
    }
  };

  const paymentRequest = {
    recipient_id: options.recipientId || "agentfood-reference-recipient",
    recipient_version_id: options.recipientVersionId || "agentfood-reference-recipient-v1",
    transaction_context_ref: { transaction_id: transactionId },
    expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    idempotency_key: `${order.order_id}-payment-1`,
    payment: {
      amount: order.total
    },
    display: {
      title: `Demo order from ${order.merchant.name}`,
      summary: "AgentFood prepared a Stellar testnet reference payment for review.",
      primary_action: "Review"
    },
    metadata: {
      environment: "local_reference_demo",
      demo: true,
      order_reference: crypto.createHash("sha256").update(order.order_id).digest("hex").slice(0, 24)
    }
  };

  return { transactionContext, paymentRequest };
}
