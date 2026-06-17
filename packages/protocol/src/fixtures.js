import {
  BASE_USDC_CONTRACT,
  PAYMENT_REQUEST_PROTOCOL,
  TRANSACTION_CONTEXT_PROTOCOL
} from "./constants.js";

const NOW = "2026-06-17T10:00:00.000Z";
const FUTURE = "2026-12-31T10:05:00.000Z";
const EXPIRED = "2026-06-16T10:05:00.000Z";
const BASE_TO = "0x9b1c2f4e3a8d5c6b7e9f0a1b2c3d4e5f60718293";
const STELLAR_TO = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export const protocolFixtureClock = Object.freeze({
  now: NOW,
  future: FUTURE,
  expired: EXPIRED
});

export const transactionContextFixtures = Object.freeze({
  valid: deepFreeze({
    protocol: TRANSACTION_CONTEXT_PROTOCOL,
    transaction_id: "txn_agentfood_1842",
    connection_id: "conn_agentfood_demo",
    created_at: NOW,
    type: "food_order",
    status: "awaiting_payment",
    title: "Dinner order from Oaxaca Kitchen",
    summary: "AgentFood built your dinner order under the limit you set.",
    source: {
      agent_id: "agt_agentfood",
      agent_name: "AgentFood",
      runtime: "hermes",
      channel: "local_desktop"
    },
    user_intent: {
      prompt_summary: "Order dinner from Oaxaca Kitchen, keep it under 30 USDC."
    },
    agent_activity: [
      {
        at: NOW,
        action: "intent_received",
        label: "Read your request",
        summary: "You asked AgentFood to order dinner and keep the total under 30 USDC.",
        source_type: "user_provided"
      },
      {
        at: NOW,
        action: "cart_built",
        label: "Built a cart",
        summary: "Selected Mole Negro Plate, Horchata, tax and service.",
        source_type: "merchant_web_observed"
      },
      {
        at: NOW,
        action: "payment_requested",
        label: "Created Payment Request",
        summary: "Prepared a single USDC transfer on Base for review.",
        source_type: "payment_request_fact"
      }
    ],
    items: [
      {
        item_id: "item_mole_negro",
        name: "Mole Negro Plate",
        quantity: 1,
        unit_amount: "16.00",
        currency: "USDC"
      },
      {
        item_id: "item_horchata",
        name: "Horchata",
        quantity: 1,
        unit_amount: "4.00",
        currency: "USDC"
      }
    ],
    costs: {
      subtotal: "20.00",
      tax: "2.40",
      service_fee: "1.60",
      total: "24.00",
      currency: "USDC"
    },
    media: [
      {
        media_id: "media_oaxaca_logo",
        type: "merchant_logo",
        title: "Oaxaca Kitchen",
        source_type: "platform_verified"
      }
    ],
    evidence: [
      {
        evidence_id: "ev_agentfood_quote",
        type: "signed_quote",
        title: "AgentFood signed checkout quote",
        source_url: "https://agentfood.example/orders/1842",
        captured_at: NOW,
        hash: "sha256:agentfood1842",
        signature: {
          algorithm: "ed25519",
          verified: true,
          key_id: "agentfood_demo_key_2026_01"
        }
      },
      {
        evidence_id: "ev_oaxaca_address_binding",
        type: "address_binding",
        title: "Oaxaca Kitchen recipient binding",
        captured_at: NOW,
        hash: "sha256:oaxaca-binding"
      }
    ],
    provenance: {
      model: "truth_layer_v1"
    },
    truth_fields: [
      {
        field: "pricing.total",
        value: "24.00",
        currency: "USDC",
        source_type: "merchant_signed_quote",
        verification_status: "signature_verified",
        evidence_ref: "ev_agentfood_quote",
        confidence: "high",
        observed_at: NOW
      },
      {
        field: "payment.to",
        value: BASE_TO,
        source_type: "platform_verified",
        verification_status: "address_verified",
        evidence_ref: "ev_oaxaca_address_binding",
        confidence: "high",
        observed_at: NOW
      }
    ],
    missing_context: [],
    risk_findings: []
  }),
  missing_context: deepFreeze({
    protocol: TRANSACTION_CONTEXT_PROTOCOL,
    transaction_id: "txn_missing_evidence_169",
    connection_id: "conn_gearscout_demo",
    created_at: NOW,
    type: "online_purchase",
    status: "awaiting_payment",
    title: "Hardware wallet reservation",
    summary: "The Payment Request arrived, but item evidence and source pages are missing.",
    source: {
      agent_id: "agt_gearscout",
      agent_name: "GearScout",
      runtime: "hermes",
      channel: "local_desktop"
    },
    user_intent: {
      prompt_summary: "Reserve a hardware wallet."
    },
    agent_activity: [
      {
        at: NOW,
        action: "payment_facts_received",
        label: "Received payment facts",
        summary: "Amount, token, network and recipient are visible.",
        source_type: "payment_request_fact"
      },
      {
        at: NOW,
        action: "context_missing",
        label: "Context missing",
        summary: "Items, source page and agent reasoning are unavailable.",
        source_type: "unknown"
      }
    ],
    items: [],
    costs: {
      total: "169.00",
      currency: "USDC"
    },
    media: [],
    evidence: [],
    provenance: {
      model: "truth_layer_v1"
    },
    truth_fields: [
      {
        field: "payment.amount",
        value: "169.00",
        currency: "USDC",
        source_type: "payment_request_fact",
        verification_status: "observed_only",
        observed_at: NOW
      }
    ],
    missing_context: [
      {
        field: "items",
        reason: "Product evidence was not received from context.",
        severity: "warning"
      },
      {
        field: "evidence.checkout_page",
        reason: "Source checkout page is missing.",
        severity: "review_required"
      }
    ],
    risk_findings: [
      {
        code: "critical_field_missing_evidence",
        severity: "warning",
        field: "items",
        message: "Item evidence is missing."
      }
    ]
  }),
  mismatch: deepFreeze({
    protocol: TRANSACTION_CONTEXT_PROTOCOL,
    transaction_id: "txn_hotel_mismatch_240",
    connection_id: "conn_tripplanner_demo",
    created_at: NOW,
    type: "travel_booking",
    status: "awaiting_payment",
    title: "Hotel deposit with payee mismatch",
    summary: "The verified hotel profile does not match the payment recipient.",
    source: {
      agent_id: "agt_tripplanner",
      agent_name: "TripPlanner",
      runtime: "hermes",
      channel: "local_desktop"
    },
    user_intent: {
      prompt_summary: "Hold a refundable hotel deposit under 250 USDC."
    },
    agent_activity: [
      {
        at: NOW,
        action: "mismatch_detected",
        label: "Detected mismatch",
        summary: "The transfer recipient differs from the verified hotel address.",
        source_type: "platform_verified"
      }
    ],
    items: [
      {
        item_id: "hotel_deposit",
        name: "Hotel deposit",
        quantity: 1,
        unit_amount: "240.00",
        currency: "USDC"
      }
    ],
    costs: {
      total: "240.00",
      currency: "USDC"
    },
    media: [],
    evidence: [
      {
        evidence_id: "ev_canal_house_profile",
        type: "address_binding",
        title: "Canal House Hotel verified profile",
        captured_at: NOW,
        hash: "sha256:canal-profile"
      }
    ],
    provenance: {
      model: "truth_layer_v1"
    },
    truth_fields: [
      {
        field: "payee.name",
        value: "Canal House Hotel",
        source_type: "platform_verified",
        verification_status: "domain_verified",
        evidence_ref: "ev_canal_house_profile",
        confidence: "high",
        observed_at: NOW
      },
      {
        field: "payment.to",
        value: "0xa40d9123e72c0445fd19aa00beef9981742c19dd",
        source_type: "payment_request_fact",
        verification_status: "conflicted",
        evidence_ref: "ev_canal_house_profile",
        confidence: "high",
        observed_at: NOW
      }
    ],
    missing_context: [],
    risk_findings: [
      {
        code: "payee_mismatch",
        severity: "blocker",
        field: "payment.to",
        message: "The payment recipient differs from the verified hotel address."
      }
    ]
  }),
  ai_only: deepFreeze({
    protocol: TRANSACTION_CONTEXT_PROTOCOL,
    transaction_id: "txn_ai_only_course_99",
    connection_id: "conn_learnscout_demo",
    created_at: NOW,
    type: "online_purchase",
    status: "awaiting_payment",
    title: "Course checkout with AI-only refund claim",
    summary: "Refund and access terms are supported only by AI claims and page observation.",
    source: {
      agent_id: "agt_learnscout",
      agent_name: "LearnScout",
      runtime: "hermes",
      channel: "local_desktop"
    },
    user_intent: {
      prompt_summary: "Find a practical API security course under 120 USDC with refund protection."
    },
    agent_activity: [
      {
        at: NOW,
        action: "options_compared",
        label: "Compared options",
        summary: "LearnScout compared three course pages and selected NovaCourse Lab.",
        source_type: "user_agent_inferred"
      },
      {
        at: NOW,
        action: "weak_claims_captured",
        label: "Captured weak claims",
        summary: "Refund policy came from merchant AI and access terms came from page observation only.",
        source_type: "merchant_ai_claim"
      }
    ],
    items: [
      {
        item_id: "api_security_course",
        name: "API Security Course",
        quantity: 1,
        unit_amount: "99.00",
        currency: "USDC"
      }
    ],
    costs: {
      total: "99.00",
      currency: "USDC"
    },
    media: [],
    evidence: [
      {
        evidence_id: "ev_course_page",
        type: "web_snapshot",
        title: "Course landing page",
        source_url: "https://novacourse.example/api-security",
        captured_at: NOW,
        hash: "sha256:novacourse-page"
      },
      {
        evidence_id: "ev_merchant_ai_chat",
        type: "agent_summary",
        title: "Merchant AI refund chat",
        captured_at: NOW,
        hash: "sha256:merchant-ai-chat"
      }
    ],
    provenance: {
      model: "truth_layer_v1"
    },
    truth_fields: [
      {
        field: "pricing.total",
        value: "99.00",
        currency: "USDC",
        source_type: "merchant_web_observed",
        verification_status: "observed_only",
        evidence_ref: "ev_course_page",
        confidence: "medium",
        observed_at: NOW
      },
      {
        field: "refund_policy",
        value: "7-day refund",
        source_type: "merchant_ai_claim",
        verification_status: "ai_claim_only",
        evidence_ref: "ev_merchant_ai_chat",
        confidence: "low",
        observed_at: NOW
      },
      {
        field: "recommendation",
        value: "Best fit under budget",
        source_type: "user_agent_inferred",
        verification_status: "inferred_only",
        confidence: "medium",
        observed_at: NOW
      }
    ],
    missing_context: [
      {
        field: "evidence.signed_quote",
        reason: "Signed checkout quote was not received.",
        severity: "review_required"
      },
      {
        field: "payee.address_binding",
        reason: "Payee domain is not bound to recipient address.",
        severity: "warning"
      }
    ],
    risk_findings: [
      {
        code: "merchant_ai_claim_only",
        severity: "warning",
        field: "refund_policy",
        message: "Refund policy only comes from merchant AI."
      },
      {
        code: "critical_field_missing_evidence",
        severity: "warning",
        field: "evidence.signed_quote",
        message: "Signed quote was not received."
      }
    ]
  })
});

