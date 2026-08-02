import crypto from "node:crypto";
import { VelarumPayClient } from "../../../packages/sdk-js/src/index.js";

export class PlatformClient {
  constructor(config, { fetchImpl = fetch, signer } = {}) {
    this.timeoutMs = config.timeoutMs;
    this.sdk = new VelarumPayClient({
      baseUrl: config.baseUrl,
      fetch: timedFetch(fetchImpl, config.timeoutMs),
      agentAuth: {
        agentId: config.agentId,
        clientId: config.clientId,
        kid: config.credentialKid,
        scopes: config.scopes,
        audience: config.assertionAudience,
        signer
      }
    });
  }

  async claimConnectInvitation(connectKey) {
    return requireSuccess(await this.sdk.claimConnectInvitation(connectKey, this.sdk.agentAuth.scopes));
  }

  async getConnectInvitation(invitationId, claimToken) {
    return requireSuccess(await this.sdk.getConnectInvitation(invitationId, claimToken));
  }

  async exchangeConnectInvitation(invitationId, claimToken) {
    return requireSuccess(await this.sdk.exchangeConnectInvitation(invitationId, claimToken, { setConnectionToken: false }));
  }

  async createTransactionContext(context, connectionToken) {
    return requireSuccess(await this.sdk.createTransactionContext(context, { connectionToken }));
  }

  async createPaymentRequest(paymentRequest, connectionToken) {
    return requireSuccess(await this.sdk.createPaymentRequest(paymentRequest, {
      connectionToken,
      idempotencyKey: paymentRequest.idempotency_key
    }));
  }

  async paymentRequest(requestId, connectionToken) {
    return requireSuccess(await this.sdk.getPaymentRequest(requestId, { connectionToken }));
  }
}

export function createAgentCredentialSigner(env = process.env) {
  const encoded = String(env.AGENTFOOD_AGENT_CREDENTIAL_PRIVATE_KEY_PKCS8_B64 || "").trim();
  if (!encoded) return null;
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "pkcs8" });
  } catch {
    throw new TypeError("AgentFood Agent credential key is not valid PKCS#8 base64");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new TypeError("AgentFood Agent credential key must be Ed25519");
  return ({ data }) => crypto.sign(null, Buffer.from(data), privateKey).toString("base64url");
}

function timedFetch(fetchImpl, timeoutMs) {
  return (url, options = {}) => fetchImpl(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(timeoutMs)
  });
}

function requireSuccess(result) {
  if (result?.ok !== false) return result;
  throw Object.assign(new Error(result.error?.message || "VelarumPay Platform API rejected the request"), {
    status: result.status >= 400 && result.status < 500 ? result.status : 502,
    code: result.error?.code || "platform_api_error",
    platformStatus: result.status,
    details: result
  });
}
