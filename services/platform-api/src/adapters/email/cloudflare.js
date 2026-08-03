const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function createCloudflareEmailAdapter(config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const sleep = dependencies.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  if (typeof fetchImpl !== "function") throw new TypeError("Cloudflare email fetch implementation is required");

  const endpoint = `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(config.account_id)}/email/sending/send`;

  async function deliver(message) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeout_ms);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.api_token}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            to: message.to,
            from: config.from,
            subject: message.subject,
            text: message.text,
            html: message.html,
            ...(config.reply_to ? { reply_to: config.reply_to } : {})
          }),
          signal: controller.signal
        });
        const payload = await readJson(response);
        if (response.ok && payload?.success === true) {
          const delivered = Array.isArray(payload.result?.delivered) ? payload.result.delivered : [];
          const queued = Array.isArray(payload.result?.queued) ? payload.result.queued : [];
          const bounced = Array.isArray(payload.result?.permanent_bounces) ? payload.result.permanent_bounces : [];
          const messageId = typeof payload.result?.message_id === "string" ? payload.result.message_id.trim() : "";
          if (bounced.includes(message.to)) throw emailError("email_permanent_bounce", "Transactional email permanently bounced");
          if (delivered.includes(message.to) || queued.includes(message.to) || messageId) {
            return Object.freeze({
              accepted: true,
              queued: queued.includes(message.to) || (!delivered.includes(message.to) && Boolean(messageId))
            });
          }
          throw emailError("email_delivery_unconfirmed", "Transactional email delivery was not confirmed");
        }

        const detail = cloudflareError(payload);
        lastError = emailError("email_provider_rejected", `Transactional email provider rejected the request (${response.status}${detail ? `: ${detail}` : ""})`);
        if (!RETRYABLE_STATUS.has(response.status) || attempt === 2) throw lastError;
      } catch (error) {
        lastError = error?.name === "AbortError"
          ? emailError("email_provider_timeout", "Transactional email provider timed out")
          : error;
        if (attempt === 2 || !isRetryableError(error)) throw lastError;
      } finally {
        clearTimeout(timeout);
      }
      await sleep(100 * (2 ** attempt));
    }
    throw lastError || emailError("email_delivery_failed", "Transactional email could not be sent");
  }

  return Object.freeze({
    sendVerification({ to, token, expires_at, purpose = "verification" }) {
      const url = portalUrl(config.portal_base_url, "/verify-email", { token });
      const returning = purpose === "access";
      return deliver({
        to,
        subject: returning ? "Continue to your VelarumPay merchant account" : "Verify your VelarumPay merchant email",
        text: verificationText(url, expires_at, returning),
        html: verificationHtml(url, expires_at, returning)
      });
    },
    sendStepUp({ to, token, expires_at }) {
      const url = portalUrl(config.portal_base_url, "/", { step_up_token: token });
      return deliver({
        to,
        subject: "Complete your VelarumPay security verification",
        text: stepUpText(url, expires_at),
        html: stepUpHtml(url, expires_at)
      });
    }
  });
}

function verificationText(url, expiresAt, returning) {
  const action = returning ? "Continue to your VelarumPay merchant account" : "Verify your VelarumPay merchant email";
  return `${action}:\n${url}\n\nThis one-time link expires at ${expiresAt}. If you did not request it, ignore this email.`;
}

function verificationHtml(url, expiresAt, returning) {
  return emailFrame(
    returning ? "Continue to your merchant account" : "Verify your merchant email",
    returning
      ? "Use this one-time link to sign in or continue creating your VelarumPay merchant workspace."
      : "Finish creating your VelarumPay merchant account with this one-time link.",
    url,
    returning ? "Continue securely" : "Verify email",
    `This link expires at ${expiresAt}.`
  );
}

function stepUpText(url, expiresAt) {
  return `Complete VelarumPay security verification without signing in again:\n${url}\n\nKeep your original Portal tab open. This one-time link expires at ${expiresAt}. If you did not request it, ignore this email.`;
}

function stepUpHtml(url, expiresAt) {
  return emailFrame(
    "Confirm a sensitive merchant action",
    "Keep your original Portal tab open, then use this one-time link. Your current session will stay signed in.",
    url,
    "Complete security verification",
    `This link expires at ${expiresAt}. If you did not request it, ignore this email.`
  );
}

function emailFrame(title, message, url, action, footer) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeUrl = escapeHtml(url);
  const safeAction = escapeHtml(action);
  const safeFooter = escapeHtml(footer);
  return `<!doctype html><html lang="en"><body style="margin:0;background:#f4efe6;color:#0a0a0a;font-family:Arial,sans-serif"><div style="max-width:560px;margin:32px auto;padding:32px;border:2px solid #0a0a0a;background:#fff"><p style="font-weight:700;color:#2727e6">VelarumPay</p><h1 style="font-size:28px">${safeTitle}</h1><p>${safeMessage}</p><p style="margin:28px 0"><a href="${safeUrl}" style="display:inline-block;padding:12px 18px;border:2px solid #0a0a0a;background:#2727e6;color:#fff;text-decoration:none;font-weight:700">${safeAction}</a></p><p style="font-size:13px;color:#4a4a48">${safeFooter}</p></div></body></html>`;
}

function portalUrl(base, pathname, params) {
  const url = new URL(pathname, `${String(base).replace(/\/+$/, "")}/`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

async function readJson(response) {
  try { return await response.json(); }
  catch { return null; }
}

function cloudflareError(payload) {
  const first = Array.isArray(payload?.errors) ? payload.errors[0] : null;
  return String(first?.message || "").slice(0, 160);
}

function isRetryableError(error) {
  return error?.name === "AbortError" || error?.code === "email_provider_timeout" || error instanceof TypeError;
}

function emailError(code, message) {
  return Object.assign(new Error(message), { code });
}
