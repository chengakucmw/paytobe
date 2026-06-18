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
};

export type RequestOptions = {
  connectionToken?: string;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
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
export const validatePaymentRequest: typeof normalizePaymentRequestV1;
export const validateTransactionContext: typeof normalizeTransactionContextV1;
export { createTransactionContextSnapshot, normalizePaymentRequestV1, normalizeTransactionContextV1 };

export class VelarumPayClient {
  constructor(options?: VelarumPayClientOptions);
  baseUrl: string;
  connectionToken: string;
  headers: Record<string, string>;
  setConnectionToken(connectionToken: string): this;
  withConnectionToken(connectionToken: string): VelarumPayClient;
  createPairingSession(payload: Record<string, unknown>, options?: RequestOptions): Promise<ApiResult>;
  createTransactionContext(payload: Record<string, unknown>, options?: RequestOptions): Promise<ApiResult>;
  createPaymentRequest(payload: Record<string, unknown>, options?: RequestOptions): Promise<ApiResult>;
  getPaymentRequest(requestId: string, options?: RequestOptions): Promise<ApiResult>;
  pollEvents(options?: ({ since?: number } & RequestOptions) | number): Promise<ApiResult>;
  requestJson(method: string, path: string, body?: Record<string, unknown> | null, options?: RequestOptions): Promise<ApiResult>;
  requestHeaders(body?: Record<string, unknown> | null, options?: RequestOptions): Record<string, string>;
}

export function createVelarumPayClient(options?: VelarumPayClientOptions): VelarumPayClient;
export function createPairingSession(payload: Record<string, unknown>, options?: VelarumPayClientOptions & RequestOptions): Promise<ApiResult>;
export function createTransactionContext(payload: Record<string, unknown>, options?: VelarumPayClientOptions & RequestOptions): Promise<ApiResult>;
export function createPaymentRequest(payload: Record<string, unknown>, options?: VelarumPayClientOptions & RequestOptions): Promise<ApiResult>;
export function getPaymentRequest(requestId: string, options?: VelarumPayClientOptions & RequestOptions): Promise<ApiResult>;
export function pollEvents(options?: (VelarumPayClientOptions & RequestOptions & { since?: number }) | number): Promise<ApiResult>;
