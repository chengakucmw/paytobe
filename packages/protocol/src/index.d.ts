export type ValidationIssue = {
  code: string;
  message: string;
  field?: string;
  severity?: "blocker" | "warning" | "review_required" | "info" | string;
  details?: Record<string, unknown>;
};

export type ValidationResult<T = Record<string, unknown>> = {
  ok: boolean;
  value?: T;
  error?: ValidationIssue;
  errors?: ValidationIssue[];
  warnings?: ValidationIssue[];
};

export const PAYMENT_REQUEST_PROTOCOL: "velarum.payment_request.v1";
export const TRANSACTION_CONTEXT_PROTOCOL: "velarum.transaction_context.v1";
export const BASE_USDC_CONTRACT: string;
export const PAYMENT_RAILS: readonly string[];
export const CANONICAL_PAYMENT_RAILS: readonly string[];
export const SUPPORTED_TRANSFER_ASSETS: readonly TransferAsset[];
export const SUPPORTED_TRANSFER_ASSET_IDS: readonly string[];
export const SUPPORTED_TRANSFER_RAILS: readonly string[];
export const IMPLEMENTED_TRANSFER_RAILS: readonly string[];
export const UNSUPPORTED_TRANSFER_NETWORKS: readonly string[];
export const PAYMENT_STATUSES: readonly string[];
export const TERMINAL_PAYMENT_STATUSES: readonly string[];
export const SOURCE_TYPES: readonly string[];
export const VERIFICATION_STATUSES: readonly string[];
export const RISK_SEVERITIES: readonly string[];
export const RISK_LIMITS: Readonly<{ daily_limit_default: string; unverified_recipient_cap: string }>;
export const PAIRING_SCOPES: readonly string[];
export const DEFAULT_PAIRING_SCOPES: readonly string[];
export const DEPRECATED_PAIRING_SCOPE_ALIASES: Readonly<Record<string, string>>;
export const TRANSACTION_CONTEXT_TYPES: readonly string[];
export const TRANSACTION_CONTEXT_STATUSES: readonly string[];
export const SUPPORTED_NETWORKS: readonly string[];

// (protocolFixtureClock / transactionContextFixtures / paymentRequestFixtures are
// test-only and intentionally not part of the public type surface — see index.js.)

export type TransferAsset = {
  id: string;
  rail: string;
  symbol: string;
  asset: string;
  chain: string;
  network: string;
  family: string;
  decimals?: number;
  chain_id?: number;
  token_contract?: string;
  fee_asset: string;
  memo_label: string;
  signer_status: "implemented" | "adapter_required" | string;
  execution_mode: "direct_broadcast" | "prepared_payload" | string;
  key_curve: "secp256k1" | "ed25519" | "stark" | string;
  coin_type?: number;
  network_aliases: readonly string[];
};

export function findSupportedTransferAsset(input?: Record<string, unknown>): TransferAsset | undefined;
export function validateTransferAddress(asset: TransferAsset | string, address: string): boolean;
export function detectUnsupportedTransferTarget(input?: Record<string, unknown> | string): {
  blocked: boolean;
  code?: string;
  message?: string;
};
export function transferAssetAdapterWarning(asset?: TransferAsset): ValidationIssue | null;

export function protocolError(code: string, message: string, details?: Record<string, unknown>): ValidationIssue;
export function normalizePaymentRequestV1(payload: Record<string, unknown>, options?: Record<string, unknown>): ValidationResult<Record<string, unknown>>;
export function normalizeTransactionContextV1(payload: Record<string, unknown>, options?: Record<string, unknown>): ValidationResult<Record<string, unknown>>;
export function createTransactionContextSnapshot(context: Record<string, unknown>, options?: Record<string, unknown>): ValidationResult<Record<string, unknown>>;
export function assertEnumCoverage(): {
  rails: string[];
  canonical_rails: string[];
  statuses: string[];
  source_types: string[];
  verification_statuses: string[];
  risk_severities: string[];
  scopes: string[];
  networks: string[];
};
