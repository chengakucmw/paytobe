/** Logical D1 schema for the public Paytobe Connect Platform testnet. */
export type Tenant = { tenantId: string; displayName: string; status: "active" | "disabled" };
export type AgentClient = { clientId: string; tenantId: string; displayName: string; tokenHash: string; status: "active" | "disabled" };
export type AppDevice = { deviceId: string; tokenHash: string };
export type ConnectInvitation = { invitationId: string; deviceId: string; clientId?: string; status: string; expiresAt: string };
export type Connection = { connectionId: string; deviceId: string; tenantId: string; clientId: string; scopes: string[]; status: string };
export type PaymentRequest = { requestId: string; connectionId: string; deviceId: string; status: string; payload: unknown };

export type MerchantStatus = "pending_verification" | "active" | "suspended" | "closed";
export type MembershipRole = "owner" | "admin" | "developer" | "viewer";
export type AgentStatus = "draft" | "active" | "suspended" | "revoked";
export type CredentialStatus = "pending_proof" | "active" | "expiring" | "expired" | "revoked";
export type RecipientStatus = "draft" | "pending_verification" | "active" | "suspended" | "revoked";
export type WebhookStatus = "draft" | "active" | "paused" | "deleted";

export type Merchant = { merchantId: string; displayName: string; status: MerchantStatus; verificationState: string; version: number };
export type MerchantMembership = { membershipId: string; merchantId: string; accountId: string; role: MembershipRole; status: string; version: number };
export type MerchantDomain = { domainId: string; merchantId: string; domain: string; method: "dns_txt" | "https_well_known"; status: string; version: number };
export type Agent = { agentId: string; merchantId: string; name: string; runtime: string; environment: string; allowedScopes: string[]; status: AgentStatus; version: number };
export type AgentCredential = { credentialId: string; merchantId: string; agentId: string; kid: string; alg: "Ed25519"; publicKey: string; status: CredentialStatus; version: number };
export type Recipient = { recipientId: string; merchantId: string; name: string; status: RecipientStatus; activeVersionId?: string; version: number };
export type WebhookEndpoint = { webhookEndpointId: string; merchantId: string; url: string; eventTypes: string[]; status: WebhookStatus; secretCiphertext: string; version: number };
