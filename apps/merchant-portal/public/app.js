import { createApiClient, ReauthenticationRequiredError, SessionExpiredError } from "./modules/api-client.js";
import { initialAuthState, reduceAuthState } from "./modules/auth-state.js";
import { renderPortal, routeFromPath } from "./modules/view.js";
import { mountOrganizationMembers } from "/src/pages/organization/index.js";
import { mountDomains } from "/src/pages/domains/index.js";
import { mountAgents } from "/src/pages/agents/index.js";
import { mountRecipients } from "/src/pages/recipients/index.js";
import { mountWebhookAudit } from "/src/pages/webhooks/index.js";

const root = document.querySelector("#app");
const api = createApiClient();
let state = initialAuthState();
let route = routeFromPath(window.location.pathname);

function render({ focusMain = false } = {}) {
  root.innerHTML = renderPortal(state, route);
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
  document.querySelector("#sign-out-button")?.addEventListener("click", signOut);
  for (const link of document.querySelectorAll("[data-route]")) link.addEventListener("click", navigate);
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
  } catch (error) {
    state = transitionForError(state, error);
  }
  history.replaceState(null, "", "/");
  render({ focusMain: true });
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
