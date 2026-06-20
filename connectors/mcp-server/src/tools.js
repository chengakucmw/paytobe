import {
  DEFAULT_BASE_URL,
  createVelarumPayClient,
  normalizeError as normalizeApiError,
  validatePaymentRequest,
  validateTransactionContext
} from "@velarumpay/sdk-js";

const DEFAULT_SCOPES = Object.freeze([
  "payment.requests.create",
  "payment.requests.read",
  "transaction_contexts.create",
  "transaction_contexts.read"
]);

const TOOL_SCOPES = new Set(DEFAULT_SCOPES);

const commonConnectionProperties = {
  base_url: {
    type: "string",
    description: "Platform API base URL. Defaults to VELARUMPAY_API_BASE_URL or http://127.0.0.1:8787."
  },
  connection_token: {
    type: "string",
    description: "Connection-scoped token approved by the wallet. Defaults to VELARUMPAY_CONNECTION_TOKEN."
  }
};

export const tools = Object.freeze([
  {
    name: "create_pairing_session",
    title: "Create Pairing Session",
    description: "Create a short-lived VelarumPay pairing session for a local agent. Requests only Payment Request and Transaction Context scopes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        base_url: commonConnectionProperties.base_url,
        agent: {
          type: "object",
          additionalProperties: true,
          properties: {
            agent_id: { type: "string" },
            agent_name: { type: "string" },
            runtime: { type: "string" },
            device_label: { type: "string" }
          },
          required: ["agent_id", "agent_name"]
        },
        requested_scopes: {
          type: "array",
          items: {
            type: "string",
            enum: DEFAULT_SCOPES
          },
          description: "Defaults to payment.requests.create/read and transaction_contexts.create/read."
        },
        expires_in_seconds: {
          type: "integer",
          minimum: 60,
          maximum: 600
        }
      },
      required: ["agent"]
    },
    outputSchema: standardOutputSchema()
  },
  {
    name: "create_transaction_context",
    title: "Create Transaction Context",
    description: "Create a velarum.transaction_context.v1 object for a scoped connection. This does not sign or submit a payment.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...commonConnectionProperties,
        transaction_context: {
          type: "object",
          additionalProperties: true,
          description: "Standard velarum.transaction_context.v1 payload."
        }
      },
      required: ["transaction_context"]
    },
    outputSchema: standardOutputSchema()
  },
  {
    name: "create_payment_request",
    title: "Create Payment Request",
    description: "Create a velarum.payment_request.v1 request for wallet review. The wallet must approve and sign locally.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...commonConnectionProperties,
        payment_request: {
          type: "object",
          additionalProperties: true,
          description: "Standard velarum.payment_request.v1 payload."
        },
        target_app_device_id: {
          type: "string",
          description: "Optional local dev wallet target device id."
        }
      },
      required: ["payment_request"]
    },
    outputSchema: standardOutputSchema()
  },
  {
    name: "get_payment_status",
    title: "Get Payment Status",
    description: "Read a Payment Request projection and status for a scoped connection. This tool cannot update status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...commonConnectionProperties,
        request_id: {
          type: "string",
          description: "Payment Request id, for example prq_123."
        }
      },
      required: ["request_id"]
    },
    outputSchema: standardOutputSchema()
  }
]);

export async function callTool(name, args = {}, settings = {}) {
  const normalizedArgs = isRecord(args) ? args : {};
  switch (name) {
    case "create_pairing_session":
      return createPairingSession(normalizedArgs, settings);
    case "create_transaction_context":
      return createTransactionContext(normalizedArgs, settings);
    case "create_payment_request":
      return createPaymentRequest(normalizedArgs, settings);
    case "get_payment_status":
      return getPaymentStatus(normalizedArgs, settings);
    default:
      return toolFailure("unknown_tool", `Unknown tool: ${name}`);
  }
}

async function createPairingSession(args, settings) {
  const agent = args.agent;
  if (!isRecord(agent)) return toolFailure("invalid_tool_input", "agent is required", "agent");
  const scopes = args.requested_scopes || DEFAULT_SCOPES;
  const scopeCheck = validateScopes(scopes);
  if (!scopeCheck.ok) return toolFailure(scopeCheck.code, scopeCheck.message, "requested_scopes");

  const payload = {
    agent,
    requested_scopes: scopeCheck.value,
    expires_in_seconds: normalizeExpiresInSeconds(args.expires_in_seconds)
  };
  const result = await clientFrom(args, settings).createPairingSession(payload);
  return resultFromApi("create_pairing_session", result);
}

async function createTransactionContext(args, settings) {
  const tokenError = requireConnectionToken(args, settings);
  if (tokenError) return tokenError;
  const payload = args.transaction_context;
  if (!isRecord(payload)) return toolFailure("invalid_tool_input", "transaction_context is required", "transaction_context");

  const localValidation = validateTransactionContextIfComplete(payload);
  if (!localValidation.ok) return validationFailure(localValidation);

  const result = await clientFrom(args, settings).createTransactionContext(payload);
  return resultFromApi("create_transaction_context", result);
}

async function createPaymentRequest(args, settings) {
  const tokenError = requireConnectionToken(args, settings);
  if (tokenError) return tokenError;
  const payload = args.payment_request;
  if (!isRecord(payload)) return toolFailure("invalid_tool_input", "payment_request is required", "payment_request");
  if (payload.policy?.requires_user_approval === false) {
    return toolFailure(
      "user_approval_required",
      "Payment Request tools cannot bypass wallet user approval",
      "payment_request.policy.requires_user_approval"
    );
  }

  const localValidation = validatePaymentRequestIfComplete(payload);
  if (!localValidation.ok) return validationFailure(localValidation);

  const requestPayload = {
    ...payload
  };
  if (args.target_app_device_id) requestPayload.target_app_device_id = args.target_app_device_id;

  const result = await clientFrom(args, settings).createPaymentRequest(requestPayload, {
    idempotencyKey: requestPayload.idempotency_key
  });
  return resultFromApi("create_payment_request", result);
}

