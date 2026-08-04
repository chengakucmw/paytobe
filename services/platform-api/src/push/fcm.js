import crypto from "node:crypto";
import fs from "node:fs";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_TIMEOUT_MS = 10_000;

export function createPushTokenVault(encodedKey) {
  const key = decodeAes256Key(encodedKey);
  return Object.freeze({
    encrypt(plaintext, binding = "") {
      const value = String(plaintext || "");
      if (!value) throw new Error("Push token must not be empty");
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(pushTokenAad(binding));
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return {
        version: 1,
        algorithm: "A256GCM",
        iv: iv.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url")
      };
    },
    decrypt(record, binding = "") {
      if (!record || record.version !== 1 || record.algorithm !== "A256GCM") {
        throw new Error("Unsupported encrypted push token record");
      }
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(String(record.iv || ""), "base64url")
      );
      decipher.setAAD(pushTokenAad(binding));
      decipher.setAuthTag(Buffer.from(String(record.tag || ""), "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(String(record.ciphertext || ""), "base64url")),
        decipher.final()
      ]).toString("utf8");
    }
  });
}

export function buildFcmDataMessage(registrationToken, event = {}) {
  const token = String(registrationToken || "").trim();
  if (!token) throw new Error("FCM registration token is required");
  const requestId = String(event.request_id || "").trim();
  const eventId = String(event.event_id || "").trim();
  const eventSeq = Number(event.event_seq || 0);
  const data = {
    type: "velarumpay.sync",
    sync_required: "true"
  };
  if (eventId) data.event_id = eventId;
  if (requestId) data.request_id = requestId;
  if (Number.isSafeInteger(eventSeq) && eventSeq > 0) data.event_seq = String(eventSeq);
  return {
    message: {
      token,
      data,
      android: {
        priority: "high",
        collapse_key: "velarumpay-payment-sync",
        ttl: "300s"
      }
    }
  };
}

export function createFcmPushService({ config, store, observability, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const fcm = config?.push?.fcm || {};
  if (!fcm.enabled) {
    return Object.freeze({
      enabled: false,
      tokenVault: null,
      notifyPaymentRequest() {},
      notifyConnectInvitation() {}
    });
  }
  if (typeof fetchImpl !== "function") throw new Error("Global fetch is required for FCM HTTP v1 delivery");

  const tokenVault = createPushTokenVault(fcm.token_encryption_key);
  const account = loadServiceAccount(fcm);
  const client = new FcmHttpV1Client({
    projectId: fcm.project_id,
    account,
    fetchImpl,
    now,
    timeoutMs: fcm.timeout_ms || DEFAULT_TIMEOUT_MS
  });

  async function deliver(deviceId, event) {
    const device = store.device(deviceId);
    const push = device?.push;
    if (!push || push.provider !== "fcm" || push.status !== "active" || !push.token_ciphertext) {
      return { ok: false, skipped: "push_token_unavailable" };
    }
    try {
      const registrationToken = tokenVault.decrypt(push.token_ciphertext, deviceId);
      await client.send(buildFcmDataMessage(registrationToken, event));
      observability?.recordAuditEvent("push.fcm_delivered", "success", {
        actor: { type: "platform_api" },
        resource: { type: "app_device", id: deviceId },
        details: {
          event_id: event.event_id || null,
          request_id: event.request_id || null,
          event_seq: event.event_seq || null
        }
      });
      return { ok: true };
    } catch (error) {
      if (error?.invalidRegistration) {
        store.clearDevicePushToken(deviceId, push.token_hash);
      }
      observability?.recordAuditEvent("push.fcm_delivery_failed", "failure", {
        actor: { type: "platform_api" },
        resource: { type: "app_device", id: deviceId },
        labels: { code: error?.code || "fcm_delivery_failed" },
        details: {
          event_id: event.event_id || null,
          request_id: event.request_id || null,
          event_seq: event.event_seq || null
        }
      });
      throw error;
    }
  }

  return Object.freeze({
    enabled: true,
    tokenVault,
    notifyPaymentRequest(deviceId, event) {
      void deliver(deviceId, event).catch(() => {
        // REST compensation synchronization is authoritative; a failed push is
        // recorded above and must never fail Payment Request creation itself.
      });
    },
    notifyConnectInvitation(deviceId, event) {
      void deliver(deviceId, event).catch(() => {
        // Authenticated REST invitation synchronization is authoritative. Push is
        // only a wake-up hint and must never make a successful claim fail.
      });
    }
  });
}

class FcmHttpV1Client {
  constructor({ projectId, account, fetchImpl, now, timeoutMs }) {
    this.projectId = projectId;
    this.account = account;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.cachedAccessToken = null;
  }

  async send(payload, retry = true) {
    const accessToken = await this.accessToken();
    const response = await this.fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs)
      }
    );
    const body = await responseTextAsJson(response);
    if (response.status === 401 && retry) {
      this.cachedAccessToken = null;
      return this.send(payload, false);
    }
    if (!response.ok) throw fcmDeliveryError(response.status, body);
    return body;
  }

  async accessToken() {
    const nowMs = this.now();
    if (this.cachedAccessToken?.expiresAt > nowMs + 60_000) return this.cachedAccessToken.value;
    const issuedAt = Math.floor(nowMs / 1000);
    const assertion = signServiceAccountJwt(this.account, issuedAt);
    const response = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion
      }).toString(),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const body = await responseTextAsJson(response);
    if (!response.ok || !body.access_token) {
      const error = new Error(`FCM OAuth token request failed with HTTP ${response.status}`);
      error.code = "fcm_oauth_failed";
      throw error;
    }
    this.cachedAccessToken = {
      value: body.access_token,
      expiresAt: nowMs + Math.max(60, Number(body.expires_in) || 3600) * 1000
    };
    return this.cachedAccessToken.value;
  }
}

function loadServiceAccount(config) {
  let raw = String(config.service_account_json || "").trim();
  if (!raw && config.service_account_file) raw = fs.readFileSync(config.service_account_file, "utf8");
  let account;
  try {
    account = JSON.parse(raw);
  } catch {
    throw new Error("FCM service account JSON is invalid");
  }
  if (!account.client_email || !account.private_key) {
    throw new Error("FCM service account must contain client_email and private_key");
  }
  return account;
}

function signServiceAccountJwt(account, issuedAt) {
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const claims = base64UrlJson({
    iss: account.client_email,
    scope: FCM_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600
  });
  const input = `${header}.${claims}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(input), account.private_key).toString("base64url");
  return `${input}.${signature}`;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeAes256Key(value) {
  const raw = String(value || "").trim();
  let key;
  if (/^[a-f0-9]{64}$/i.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    const normalized = raw.replace(/^base64:/i, "").replace(/-/g, "+").replace(/_/g, "/");
    key = Buffer.from(normalized, "base64");
  }
  if (key.length !== 32) throw new Error("FCM_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

function pushTokenAad(binding) {
  return Buffer.from(`velarumpay:fcm-token:v1:${String(binding || "")}`, "utf8");
}

async function responseTextAsJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 1000) };
  }
}

function fcmDeliveryError(status, body) {
  const detailCodes = Array.isArray(body?.error?.details)
    ? body.error.details.map((detail) => detail?.errorCode).filter(Boolean)
    : [];
  const code = detailCodes[0] || body?.error?.status || "fcm_delivery_failed";
  const error = new Error(`FCM delivery failed with HTTP ${status}`);
  error.code = code;
  error.invalidRegistration = code === "UNREGISTERED";
  return error;
}
