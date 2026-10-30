import assert from "node:assert/strict";

const DEVICE_TOKEN_SUFFIX = "123456789012345678901234567890";
const STELLAR_TEST_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export function createAdapterContractHarness({ name, call, registeredAgentToken = "", recipientBound = false }) {
  let generation = 0;

  return Object.freeze({
    name,
    async reset() {
      generation += 1;
      return `${name}-${generation}`;
    },
    async scenarioHealth() {
      return normalize(await call("/health"));
    },
    async scenarioErrorEnvelope() {
      return normalize(await call("/v1/adapter-contract-unknown"));
    },
    async scenarioMissingAuthContext() {
      return normalize(await call("/v1/payment-requests", { method: "POST", payload: {} }));
    },
    async scenarioIdempotencyConflict() {
      const suffix = await this.reset();
      const connection = await establishConnection({ call, suffix, registeredAgentToken });
      const key = `contract-order-${suffix}`;
      const firstRequestId = `contract-request-${suffix}-a`;
      const firstPayload = paymentPayload(firstRequestId, key, "1.25", recipientBound);
      const secondPayload = paymentPayload(`contract-request-${suffix}-b`, key, "9.75", recipientBound);
      const headers = { authorization: `Bearer ${connection.connection_token}`, "x-idempotency-key": key };
      const first = await parse(await call("/v1/payment-requests", { method: "POST", headers, payload: firstPayload }));
      const second = await parse(await call("/v1/payment-requests", { method: "POST", headers, payload: secondPayload }));
      return {
        first_status: first.status,
        second_status: second.status,
        second_error_code: second.body?.error?.code || null,
        duplicate: second.body?.duplicate === true,
        returned_original_request: second.body?.payment_request?.request_id === firstRequestId
      };
    }
  });
}

export function requestOptions({ method = "GET", payload, headers = {} } = {}) {
  return {
    method,
    headers: {
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
      ...headers
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  };
}

async function establishConnection({ call, suffix, registeredAgentToken }) {
  const device = { device_id: `device-${suffix}`, token: `awt_${suffix}_${DEVICE_TOKEN_SUFFIX}` };
  const registered = await parse(await call("/v1/devices/app", { method: "POST", payload: device }));
  assert.equal(registered.status, 200, `${suffix}: register device`);
  const created = await parse(await call("/v1/connect-invitations", { method: "POST", payload: { ...device, expires_in_seconds: 300 } }));
  assert.equal(created.status, 201, `${suffix}: create invitation`);
  const claimHeaders = registeredAgentToken ? { authorization: `Bearer ${registeredAgentToken}` } : {};
  const claimed = await parse(await call("/v1/connect-invitations/claim", {
    method: "POST",
    headers: claimHeaders,
    payload: {
      connect_key: created.body.connect_key,
      requested_scopes: ["payment.requests.create", "payment.requests.read"]
    }
  }));
  assert.equal(claimed.status, 201, `${suffix}: claim invitation`);
  const pairingId = claimed.body.pairing_session.pairing_session_id;
  const approved = await parse(await call(`/v1/pairing/sessions/${encodeURIComponent(pairingId)}/approve`, {
    method: "POST",
    payload: { ...device, approved_scopes: ["payment.requests.create", "payment.requests.read"] }
  }));
  assert.ok([200, 201].includes(approved.status), `${suffix}: approve invitation`);
  const invitationId = claimed.body.connect_invitation.connect_invitation_id;
  const exchanged = await parse(await call(`/v1/connect-invitations/${encodeURIComponent(invitationId)}/exchange`, {
    method: "POST",
    headers: { authorization: `Bearer ${claimed.body.claim_token}` },
    payload: {}
  }));
  assert.equal(exchanged.status, 200, `${suffix}: exchange invitation`);
  return exchanged.body.connection;
}

function paymentPayload(requestId, idempotencyKey, amount, recipientBound) {
  const createdAt = new Date().toISOString();
  if (recipientBound) {
    return {
      recipient_id: "recipient-contract-fixture",
      recipient_version_id: "recipient-version-contract-fixture",
      idempotency_key: idempotencyKey,
      expires_at: new Date(Date.parse(createdAt) + 5 * 60 * 1000).toISOString(),
      payment: { amount },
      policy: { requires_user_approval: true }
    };
  }
  return {
    protocol: "Paytobe.payment_request.v1",
    request_id: requestId,
    idempotency_key: idempotencyKey,
    created_at: createdAt,
    expires_at: new Date(Date.parse(createdAt) + 5 * 60 * 1000).toISOString(),
    status: "pending",
    source: { type: "agent", name: "Adapter contract" },
    payee: { name: "Synthetic test recipient", verified: false },
    payment: {
      rail: "stellar_xlm",
      network: "stellar_testnet",
      stellar_testnet: true,
      asset: "XLM",
      amount,
      to: STELLAR_TEST_ADDRESS
    },
    policy: { requires_user_approval: true }
  };
}

async function normalize(response) {
  const parsed = await parse(response);
  return {
    status: parsed.status,
    ok: typeof parsed.body?.ok === "boolean" ? parsed.body.ok : null,
    error_code: parsed.body?.error?.code || null,
    has_request_id: Boolean(parsed.body?.error?.request_id)
  };
}

async function parse(response) {
  const contentType = response.headers.get("content-type") || "";
  return {
    status: response.status,
    body: contentType.includes("application/json") ? await response.json() : null
  };
}