async function getPaymentStatus(args, settings) {
  const tokenError = requireConnectionToken(args, settings);
  if (tokenError) return tokenError;
  if (!nonEmptyString(args.request_id)) return toolFailure("invalid_tool_input", "request_id is required", "request_id");

  const result = await clientFrom(args, settings).getPaymentRequest(args.request_id);
  if (result?.ok === false) return resultFromApi("get_payment_status", result);

  const request = result.payment_request || {};
  return toolSuccess({
    ok: true,
    tool: "get_payment_status",
    request_id: request.request_id || args.request_id,
    transaction_id: request.transaction_id || null,
    status: request.status || null,
    status_projection: request.status_projection || null,
    risk: request.risk || null,
    payment_request: request,
    warnings: result.warnings || []
  });
}

function clientFrom(args = {}, settings = {}) {
  return createVelarumPayClient({
    baseUrl: baseUrlFrom(args, settings),
    connectionToken: connectionTokenFrom(args, settings),
    fetch: settings.fetch || globalThis.fetch
  });
}

function baseUrlFrom(args = {}, settings = {}) {
  return String(
    args.base_url ||
    settings.baseUrl ||
    process.env.VELARUMPAY_API_BASE_URL ||
    process.env.BASE_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
}

function connectionTokenFrom(args = {}, settings = {}) {
  return String(
    args.connection_token ||
    settings.connectionToken ||
    process.env.VELARUMPAY_CONNECTION_TOKEN ||
    process.env.CONNECTION_TOKEN ||
    ""
  ).trim();
}

function requireConnectionToken(args = {}, settings = {}) {
  if (connectionTokenFrom(args, settings)) return null;
  return toolFailure(
    "connection_token_required",
    "A wallet-approved connection token is required for this tool",
    "connection_token"
  );
}

function validateScopes(scopes) {
  if (!Array.isArray(scopes)) {
    return { ok: false, code: "invalid_scope", message: "requested_scopes must be an array" };
  }
  const value = [];
  for (const rawScope of scopes) {
    const scope = String(rawScope || "").trim();
    if (!scope) return { ok: false, code: "invalid_scope", message: "requested_scopes contains an empty scope" };
    if (!TOOL_SCOPES.has(scope)) {
      return {
        ok: false,
        code: "unsupported_scope",
        message: `Scope is not supported by the MCP Payment Request tools: ${scope}`
      };
    }
    if (!value.includes(scope)) value.push(scope);
  }
  if (!value.length) {
    return { ok: false, code: "invalid_scope", message: "requested_scopes must include at least one scope" };
  }
  return { ok: true, value };
}

function normalizeExpiresInSeconds(value) {
  if (value === undefined || value === null || value === "") return 300;
  const number = Number(value);
  if (!Number.isFinite(number)) return 300;
  return Math.min(600, Math.max(60, Math.trunc(number)));
}

function validateTransactionContextIfComplete(payload) {
  if (!payload.connection_id) return { ok: true };
  return normalizeValidationResult(validateTransactionContext(payload));
}

function validatePaymentRequestIfComplete(payload) {
  const requiredForLocalValidation = [
    "request_id",
    "connection_id",
    "created_at",
    "expires_at",
    "status",
    "source",
    "payee",
    "payment",
    "policy"
  ];
  if (requiredForLocalValidation.some((field) => payload[field] === undefined || payload[field] === null)) {
    return { ok: true };
  }
  return normalizeValidationResult(validatePaymentRequest(payload));
}

function normalizeValidationResult(result) {
  if (result.ok) return { ok: true, warnings: result.warnings || [] };
  return {
    ok: false,
    error: normalizeError(result.error),
    errors: (result.errors || [result.error]).map(normalizeError),
    warnings: (result.warnings || []).map(normalizeError)
  };
}

function validationFailure(validation) {
  return toolResult({
    ok: false,
    error: validation.error,
    errors: validation.errors || [validation.error],
    warnings: validation.warnings || []
  }, true);
}

function resultFromApi(tool, result) {
  if (result?.ok === false) {
    return toolResult({
      ok: false,
      tool,
      error: normalizeError(result.error),
      errors: (result.errors || [result.error]).map(normalizeError),
      warnings: (result.warnings || []).map(normalizeError),
      status: result.status
    }, true);
  }
  return toolSuccess({
    ok: true,
    tool,
    ...result,
    warnings: (result?.warnings || []).map(normalizeError)
  });
}

function toolSuccess(data) {
  return toolResult(data, false);
}

function toolFailure(code, message, field = "") {
  return toolResult({
    ok: false,
    error: normalizeError({
      code,
      message,
      field,
      severity: "blocker"
    }),
    errors: [
      normalizeError({
        code,
        message,
        field,
        severity: "blocker"
      })
    ],
    warnings: []
  }, true);
}

function toolResult(data, isError) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ],
    structuredContent: data,
    isError
  };
}

function normalizeError(error) {
  return normalizeApiError(error, { message: "Request failed", emptyField: true });
}

function standardOutputSchema() {
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      ok: { type: "boolean" },
      error: {
        type: "object",
        additionalProperties: true,
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          field: { type: "string" },
          severity: { type: "string" }
        }
      },
      warnings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true
        }
      }
    }
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
