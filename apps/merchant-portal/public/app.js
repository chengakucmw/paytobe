import { createApiClient, ReauthenticationRequiredError, SessionExpiredError } from "./modules/api-client.js?v=single-email-step-up-20260803f";
import { initialAuthState, reduceAuthState } from "./modules/auth-state.js?v=single-email-step-up-20260803f";
import { createStepUpChannel } from "./modules/step-up-channel.js?v=single-email-step-up-20260803f";
import { renderPortal, routeFromPath } from "./modules/view.js?v=single-email-step-up-20260803f";
import { mountOrganizationMembers } from "/src/pages/organization/index.js";
import { mountDomains } from "/src/pages/domains/index.js";
import { mountAgents } from "/src/pages/agents/index.js";
import { mountRecipients } from "/src/pages/recipients/index.js";
import { mountWebhookAudit } from "/src/pages/webhooks/index.js";

const root = document.querySelector("#app");
const api = createApiClient();
let state = initialAuthState();
let route = routeFromPath(window.location.pathname);
let onboarding = initialOnboarding();
let security = initialSecurityState();
let stepUpFallbackTimer;
const stepUpChannel = createStepUpChannel({
  onChallenge(token) {
    void completeSessionStepUpToken(token, { notifyLinkedTab: true });
  },
  onCompleted() {
    if (!onboarding || !["step_up_connecting", "step_up_manual"].includes(onboarding.status)) return;
    clearTimeout(stepUpFallbackTimer);
    onboarding = { status: "step_up_verified" };
    render({ focusMain: true });
  },
  onFailed(message) {
    if (!onboarding || !["step_up_connecting", "step_up_manual"].includes(onboarding.status)) return;
    clearTimeout(stepUpFallbackTimer);
    onboarding = { status: "step_up_manual", token: onboarding.token, message };
    render({ focusMain: true });
  }
});

function render({ focusMain = false } = {}) {
  root.innerHTML = renderPortal(state, route, onboarding, security);
  bindEvents();
  if (state.session && ["organization", "members"].includes(route)) {
    mountOrganizationMembers({
      container: document.querySelector("#route-content"),
      api,
      session: state.session,
      route,
      onSessionInvalid(error) {
        state = transitionForError(state, error);
        render({ focusMain: true });
      }
    });
  }
  if (state.session && route === "domains") {
    mountDomains({
      container: document.querySelector("#route-content"),
      api,
      session: state.session,
      onSessionInvalid(error) {
        state = transitionForError(state, error);
        render({ focusMain: true });
      }
    });
  }
  if (state.session && route === "agents") {
    mountAgents({
      container: document.querySelector("#route-content"),
      api,
      session: state.session,
      onSessionInvalid(error) {
        state = transitionForError(state, error);
        render({ focusMain: true });
      }
    });
  }
  if (state.session && route === "recipients") {
    mountRecipients({
      container: document.querySelector("#route-content"),
      api,
      session: state.session,
      onSessionInvalid(error) {
        state = transitionForError(state, error);
        render({ focusMain: true });
      }
    });
  }
  if (state.session && ["webhooks", "audit"].includes(route)) {
    mountWebhookAudit({
      container: document.querySelector("#route-content"),
      api,
      session: state.session,
      route,
      onSessionInvalid(error) {
        state = transitionForError(state, error);
        render({ focusMain: true });
      }
    });
  }
  if (focusMain) document.querySelector("#main-content")?.focus();
}

function bindEvents() {
  document.querySelector("#sign-in-form")?.addEventListener("submit", signIn);
  document.querySelector("#registration-form")?.addEventListener("submit", register);
  document.querySelector("#organization-setup-form")?.addEventListener("submit", createOrganization);
  document.querySelector("#merchant-choice-form")?.addEventListener("submit", chooseMerchant);
  document.querySelector("#start-session-step-up")?.addEventListener("click", startSessionStepUp);
  document.querySelector("#complete-session-step-up-form")?.addEventListener("submit", completeSessionStepUp);
  document.querySelector("#retry-step-up-link")?.addEventListener("click", announceStepUpLink);
  document.querySelector("#reauthenticate-button")?.addEventListener("click", beginReauthentication);
  document.querySelector("#sign-out-button")?.addEventListener("click", signOut);
  for (const link of document.querySelectorAll("[data-route]")) link.addEventListener("click", navigate);
}

