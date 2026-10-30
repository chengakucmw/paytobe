import { AUTH_STATUS } from "./auth-state.js";

const NAVIGATION = Object.freeze([
  ["overview", "Overview"],
  ["organization", "Organization"],
  ["members", "Members"],
  ["domains", "Domains"],
  ["agents", "Agents"],
  ["recipients", "Recipients"],
  ["webhooks", "Webhooks"]
  ,["audit", "Audit"]
]);

export function routeFromPath(pathname) {
  const candidate = String(pathname || "/").replace(/^\/+|\/+$/g, "") || "overview";
  return NAVIGATION.some(([route]) => route === candidate) ? candidate : "overview";
}

export function renderPortal(state, route = "overview", onboarding = null, security = {}) {
  if (onboarding?.status) return renderOnboarding(onboarding);
  if (state.status === AUTH_STATUS.CHECKING) return publicFrame("Checking your session…", "Please wait.");
  if (state.status === AUTH_STATUS.SIGNING_IN) return publicFrame("Signing in…", "Validating the one-time grant with Paytobe.");
  if (state.status !== AUTH_STATUS.AUTHENTICATED || !state.session) return renderSignIn(state);
  return renderAuthenticated(state, routeFromPath(`/${route}`), security);
}

function publicFrame(title, detail) {
  return `<main id="main-content" class="centered" tabindex="-1">
    <section class="auth-card" aria-labelledby="auth-title">
      ${brand()}
      <h1 id="auth-title">${escapeHtml(title)}</h1>
      <p class="muted">${escapeHtml(detail)}</p>
    </section>
  </main>`;
}

function renderSignIn(state) {
  return `<main id="main-content" class="centered" tabindex="-1">
    <section class="auth-card" aria-labelledby="auth-title">
      ${brand()}
      <p class="eyebrow">Merchant portal</p>
      <h1 id="auth-title">Sign in securely</h1>
      <p class="muted">Request a one-time email link to sign in or continue setting up your workspace.</p>
      ${state.message ? `<div class="notice ${state.status === AUTH_STATUS.ERROR ? "notice-error" : ""}" role="status">${escapeHtml(state.message)}</div>` : ""}
      <form id="registration-form">
        <label for="registration-email">Work email</label>
        <input id="registration-email" name="email" type="email" required autocomplete="email">
        <button type="submit">Continue with email</button>
      </form>
      <details>
      <summary>Use a one-time grant manually</summary>
      <form id="sign-in-form" autocomplete="off">
        <label for="merchant-id">Merchant ID</label>
        <input id="merchant-id" name="merchant_id" required autocapitalize="none" spellcheck="false">
        <label for="session-grant">One-time session grant</label>
        <input id="session-grant" name="session_grant" type="password" required autocomplete="one-time-code" spellcheck="false">
        <button type="submit">Sign in</button>
      </form>
      </details>
      <p class="security-note">Session cookies are server-managed. This portal does not save the grant or session credentials in browser storage.</p>
    </section>
  </main>`;
}

function renderOnboarding(onboarding) {
  if (onboarding.status === "verifying") {
    return publicFrame("Verifying your email…", "This one-time link is being checked with Paytobe.");
  }
  if (onboarding.status === "registration_sent") {
    return onboardingFrame("Check your inbox", "If the address can be used, a one-time link is on its way.", "");
  }
  if (onboarding.status === "organization") {
    return onboardingFrame("Create your merchant workspace", "Your email is verified. Name the organization that will own its agents and recipients.", `<form id="organization-setup-form">
      <label for="display-name">Display name</label>
      <input id="display-name" name="display_name" required maxlength="120" autocomplete="organization">
      <label for="legal-name">Legal name <span class="muted">(optional)</span></label>
      <input id="legal-name" name="legal_name" maxlength="200" autocomplete="organization">
      <button type="submit">Create workspace and sign in</button>
    </form>`);
  }
  if (onboarding.status === "creating") {
    return publicFrame("Creating your workspace…", "Paytobe is applying the verified owner identity.");
  }
  if (onboarding.status === "signing_in") {
    return publicFrame("Signing in securely…", "Paytobe is exchanging the one-time email proof for a protected session.");
  }
  if (onboarding.status === "merchant_choice") {
    const choices = (onboarding.merchants || []).map((merchant, index) => `<label class="merchant-choice">
      <input type="radio" name="merchant_id" value="${escapeHtml(merchant.merchant_id)}" ${index === 0 ? "checked" : ""}>
      <span><strong>${escapeHtml(merchant.display_name)}</strong><small>${escapeHtml(merchant.role)}</small></span>
    </label>`).join("");
    return onboardingFrame("Choose a merchant workspace", "Your email link is verified. Select the workspace to open.", `<form id="merchant-choice-form">${choices}<button type="submit">Open workspace</button></form>`);
  }
  if (onboarding.status === "step_up_connecting") {
    return onboardingFrame("Completing security verification…", "Keep your original signed-in Portal tab open. This page is securely connecting to that same session.", '<button type="button" id="retry-step-up-link" class="secondary">Retry connection</button><p class="security-note">You will not be signed out and you do not need to sign in again.</p>');
  }
  if (onboarding.status === "step_up_verified") {
    return onboardingFrame("Security verification complete", "Your current Portal session stayed signed in. Close this tab and return to the original Portal tab.", '<div class="notice" role="status"><span class="status-badge status-verified">Verified</span> Sensitive actions are now unlocked for the current session.</div>');
  }
  if (onboarding.status === "step_up_manual") {
    return onboardingFrame("Finish in your original Portal tab", onboarding.message || "Copy this one-time code into the original Portal tab.", `<output class="token-output">${escapeHtml(onboarding.token || "")}</output><p class="security-note"><strong>Do not sign in again.</strong> The code is one-time and short-lived. Close this tab after the original Portal confirms success.</p><button type="button" id="retry-step-up-link" class="secondary">Retry automatic completion</button>`);
  }
  return onboardingFrame("We could not continue", onboarding.message || "The link is invalid or expired. Request another verification email.", '<a class="button-link" href="/">Return to the Portal</a>', true);
}

