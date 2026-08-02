export class SessionExpiredError extends Error {
  constructor() {
    super("Merchant session is invalid or expired");
    this.name = "SessionExpiredError";
  }
}

export class ReauthenticationRequiredError extends Error {
  constructor() {
    super("Reauthentication is required");
    this.name = "ReauthenticationRequiredError";
  }
}

export class PortalApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "PortalApiError";
    this.status = status;
    this.code = code;
  }
}

export function createApiClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  let csrfToken = "";

  async function request(pathname, { method = "GET", body, requireCsrf = false } = {}) {
    if (requireCsrf && !csrfToken) throw new ReauthenticationRequiredError();
    const response = await fetchImpl(pathname, {
      method,
      credentials: "include",
      redirect: "error",
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(requireCsrf ? { "x-csrf-token": csrfToken } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const payload = await parseJson(response);
    if (response.status === 401) {
      csrfToken = "";
      throw new SessionExpiredError();
    }
    if (response.status === 403 && ["csrf_failed", "origin_forbidden"].includes(payload?.error?.code)) {
      csrfToken = "";
      throw new ReauthenticationRequiredError();
    }
    if (!response.ok || payload?.ok !== true) {
      throw new PortalApiError(payload?.error?.message || "The request could not be completed.", response.status, payload?.error?.code || "api_error");
    }
    return payload;
  }

  return Object.freeze({
    async restoreSession() {
      const payload = await request("/v1/merchant-sessions/current");
      return { session: payload.session, csrfAvailable: false };
    },
    async signIn({ merchantId, sessionGrant }) {
      const payload = await request("/v1/merchant-sessions", {
        method: "POST",
        body: { merchant_id: String(merchantId || "").trim(), session_grant: String(sessionGrant || "").trim() }
      });
      if (!/^mcsrf_[A-Za-z0-9_-]{43}$/.test(String(payload.csrf_token || ""))) {
        throw new PortalApiError("The server did not issue a valid CSRF proof.", 502, "invalid_csrf_proof");
      }
      csrfToken = payload.csrf_token;
      return { session: payload.session, csrfAvailable: true };
    },
    async signOut() {
      await request("/v1/merchant-sessions/current", { method: "DELETE", requireCsrf: true });
      csrfToken = "";
    },
    async getMerchant(merchantId) {
      return (await request(`/v1/merchants/${segment(merchantId)}`)).merchant;
    },
    async updateMerchant(merchantId, patch) {
      return (await request(`/v1/merchants/${segment(merchantId)}`, { method: "PATCH", body: patch, requireCsrf: true })).merchant;
    },
    async listMemberships(merchantId) {
      return (await request(`/v1/merchants/${segment(merchantId)}/memberships`)).items;
    },
    async inviteMember(merchantId, input) {
      const payload = await request(`/v1/merchants/${segment(merchantId)}/membership-invitations`, {
        method: "POST", body: input, requireCsrf: true
      });
      return payload.invitation;
    },
    async changeMemberRole(merchantId, membershipId, input) {
      return (await request(`/v1/merchants/${segment(merchantId)}/memberships/${segment(membershipId)}`, {
        method: "PATCH", body: input, requireCsrf: true
      })).membership;
    },
    async removeMember(merchantId, membershipId, input) {
      return (await request(`/v1/merchants/${segment(merchantId)}/memberships/${segment(membershipId)}`, {
        method: "DELETE", body: input, requireCsrf: true
      })).membership;
    },
    async startStepUp() {
      return request("/v1/merchant-sessions/current/step-up", { method: "POST", body: {}, requireCsrf: true });
    },
    async completeStepUp(challengeToken) {
      return request("/v1/merchant-sessions/current/step-up", {
        method: "POST", body: { challenge_token: String(challengeToken || "").trim() }, requireCsrf: true
      });
    },
    async createDomain(input) {
      return request("/v1/merchant-domains", { method: "POST", body: input, requireCsrf: true });
    },
    async verifyDomain(domainId) {
      return request(`/v1/merchant-domains/${segment(domainId)}/verify`, { method: "POST", body: {}, requireCsrf: true });
    },
    async beginDomainReverification(domainId) {
      return request(`/v1/merchant-domains/${segment(domainId)}/reverification`, { method: "POST", body: {}, requireCsrf: true });
    },
    async listAgents() {
      return (await request("/v1/agents")).items;
    },
    async createAgent(input) {
      return (await request("/v1/agents", { method: "POST", body: input, requireCsrf: true })).agent;
    },
    async updateAgent(agentId, input) {
      return (await request(`/v1/agents/${segment(agentId)}`, { method: "PATCH", body: input, requireCsrf: true })).agent;
    },
    async listAgentCredentials(agentId) {
      return (await request(`/v1/agents/${segment(agentId)}/credentials`)).items;
    },
    async registerAgentCredential(agentId, input) {
      return request(`/v1/agents/${segment(agentId)}/credentials`, { method: "POST", body: input, requireCsrf: true });
    },
    async activateAgentCredential(agentId, credentialId, input) {
      return request(`/v1/agents/${segment(agentId)}/credentials/${segment(credentialId)}/activate`, { method: "POST", body: input, requireCsrf: true });
    },
    async revokeAgentCredential(agentId, credentialId, input) {
      return request(`/v1/agents/${segment(agentId)}/credentials/${segment(credentialId)}`, { method: "DELETE", body: input, requireCsrf: true });
    },
    async listRecipients() {
      return (await request("/v1/recipients")).items;
    },
    async createRecipient(input) {
      return request("/v1/recipients", { method: "POST", body: input, requireCsrf: true });
    },
    async updateRecipient(recipientId, input) {
      return request(`/v1/recipients/${segment(recipientId)}`, { method: "PATCH", body: input, requireCsrf: true });
    },
    async listRecipientVersions(recipientId) {
      return (await request(`/v1/recipients/${segment(recipientId)}/versions`)).items;
    },
    async createRecipientVersion(recipientId, input) {
      return request(`/v1/recipients/${segment(recipientId)}/versions`, { method: "POST", body: input, requireCsrf: true });
    },
    async verifyRecipient(recipientId, input) {
      return request(`/v1/recipients/${segment(recipientId)}/verify`, { method: "POST", body: input, requireCsrf: true });
    },
    async activateRecipientVersion(recipientId, versionId, input) {
      return request(`/v1/recipients/${segment(recipientId)}/versions/${segment(versionId)}/activate`, { method: "POST", body: input, requireCsrf: true });
    },
    async listWebhookEndpoints() {
      return (await request("/v1/webhook-endpoints")).items;
    },
    async createWebhookEndpoint(input) {
      return request("/v1/webhook-endpoints", { method: "POST", body: input, requireCsrf: true });
    },
    async verifyWebhookEndpoint(endpointId) {
      return request(`/v1/webhook-endpoints/${segment(endpointId)}/verify`, { method: "POST", body: {}, requireCsrf: true });
    },
    async rotateWebhookSecret(endpointId) {
      return request(`/v1/webhook-endpoints/${segment(endpointId)}/rotate-secret`, { method: "POST", body: {}, requireCsrf: true });
    },
    async revokeWebhookEndpoint(endpointId) {
      return request(`/v1/webhook-endpoints/${segment(endpointId)}`, { method: "DELETE", body: {}, requireCsrf: true });
    },
    async listWebhookDeliveries() {
      return (await request("/v1/webhook-deliveries")).items;
    },
    async replayWebhookDelivery(deliveryId) {
      return request(`/v1/webhook-deliveries/${segment(deliveryId)}/replay`, { method: "POST", body: {}, requireCsrf: true });
    },
    async listMerchantAuditEvents() {
      return (await request("/v1/merchant-audit/events")).items;
    },
    clearEphemeralProof() {
      csrfToken = "";
    },
    hasCsrfProof() {
      return Boolean(csrfToken);
    }
  });
}

function segment(value) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError("Resource identifier is required");
  return encodeURIComponent(text);
}

async function parseJson(response) {
  const contentType = response.headers?.get?.("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}
