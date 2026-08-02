import type {
  createTransactionContextSnapshot,
  normalizePaymentRequestV1,
  normalizeTransactionContextV1
} from "@velarumpay/protocol";

export type VelarumPayClientOptions = {
  baseUrl?: string;
  connectionToken?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  agentAuth?: AgentAuthOptions;
  csrfToken?: string | (() => string);
  requestIdFactory?: () => string;
};

export type AgentSignerInput = {
  signingInput: string;
  data: Uint8Array;
  protectedHeader: Readonly<Record<string, unknown>>;
  claims: Readonly<Record<string, unknown>>;
  keyHandle: unknown;
};

export type AgentAuthOptions = {
  agentId: string;
  clientId: string;
  kid: string;
  scopes: string[];
  signer: (input: AgentSignerInput) => Promise<string | Uint8Array> | string | Uint8Array;
  keyHandle?: unknown;
  audience?: string;
  now?: () => number;
  createJti?: () => string;
  refreshSkewSeconds?: number;
};

export type RequestOptions = {
  connectionToken?: string;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
  requestId?: string;
  auth?: "connection" | "agent" | "merchant" | "none";
  retryUnauthorized?: boolean;
};

export type ApiError = {
  code: string;
  message: string;
  field?: string;
  severity: string;
  details?: Record<string, unknown>;
};

export type ApiResult<T extends Record<string, unknown> = Record<string, unknown>> = T & {
  ok?: boolean;
  status?: number;
  error?: ApiError;
  errors?: ApiError[];
  warnings?: unknown[];
};

export const DEFAULT_BASE_URL: string;
export const DEFAULT_AGENT_TOKEN_AUDIENCE: string;
export const validatePaymentRequest: typeof normalizePaymentRequestV1;
export const validateTransactionContext: typeof normalizeTransactionContextV1;
export { createTransactionContextSnapshot, normalizePaymentRequestV1, normalizeTransactionContextV1 };

export class VelarumPayClient {
  constructor(options?: VelarumPayClientOptions);
  baseUrl: string;
  connectionToken: string;
  headers: Record<string, string>;
  agentAuth: Readonly<AgentAuthOptions> | null;
  csrfToken: string | (() => string);
  setConnectionToken(connectionToken: string): this;
  withConnectionToken(connectionToken: string): VelarumPayClient;
  createPairingSession(payload: Record<string, unknown>, options?: RequestOptions): Promise<ApiResult>;
  createTransactionContext(payload: Record<string, unknown>, options?: RequestOptions): Promise<ApiResult>;
  createPaymentRequest(payload: Record<string, unknown>, options?: RequestOptions): Promise<ApiResult>;
  getPaymentRequest(requestId: string, options?: RequestOptions): Promise<ApiResult>;
  pollEvents(options?: ({ since?: number } & RequestOptions) | number): Promise<ApiResult>;
  exchangeAgentToken(): Promise<ApiResult>;
  clearAgentToken(): void;
  claimConnectInvitation(connectKey: string, requestedScopes: string[], options?: RequestOptions): Promise<ApiResult>;
  getConnectInvitation(invitationId: string, claimToken: string, options?: RequestOptions): Promise<ApiResult>;
  exchangeConnectInvitation(invitationId: string, claimToken: string, options?: RequestOptions & { setConnectionToken?: boolean }): Promise<ApiResult>;
  listAgents(options?: RequestOptions): Promise<ApiResult>;
  getAgent(agentId: string, options?: RequestOptions): Promise<ApiResult>;
  createAgent(payload: Record<string, unknown>, options?: RequestOptions): Promise<ApiResult>;
  updateAgent(agentId: string, payload: Record<string, unknown>, options?: RequestOptions): Promise<ApiResult>;
  listAgentCredentials(agentId: string, options?: RequestOptions): Promise<ApiResult>;
  registerAgentCredential(agentId: string, payload: Record<string, unknown>, options?: RequestOptions): Promise<ApiResult>;
  activateAgentCredential(agentId: string, credentialId: string, payload: Record<string, unknown>, options?: RequestOptions): Promise<ApiResult>;
  revokeAgentCredential(agentId: string, credentialId: string, payload: Record<string, unknown>, options?: RequestOptions): Promise<ApiResult>;
  listRecipients(options?: RequestOptions): Promise<ApiResult>;
  getRecipient(recipientId: string, options?: RequestOptions): Promise<ApiResult>;
  createRecipient(payload: Record<string, unknown>, options?: RequestOptions): Promise<ApiResult>;
  createRecipientVersion(recipientId: string, payload: Record<string, unknown>, options?: RequestOptions): Promise<ApiResult>;
  verifyRecipient(recipientId: string, payload: Record<string, unknown>, options?: RequestOptions): Promise<ApiResult>;
  activateRecipientVersion(recipientId: string, versionId: string, payload: Record<string, unknown>, options?: RequestOptions): Promise<ApiResult>;
  listWebhookEndpoints(options?: RequestOptions): Promise<ApiResult>;
  createWebhookEndpoint(payload: Record<string, unknown>, options?: RequestOptions): Promise<ApiResult>;
  verifyWebhookEndpoint(endpointId: string, options?: RequestOptions): Promise<ApiResult>;
  rotateWebhookSecret(endpointId: string, options?: RequestOptions): Promise<ApiResult>;
  revokeWebhookEndpoint(endpointId: string, options?: RequestOptions): Promise<ApiResult>;
  listWebhookDeliveries(options?: RequestOptions): Promise<ApiResult>;
  replayWebhookDelivery(deliveryId: string, options?: RequestOptions): Promise<ApiResult>;
  requestJson(method: string, path: string, body?: Record<string, unknown> | null, options?: RequestOptions): Promise<ApiResult>;
  requestHeaders(body?: Record<string, unknown> | null, options?: RequestOptions): Record<string, string>;
}

export function createVelarumPayClient(options?: VelarumPayClientOptions): VelarumPayClient;
export function createPairingSession(payload: Record<string, unknown>, options?: VelarumPayClientOptions & RequestOptions): Promise<ApiResult>;
export function createTransactionContext(payload: Record<string, unknown>, options?: VelarumPayClientOptions & RequestOptions): Promise<ApiResult>;
export function createPaymentRequest(payload: Record<string, unknown>, options?: VelarumPayClientOptions & RequestOptions): Promise<ApiResult>;
export function getPaymentRequest(requestId: string, options?: VelarumPayClientOptions & RequestOptions): Promise<ApiResult>;
export function pollEvents(options?: (VelarumPayClientOptions & RequestOptions & { since?: number }) | number): Promise<ApiResult>;
export function verifyWebhookSignature(
  secret: string,
  rawBody: string | Uint8Array | ArrayBuffer,
  signatureHeader: string,
  options?: { toleranceSeconds?: number; now?: () => number }
): Promise<{ ok: true; timestamp: number } | { ok: false; code: string; message: string }>;