export const paymentRequestFixtures = Object.freeze({
  valid_base_usdc: deepFreeze({
    protocol: PAYMENT_REQUEST_PROTOCOL,
    request_id: "prq_agentfood_1842",
    connection_id: "conn_agentfood_demo",
    transaction_id: "txn_agentfood_1842",
    created_at: NOW,
    expires_at: FUTURE,
    idempotency_key: "agentfood-run-1842-payment-1",
    status: "pending",
    source: {
      agent_id: "agt_agentfood",
      agent_name: "AgentFood",
      runtime: "hermes",
      channel: "local_desktop"
    },
    payee: {
      name: "Oaxaca Kitchen",
      domain: "oaxaca.example",
      verified: true
    },
    payment: {
      rail: "base_usdc",
      network: "base_mainnet",
      asset: "USDC",
      amount: "24.00",
      to: BASE_TO,
      token_contract: BASE_USDC_CONTRACT,
      chain_id: 8453,
      decimals: 6,
      estimated_fee: "0.01"
    },
    display: {
      title: "Dinner order from Oaxaca Kitchen",
      summary: "AgentFood prepared a one-time USDC payment.",
      primary_action: "Pay"
    },
    policy: {
      requires_user_approval: true
    },
    transaction_context_snapshot: {
      transaction_id: "txn_agentfood_1842",
      snapshot_hash: "sha256:agentfood1842snapshot",
      truth_fields: transactionContextFixtures.valid.truth_fields,
      evidence: transactionContextFixtures.valid.evidence,
      missing_context: [],
      risk_findings: []
    },
    metadata: {
      type: "food_order",
      food_order: {
        order_id: "ord_agentfood_1842",
        restaurant: {
          name: "Oaxaca Kitchen"
        }
      }
    }
  }),
  valid_stellar_xlm: deepFreeze({
    protocol: PAYMENT_REQUEST_PROTOCOL,
    request_id: "prq_stellar_xlm_1001",
    connection_id: "conn_stellar_demo",
    transaction_id: "txn_stellar_xlm_1001",
    created_at: NOW,
    expires_at: FUTURE,
    idempotency_key: "stellar-demo-payment-1",
    status: "pending",
    source: {
      agent_id: "agt_bookworm",
      agent_name: "Bookworm",
      runtime: "hermes",
      channel: "local_desktop"
    },
    payee: {
      name: "Harbor Books",
      domain: "harborbooks.example",
      verified: false
    },
    payment: {
      rail: "stellar_xlm",
      network: "stellar_testnet",
      asset: "XLM",
      amount: "32.50",
      to: STELLAR_TO,
      memo: "book-order-1001",
      estimated_fee: "0.00001"
    },
    display: {
      title: "Book order request",
      summary: "Bookworm prepared a Stellar XLM testnet payment.",
      primary_action: "Pay"
    },
    policy: {
      requires_user_approval: true
    },
    metadata: {
      type: "online_purchase"
    }
  }),
  legacy_base_alias: deepFreeze({
    protocol: PAYMENT_REQUEST_PROTOCOL,
    request_id: "prq_legacy_base_alias",
    connection_id: "conn_legacy_demo",
    transaction_id: "txn_agentfood_1842",
    created_at: NOW,
    expires_at: FUTURE,
    idempotency_key: "legacy-base-alias-payment-1",
    status: "pending",
    source: {
      agent_id: "agt_legacy",
      agent_name: "Legacy OpenClaw",
      runtime: "openclaw",
      channel: "telegram"
    },
    payee: {
      name: "Oaxaca Kitchen",
      verified: false
    },
    payment: {
      rail: "evm_erc20",
      network: "base_mainnet",
      asset: "USDC",
      amount: "24.00",
      to: BASE_TO,
      token_contract: BASE_USDC_CONTRACT,
      chain_id: 8453,
      decimals: 6
    },
    policy: {
      requires_user_approval: true
    }
  }),
  missing_context: deepFreeze({
    protocol: PAYMENT_REQUEST_PROTOCOL,
    request_id: "prq_missing_evidence_169",
    connection_id: "conn_gearscout_demo",
    transaction_id: "txn_missing_evidence_169",
    created_at: NOW,
    expires_at: FUTURE,
    idempotency_key: "gearscout-reservation-payment-1",
    status: "pending",
    source: {
      agent_id: "agt_gearscout",
      agent_name: "GearScout",
      runtime: "hermes",
      channel: "local_desktop"
    },
    payee: {
      name: "Northstar Devices",
      domain: "northstar.example",
      verified: false
    },
    payment: {
      rail: "base_usdc",
      network: "base_mainnet",
      asset: "USDC",
      amount: "169.00",
      to: "0x71d83a5924b0e6d3c8a9f102bb48e4c912a556d0",
      token_contract: BASE_USDC_CONTRACT,
      chain_id: 8453,
      decimals: 6,
      estimated_fee: "0.02"
    },
    policy: {
      requires_user_approval: true
    },
    transaction_context_snapshot: {
      transaction_id: "txn_missing_evidence_169",
      snapshot_hash: "sha256:missing-context",
      truth_fields: transactionContextFixtures.missing_context.truth_fields,
      evidence: [],
      missing_context: transactionContextFixtures.missing_context.missing_context,
      risk_findings: transactionContextFixtures.missing_context.risk_findings
    }
  }),
  mismatch: deepFreeze({
    protocol: PAYMENT_REQUEST_PROTOCOL,
    request_id: "prq_hotel_mismatch_240",
    connection_id: "conn_tripplanner_demo",
    transaction_id: "txn_hotel_mismatch_240",
    created_at: NOW,
    expires_at: FUTURE,
    idempotency_key: "tripplanner-hotel-deposit-payment-1",
    status: "pending",
    source: {
      agent_id: "agt_tripplanner",
      agent_name: "TripPlanner",
      runtime: "hermes",
      channel: "local_desktop"
    },
    payee: {
      name: "Canal House Hotel",
      domain: "canalhouse.example",
      verified: true
    },
    payment: {
      rail: "base_usdc",
      network: "base_mainnet",
      asset: "USDC",
      amount: "240.00",
      to: "0xa40d9123e72c0445fd19aa00beef9981742c19dd",
      token_contract: BASE_USDC_CONTRACT,
      chain_id: 8453,
      decimals: 6,
      estimated_fee: "0.03"
    },
    policy: {
      requires_user_approval: true
    },
    transaction_context_snapshot: {
      transaction_id: "txn_hotel_mismatch_240",
      snapshot_hash: "sha256:hotel-mismatch",
      truth_fields: transactionContextFixtures.mismatch.truth_fields,
      evidence: transactionContextFixtures.mismatch.evidence,
      missing_context: [],
      risk_findings: transactionContextFixtures.mismatch.risk_findings
    }
  }),
  ai_only: deepFreeze({
    protocol: PAYMENT_REQUEST_PROTOCOL,
    request_id: "prq_ai_only_course_99",
    connection_id: "conn_learnscout_demo",
    transaction_id: "txn_ai_only_course_99",
    created_at: NOW,
    expires_at: FUTURE,
    idempotency_key: "learnscout-course-payment-1",
    status: "pending",
    source: {
      agent_id: "agt_learnscout",
      agent_name: "LearnScout",
      runtime: "hermes",
      channel: "local_desktop"
    },
    payee: {
      name: "NovaCourse Lab",
      domain: "novacourse.example",
      verified: false
    },
    payment: {
      rail: "base_usdc",
      network: "base_mainnet",
      asset: "USDC",
      amount: "99.00",
      to: "0x6e182544a17bc2206ad7095b61f884e7f2d1d40b",
      token_contract: BASE_USDC_CONTRACT,
      chain_id: 8453,
      decimals: 6,
      estimated_fee: "0.01"
    },
    policy: {
      requires_user_approval: true
    },
    transaction_context_snapshot: {
      transaction_id: "txn_ai_only_course_99",
      snapshot_hash: "sha256:ai-only-course",
      truth_fields: transactionContextFixtures.ai_only.truth_fields,
      evidence: transactionContextFixtures.ai_only.evidence,
      missing_context: transactionContextFixtures.ai_only.missing_context,
      risk_findings: transactionContextFixtures.ai_only.risk_findings
    }
  }),
  expired: deepFreeze({
    protocol: PAYMENT_REQUEST_PROTOCOL,
    request_id: "prq_expired_books_3250",
    connection_id: "conn_bookworm_demo",
    transaction_id: "txn_expired_books_3250",
    created_at: "2026-06-16T10:00:00.000Z",
    expires_at: EXPIRED,
    idempotency_key: "bookworm-books-payment-1",
    status: "pending",
    source: {
      agent_id: "agt_bookworm",
      agent_name: "Bookworm",
      runtime: "hermes",
      channel: "local_desktop"
    },
    payee: {
      name: "Harbor Books",
      domain: "harborbooks.example",
      verified: true
    },
    payment: {
      rail: "base_usdc",
      network: "base_mainnet",
      asset: "USDC",
      amount: "32.50",
      to: "0xde72a400b0c11e907a2234017f44ba7002d801ac",
      token_contract: BASE_USDC_CONTRACT,
      chain_id: 8453,
      decimals: 6
    },
    policy: {
      requires_user_approval: true
    }
  }),
  network_disabled: deepFreeze({
    protocol: PAYMENT_REQUEST_PROTOCOL,
    request_id: "prq_network_disabled_300",
    connection_id: "conn_airdrop_demo",
    transaction_id: "txn_network_disabled_300",
    created_at: NOW,
    expires_at: FUTURE,
    idempotency_key: "airdrop-disabled-network-payment-1",
    status: "pending",
    source: {
      agent_id: "agt_airdrop",
      agent_name: "AirdropBot",
      runtime: "hermes",
      channel: "local_desktop"
    },
    payee: {
      name: "Base Sepolia Faucet",
      verified: false
    },
    payment: {
      rail: "base_usdc",
      network: "base_sepolia",
      asset: "USDC",
      amount: "3.00",
      to: "0x5ee5d9c63a3224f0f7c9a43a317fd2d25bb50001",
      token_contract: BASE_USDC_CONTRACT,
      chain_id: 84532,
      decimals: 6
    },
    policy: {
      requires_user_approval: true
    }
  })
});

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