async function register(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  onboarding = { status: "verifying" };
  render();
  try {
    await api.register(form.get("email"));
    onboarding = { status: "registration_sent" };
  } catch (error) {
    onboarding = { status: "error", message: error?.message };
  }
  render({ focusMain: true });
}

async function verifyEmail(token) {
  try {
    const result = await api.verifyEmail(token);
    if (!result.merchants.length) {
      onboarding = { status: "organization", sessionGrant: result.sessionGrant };
    } else if (result.merchants.length === 1) {
      onboarding = { status: "signing_in" };
      render();
      await authenticateWithGrant(result.merchants[0].merchant_id, result.sessionGrant);
    } else {
      onboarding = { status: "merchant_choice", merchants: result.merchants, sessionGrant: result.sessionGrant };
    }
  } catch (error) {
    onboarding = { status: "error", message: error?.message };
  }
  if (onboarding) history.replaceState(null, "", "/");
  render({ focusMain: true });
}

async function chooseMerchant(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const merchantId = String(form.get("merchant_id") || "");
  const sessionGrant = onboarding?.sessionGrant;
  onboarding = { status: "signing_in" };
  render();
  try {
    await authenticateWithGrant(merchantId, sessionGrant);
  } catch (error) {
    onboarding = { status: "error", message: error?.message };
    render({ focusMain: true });
  }
}

async function authenticateWithGrant(merchantId, sessionGrant) {
  const result = await api.signIn({ merchantId, sessionGrant });
  state = reduceAuthState(state, { type: "AUTHENTICATED", ...result });
  onboarding = null;
  security = initialSecurityState();
  route = "overview";
  history.replaceState(null, "", "/overview");
}

async function createOrganization(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const sessionGrant = onboarding.sessionGrant;
  onboarding = { status: "creating" };
  render();
  try {
    const created = await api.createMerchant({
      sessionGrant,
      displayName: form.get("display_name"),
      legalName: form.get("legal_name")
    });
    const result = await api.signIn({ merchantId: created.merchant.merchant_id, sessionGrant: created.sessionGrant });
    state = reduceAuthState(state, { type: "AUTHENTICATED", ...result });
    onboarding = null;
    route = "overview";
    history.replaceState(null, "", "/overview");
  } catch (error) {
    onboarding = { status: "error", message: error?.message };
  }
  render({ focusMain: true });
}

async function signIn(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  state = reduceAuthState(state, { type: "SIGN_IN_STARTED" });
  render();
  try {
    const result = await api.signIn({ merchantId: form.get("merchant_id"), sessionGrant: form.get("session_grant") });
    state = reduceAuthState(state, { type: "AUTHENTICATED", ...result });
    history.replaceState(null, "", `/${route}`);
    render({ focusMain: true });
  } catch (error) {
    state = transitionForError(state, error);
    render({ focusMain: true });
  }
}

async function signOut() {
  try {
    await api.signOut();
    state = reduceAuthState(state, { type: "SIGNED_OUT" });
    security = initialSecurityState();
  } catch (error) {
    state = transitionForError(state, error);
  }
  history.replaceState(null, "", "/");
  render({ focusMain: true });
}

function beginReauthentication() {
  api.clearEphemeralProof();
  state = reduceAuthState(state, { type: "REAUTH_REQUIRED" });
  security = initialSecurityState();
  history.replaceState(null, "", "/");
  render({ focusMain: true });
}

async function startSessionStepUp() {
  security = { status: "sending", message: "Sending a one-time security challenge…" };
  render();
  try {
    await api.startStepUp();
    security = { status: "sent", message: "Check your email and open the newest security link. It will complete verification automatically without signing you out." };
  } catch (error) {
    if (error instanceof SessionExpiredError || error instanceof ReauthenticationRequiredError) {
      state = transitionForError(state, error);
      security = initialSecurityState();
    } else {
      security = { status: "error", message: String(error?.message || "The security challenge could not be sent.").slice(0, 180) };
    }
  }
  render({ focusMain: true });
}

