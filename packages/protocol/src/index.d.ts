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

export type AuthContext = Readonly<{
  version: "velarum.auth_context.v1";
  actor_type: "merchant_user" | "agent_client" | "wallet_device" | "platform_operator";
  actor_id: string;
  merchant_id?: string;
  role?: "owner" | "admin" | "developer" | "viewer" | "operator";
  agent_id?: string;
  client_id?: string;
  credential_id?: string;
  device_id?: string;
  connection_id?: string;
  scopes: readonly string[];
  auth_method: "merchant_session" | "agent_assertion" | "device_token" | "platform_operator";
  session_id?: string;
  step_up_at?: string;
  request_id: string;
}>;

export const PLATFORM_API_CONTRACT_VERSION: "velarum.platform-api.v1";
export const CONTROL_PLANE_SCHEMA_VERSION: "velarum.control-plane.v1";
export const CONTROL_PLANE_STATUSES: Readonly<Record<string, readonly string[]>>;
export const AGENT_ALLOWED_SCOPES: readonly string[];
export const AUTH_CONTEXT_VERSION: "velarum.auth_context.v1";
export const IDEMPOTENCY_SCOPE_VERSION: "velarum.idempotency_scope.v1";
export const AUTH_CONTEXT_ACTOR_TYPES: readonly string[];
export const AUTH_METHODS: readonly string[];
export const MERCHANT_ROLES: readonly string[];
export const PLATFORM_API_ERROR_CODES: readonly string[];
export const CROSS_TENANT_SAFE_ERROR: Readonly<{ status: 404; code: "resource_not_found"; message: string }>;
export function selfDeclaredAuthorizationFields(value: unknown): string[];
export function createAuthContext(verifiedIdentity: Record<string, unknown>, options?: { requestId?: string; requestBody?: unknown }): AuthContext;
export function createPlatformApiError(code: string, message: string, options: { requestId: string; severity?: string; field?: string; details?: Record<string, unknown> }): { ok: false; error: Record<string, unknown> };
export function validatePlatformApiErrorEnvelope(value: unknown): ValidationResult<Record<string, unknown>>;
export function createIdempotencyScope(input: { merchant_id: string; actor_id: string; route: string; key: string; request: unknown }): Readonly<Record<string, string>>;
export function compareIdempotencyScope(existing: Record<string, unknown>, incoming: Record<string, unknown>): { ok: boolean; duplicate?: boolean; code?: string; status?: number };
export function validateControlPlaneObject(type: string, value: unknown): ValidationResult<Record<string, unknown>>;
export function validateMerchant(value: unknown): ValidationResult<Record<string, unknown>>;
export function validateMembership(value: unknown): ValidationResult<Record<string, unknown>>;
export function validateMerchantDomain(value: unknown): ValidationResult<Record<string, unknown>>;
export function validateAgent(value: unknown): ValidationResult<Record<string, unknown>>;
export function validateAgentCredential(value: unknown): ValidationResult<Record<string, unknown>>;
export function validateRecipient(value: unknown): ValidationResult<Record<string, unknown>>;
export function validateWebhookEndpoint(value: unknown): ValidationResult<Record<string, unknown>>;
export function validateNonAuthoritativeMetadata(value: unknown): ValidationResult<Record<string, unknown>>;

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
  memo_policy: Readonly<{ mode: "required" | "optional" | "forbidden" | string; max_bytes: number; charset: string; max_value?: string }>;
  signer_status: "implemented" | "adapter_required" | string;
  execution_mode: "direct_broadcast" | "prepared_payload" | string;
  key_curve: "secp256k1" | "ed25519" | "stark" | string;
  coin_type?: number;
  network_aliases: readonly string[];
};

export function findSupportedTransferAsset(input?: Record<string, unknown>): TransferAsset | undefined;
export function validateTransferAddress(asset: TransferAsset | string, address: string): boolean;
export function isValidStellarPublicKey(value: unknown): boolean;
export function detectUnsupportedTransferTarget(input?: Record<string, unknown> | string): {
  blocked: boolean;
  code?: string;
  message?: string;
};
export function transferAssetAdapterWarning(asset?: TransferAsset): ValidationIssue | null;
export function normalizeRecipientVersionV1(value: Record<string, unknown>, options?: {
  requireExplicitBindings?: boolean;
  memoPolicy?: { mode: "required" | "optional" | "forbidden" | string; max_bytes: number; charset: string; max_value?: string };
}): ValidationResult<Record<string, unknown>>;

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
