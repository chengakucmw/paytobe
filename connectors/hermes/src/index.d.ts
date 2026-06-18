import type { ApiResult, VelarumPayClient, VelarumPayClientOptions } from "@velarumpay/sdk-js";

export type HermesAgentIdentity = {
  agent_id: string;
  agent_name: string;
  runtime?: string;
  device_label?: string;
  channel?: string;
  [key: string]: unknown;
};

export type HermesAdapterOptions = VelarumPayClientOptions & {
  connectionId?: string;
  agent?: HermesAgentIdentity;
  now?: string | Date | (() => string | Date);
  client?: VelarumPayClient;
};

export type HermesPrepareResult = ApiResult<{
  transaction_id?: string;
  request_id?: string;
  transaction_context?: Record<string, unknown>;
  payment_request?: Record<string, unknown>;
}>;

export const HERMES_DEFAULT_SCOPES: readonly string[];
export const HERMES_STATUS_TRANSPORTS: readonly string[];
export const DEFAULT_HERMES_AGENT: Readonly<HermesAgentIdentity>;

export class HermesPaymentRequestAdapter {
  constructor(options?: HermesAdapterOptions);
  baseUrl: string;
  connectionToken: string;
  connectionId: string;
  agent: HermesAgentIdentity;
  client: VelarumPayClient;
  setConnectionToken(connectionToken: string): this;
  createPairingSession(options?: Record<string, unknown>): Promise<ApiResult>;
  preparePaymentRequest(input?: Record<string, unknown>): HermesPrepareResult;
  createStandardPaymentRequest(input?: Record<string, unknown>, options?: Record<string, unknown>): Promise<HermesPrepareResult>;
  getPaymentStatus(requestId: string, options?: Record<string, unknown>): Promise<ApiResult>;
  pollStatusEvents(options?: Record<string, unknown>): Promise<ApiResult>;
  agentWebSocketUrl(options?: Record<string, unknown>): string;
}

export function createHermesPaymentRequestAdapter(options?: HermesAdapterOptions): HermesPaymentRequestAdapter;
export function prepareHermesPaymentRequest(input?: Record<string, unknown>, options?: HermesAdapterOptions): HermesPrepareResult;