async function completeSessionStepUp(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await completeSessionStepUpToken(form.get("challenge_token"), { notifyLinkedTab: true });
}

async function completeSessionStepUpToken(challengeToken, { notifyLinkedTab = false } = {}) {
  if (!state.session || !state.csrfAvailable || !["sent", "verifying", "error"].includes(security.status)) return;
  security = { status: "verifying", message: "Verifying the one-time security challenge…" };
  render();
  try {
    const result = await api.completeStepUp(challengeToken);
    state = reduceAuthState(state, { type: "STEP_UP_COMPLETED", stepUpAt: result.step_up_at });
    security = { status: "verified", message: "Security verification complete. Your current session stayed signed in." };
    if (notifyLinkedTab) stepUpChannel?.publishCompleted();
  } catch (error) {
    if (error instanceof SessionExpiredError || error instanceof ReauthenticationRequiredError) {
      state = transitionForError(state, error);
      security = initialSecurityState();
    } else {
      security = { status: "error", message: String(error?.message || "The security challenge is invalid or expired.").slice(0, 180) };
    }
    if (notifyLinkedTab) stepUpChannel?.publishFailed(security.message || "Security verification could not be completed.");
  }
  render({ focusMain: true });
}

function announceStepUpLink() {
  if (!onboarding?.token) return;
  clearTimeout(stepUpFallbackTimer);
  onboarding = { status: "step_up_connecting", token: onboarding.token };
  render({ focusMain: true });
  const published = stepUpChannel?.publishChallenge(onboarding.token) === true;
  stepUpFallbackTimer = setTimeout(() => {
    if (onboarding?.status !== "step_up_connecting") return;
    onboarding = {
      status: "step_up_manual",
      token: onboarding.token,
      message: published
        ? "The original Portal tab did not respond. Copy this code there; do not sign in again."
        : "Automatic tab connection is unavailable. Copy this code into the original Portal tab; do not sign in again."
    };
    render({ focusMain: true });
  }, 4_000);
}

function navigate(event) {
  event.preventDefault();
  if (!state.session) return;
  route = event.currentTarget.dataset.route;
  history.pushState(null, "", `/${route}`);
  render({ focusMain: true });
}

function transitionForError(current, error) {
  if (error instanceof SessionExpiredError) return reduceAuthState(current, { type: "SESSION_EXPIRED" });
  if (error instanceof ReauthenticationRequiredError) return reduceAuthState(current, { type: "REAUTH_REQUIRED" });
  return reduceAuthState(current, { type: "ERROR", message: error?.message });
}

window.addEventListener("popstate", () => {
  route = routeFromPath(window.location.pathname);
  render({ focusMain: true });
});
window.addEventListener("error", () => {
  api.clearEphemeralProof();
  state = reduceAuthState(state, { type: "ERROR", message: "The portal encountered an unexpected error. Sign in again." });
  render({ focusMain: true });
});

render();
if (onboarding?.status === "verifying" && onboarding.token) {
  void verifyEmail(onboarding.token);
} else if (onboarding?.status === "step_up_connecting" && onboarding.token) {
  announceStepUpLink();
} else if (!onboarding) {
  api.restoreSession()
  .then((result) => {
    state = reduceAuthState(state, { type: "AUTHENTICATED", ...result });
    render();
  })
  .catch((error) => {
    state = error instanceof SessionExpiredError
      ? reduceAuthState(state, { type: "CHECK_FAILED" })
      : transitionForError(state, error);
    render();
  });
}

function initialOnboarding() {
  const params = new URLSearchParams(window.location.search);
  if (window.location.pathname === "/verify-email") {
    const token = params.get("token") || "";
    return token ? { status: "verifying", token } : { status: "error", message: "The verification token is missing." };
  }
  const stepUpToken = params.get("step_up_token") || "";
  if (stepUpToken) {
    history.replaceState(null, "", "/");
    return { status: "step_up_connecting", token: stepUpToken };
  }
  return null;
}

function initialSecurityState() {
  return Object.freeze({ status: "idle", message: "" });
}