function onboardingFrame(title, detail, content, error = false) {
  return `<main id="main-content" class="centered" tabindex="-1">
    <section class="auth-card" aria-labelledby="auth-title">
      ${brand()}
      <p class="eyebrow">Merchant onboarding</p>
      <h1 id="auth-title">${escapeHtml(title)}</h1>
      <p class="muted">${escapeHtml(detail)}</p>
      ${error ? '<div class="notice notice-error" role="alert">This request was not completed.</div>' : ""}
      ${content}
    </section>
  </main>`;
}

function renderAuthenticated(state, route, security) {
  const session = state.session;
  const title = NAVIGATION.find(([value]) => value === route)?.[1] || "Overview";
  return `<div class="portal-shell" data-authenticated="true">
    <header class="topbar">
      ${brand()}
      <div class="account-summary">
        <span>${escapeHtml(session.role)}</span>
        <button id="sign-out-button" class="secondary" type="button">Sign out</button>
      </div>
    </header>
    <aside class="sidebar" aria-label="Merchant portal">
      <nav>${NAVIGATION.map(([value, label]) => `<a href="/${value}" data-route="${value}" ${value === route ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav>
    </aside>
    <main id="main-content" class="content" tabindex="-1">
      ${state.csrfAvailable ? "" : '<div class="notice" role="status">Reauthenticate before making changes. Read-only session access remains available. <button type="button" id="reauthenticate-button" class="secondary">Reauthenticate by email</button></div>'}
      <p class="eyebrow">Merchant workspace</p>
      <h1>${escapeHtml(title)}</h1>
      <section class="surface" aria-label="Current session">
        <h2>Session context</h2>
        <dl>
          <div><dt>Merchant</dt><dd>${escapeHtml(session.merchantId)}</dd></div>
          <div><dt>Role</dt><dd>${escapeHtml(session.role)}</dd></div>
          <div><dt>Expires</dt><dd>${escapeHtml(formatTimestamp(session.expiresAt))}</dd></div>
        </dl>
        ${securityVerification(security, state.csrfAvailable, session)}
      </section>
      <section id="route-content" class="surface empty-state" aria-labelledby="route-title">
        <h2 id="route-title">${escapeHtml(title)}</h2>
        <p>This protected workspace is ready for its task-specific controls.</p>
      </section>
    </main>
  </div>`;
}

function securityVerification(security = {}, csrfAvailable = false, session = {}) {
  const busy = ["sending", "verifying"].includes(security.status);
  const verified = security.status === "verified" || session.stepUpFresh === true;
  const message = security.message
    ? `<div class="notice ${security.status === "error" ? "notice-error" : ""}" role="status">${escapeHtml(security.message)}</div>`
    : "";
  return `<section class="security-verification" aria-labelledby="security-verification-title">
    <div class="security-verification-header"><h3 id="security-verification-title">Security verification</h3><span class="status-badge ${verified ? "status-verified" : "status-pending"}">${verified ? "Verified" : "Required"}</span></div>
    <p>${verified ? "Sensitive actions are unlocked for this signed-in session." : "Use a one-time email link to unlock sensitive actions without leaving or replacing this session."}</p>
    ${message}
    ${verified ? "" : `<button type="button" id="start-session-step-up" class="secondary" ${busy || !csrfAvailable ? "disabled" : ""}>Send security email</button>`}
    ${!verified && security.status === "sent" ? `<details><summary>Use a one-time code instead</summary><form id="complete-session-step-up-form" autocomplete="off">
      <label for="session-step-up-token">One-time challenge</label>
      <input id="session-step-up-token" name="challenge_token" type="password" required autocomplete="one-time-code" spellcheck="false" ${busy || !csrfAvailable ? "disabled" : ""}>
      <button type="submit" ${busy || !csrfAvailable ? "disabled" : ""}>Verify challenge</button>
    </form></details>` : ""}
    ${csrfAvailable || verified ? "" : '<p class="security-note">Request a fresh email sign-in before starting security verification.</p>'}
  </section>`;
}

function brand() {
  return '<div class="brand" aria-label="Paytobe"><span class="brand-mark" aria-hidden="true">V</span><span>Paytobe</span></div>';
}

function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }) : "Unavailable";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}
