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

export function renderPortal(state, route = "overview") {
  if (state.status === AUTH_STATUS.CHECKING) return publicFrame("Checking your session…", "Please wait.");
  if (state.status === AUTH_STATUS.SIGNING_IN) return publicFrame("Signing in…", "Validating the one-time grant with VelarumPay.");
  if (state.status !== AUTH_STATUS.AUTHENTICATED || !state.session) return renderSignIn(state);
  return renderAuthenticated(state, routeFromPath(`/${route}`));
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
      <p class="muted">Use the merchant ID and current one-time grant from your verified email flow.</p>
      ${state.message ? `<div class="notice ${state.status === AUTH_STATUS.ERROR ? "notice-error" : ""}" role="status">${escapeHtml(state.message)}</div>` : ""}
      <form id="sign-in-form" autocomplete="off">
        <label for="merchant-id">Merchant ID</label>
        <input id="merchant-id" name="merchant_id" required autocapitalize="none" spellcheck="false">
        <label for="session-grant">One-time session grant</label>
        <input id="session-grant" name="session_grant" type="password" required autocomplete="one-time-code" spellcheck="false">
        <button type="submit">Sign in</button>
      </form>
      <p class="security-note">Session cookies are server-managed. This portal does not save the grant or session credentials in browser storage.</p>
    </section>
  </main>`;
}

function renderAuthenticated(state, route) {
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
      ${state.csrfAvailable ? "" : '<div class="notice" role="status">Reauthenticate before making changes. Read-only session access remains available.</div>'}
      <p class="eyebrow">Merchant workspace</p>
      <h1>${escapeHtml(title)}</h1>
      <section class="surface" aria-label="Current session">
        <h2>Session context</h2>
        <dl>
          <div><dt>Merchant</dt><dd>${escapeHtml(session.merchantId)}</dd></div>
          <div><dt>Role</dt><dd>${escapeHtml(session.role)}</dd></div>
          <div><dt>Expires</dt><dd>${escapeHtml(formatTimestamp(session.expiresAt))}</dd></div>
        </dl>
      </section>
      <section id="route-content" class="surface empty-state" aria-labelledby="route-title">
        <h2 id="route-title">${escapeHtml(title)}</h2>
        <p>This protected workspace is ready for its task-specific controls.</p>
      </section>
    </main>
  </div>`;
}

function brand() {
  return '<div class="brand" aria-label="VelarumPay"><span class="brand-mark" aria-hidden="true">V</span><span>VelarumPay</span></div>';
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
