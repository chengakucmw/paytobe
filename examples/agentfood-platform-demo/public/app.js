const messages = document.querySelector("#messages");
const form = document.querySelector("#chat-form");
const input = document.querySelector("#chat-input");
const sendButton = form.querySelector("button[type='submit']");
const connectionStatus = document.querySelector("#connection-status");
const merchantGrid = document.querySelector("#merchant-grid");
const resultCount = document.querySelector("#result-count");
const connectCard = document.querySelector("#connect-card");
const demoConnectButton = document.querySelector("#demo-connect-button");
const composerHint = document.querySelector("#composer-hint");
const identityButton = document.querySelector("#identity-button");
const identityLabel = document.querySelector("#identity-label");
const identityDetail = document.querySelector("#identity-detail");
const identityMark = identityButton.querySelector(".google-mark");
const photoPositions = ["0% center", "50% center", "100% center"];
let sessionId = "";
let connectInvitationId = "";
let claimToken = "";
let connectionToken = "";
let preferredMerchantId = location.pathname.startsWith("/merchants/") ? location.pathname.split("/").pop() : "";
let hostingMode = "local_integration";
let pollTimer = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function addMessage(text, role = "agent", order = null) {
  const article = document.createElement("article");
  article.className = `message ${role === "user" ? "user-message" : "agent-message"}${role === "error" ? " error" : ""}`;
  const label = role === "user" ? "You" : role === "error" ? "Connection notice" : "Food agent";
  article.innerHTML = `<span class="message-label">${label}</span><p>${escapeHtml(text)}</p>`;
  if (order) {
    const items = order.items.map((item) => `${escapeHtml(item.name)} · ${escapeHtml(item.price)} XLM`).join("<br>");
    article.innerHTML += `<div class="order-summary"><span>${items}</span><strong>Total ${escapeHtml(order.total)} XLM</strong><span>Payment Request ${escapeHtml(order.order_id)}</span></div>`;
  }
  messages.append(article);
  messages.scrollTop = messages.scrollHeight;
}

function setStatus(text, state = "") {
  connectionStatus.textContent = text;
  connectionStatus.className = `status-dot ${state}`.trim();
}

function initials(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "U";
  return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

async function configureIdentity() {
  if (["localhost", "127.0.0.1"].includes(location.hostname)) {
    identityButton.addEventListener("click", (event) => {
      event.preventDefault();
      addMessage("Google-backed sign-in is available on the hosted version through ChatGPT identity.");
    });
    return;
  }

  try {
    const session = await api("/api/auth/session");
    if (!session.authenticated) return;
    const displayName = session.user.name || session.user.email;
    identityButton.classList.add("signed-in");
    identityButton.href = "/signout-with-chatgpt?return_to=%2F";
    identityButton.setAttribute("aria-label", `Signed in as ${displayName}. Sign out`);
    identityMark.textContent = initials(displayName);
    identityLabel.textContent = displayName;
    identityDetail.textContent = `${session.user.email} · Sign out`;
  } catch {
    identityDetail.textContent = "Secure sign-in via ChatGPT";
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) }
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    const error = new Error(result.error?.message || "Request failed");
    error.code = result.error?.code;
    throw error;
  }
  return result;
}

async function pollConnection() {
  if (hostingMode === "cloud_real_connect" && (!connectInvitationId || !claimToken)) return;
  if (hostingMode !== "cloud_real_connect" && !sessionId) return;
  try {
    const result = hostingMode === "cloud_real_connect"
      ? await api("/api/connect", {
          method: "POST",
          body: JSON.stringify({ connect_invitation_id: connectInvitationId, claim_token: claimToken })
        })
      : await api(`/api/connect/${encodeURIComponent(sessionId)}`);
    if (result.connection.connected) {
      if (result.connection.connection_token) connectionToken = result.connection.connection_token;
      setStatus("Connected", "connected");
      connectCard.hidden = true;
      clearInterval(pollTimer);
      pollTimer = null;
      addMessage("Connection approved. Keep browsing or tell me what you want to eat and your maximum XLM testnet amount.");
      return;
    }
    if (["rejected", "cancelled", "expired"].includes(result.connection.status)) {
      setStatus(result.connection.status, "error");
      clearInterval(pollTimer);
      pollTimer = null;
      addMessage(`The Connect Invitation is ${result.connection.status}. Generate a fresh Connect Key to try again.`, "error");
      return;
    }
    setStatus("Awaiting approval");
  } catch {
    setStatus("Check failed", "error");
  }
}

function beginPolling() {
  clearInterval(pollTimer);
  pollConnection();
  pollTimer = setInterval(pollConnection, 2_000);
}

function promptAgent(prompt, merchantId = "") {
  if (merchantId) preferredMerchantId = merchantId;
  input.value = prompt;
  input.focus();
  document.querySelector(".assistant-pane").scrollIntoView({ behavior: "smooth", block: "start" });
}

document.querySelectorAll("[data-focus-chat]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelector(".assistant-pane").scrollIntoView({ behavior: "smooth", block: "start" });
    input.focus({ preventScroll: true });
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  addMessage(message, "user");
  sendButton.disabled = true;
  try {
    const result = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message,
        session_id: sessionId,
        connect_invitation_id: connectInvitationId,
        claim_token: claimToken,
        connection_token: connectionToken,
        preferred_merchant_id: preferredMerchantId
      })
    });
    if (result.session_id) {
      sessionId = result.session_id;
      setStatus("Awaiting approval");
      beginPolling();
    }
    if (result.connect_invitation_id && result.claim_token) {
      connectInvitationId = result.connect_invitation_id;
      claimToken = result.claim_token;
      connectionToken = "";
      setStatus("Awaiting approval");
      beginPolling();
    }
    addMessage(result.message, "agent", result.order || null);
  } catch (error) {
    addMessage(error.message, "error");
    if (error.code === "connection_required") setStatus("Not connected", "error");
  } finally {
    sendButton.disabled = false;
    input.focus();
  }
});

demoConnectButton.addEventListener("click", () => {
  addMessage("Open VelarumPay, create a fresh one-time Connect Key and paste it here. I’ll use it once, then wait for your approval in the wallet.");
  input.placeholder = "Paste velarumpay-connect:ck_…";
  input.focus();
});

document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => promptAgent(button.dataset.prompt || "", button.dataset.merchant || ""));
});

document.querySelectorAll(".category-button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".category-button").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
    const filter = button.dataset.filter;
    let visible = 0;
    merchantGrid.querySelectorAll(".merchant-card").forEach((card) => {
      const matches = filter === "all" || card.dataset.tags.split(" ").includes(filter);
      card.hidden = !matches;
      if (matches) visible += 1;
    });
    resultCount.textContent = `${visible} restaurant${visible === 1 ? "" : "s"}`;
  });
});

function renderMerchants(merchants) {
  merchantGrid.innerHTML = merchants.map((merchant, index) => {
    const featuredItem = merchant.menu.find((item) => item.tags.includes("main")) || merchant.menu[0];
    const tags = [...new Set([...merchant.tags, ...merchant.menu.flatMap((item) => item.tags)])];
    return `
      <article class="merchant-card" data-tags="${escapeHtml(tags.join(" "))}" data-merchant="${escapeHtml(merchant.id)}">
        <div class="merchant-photo" style="--photo-position:${photoPositions[index % photoPositions.length]}">
          <span>Case 0${index + 1}</span>
        </div>
        <div class="merchant-body">
          <div class="merchant-meta"><span>${escapeHtml(merchant.deliveryMinutes)} min</span><span>Testnet menu</span></div>
          <h3>${escapeHtml(merchant.name)}</h3>
          <span class="cuisine">${escapeHtml(merchant.cuisine)}</span>
          <p>${escapeHtml(merchant.description)}</p>
        <div class="merchant-actions">
          <strong>From ${escapeHtml(featuredItem.price)} XLM</strong>
            <button type="button" data-ask-merchant="${escapeHtml(merchant.id)}" data-name="${escapeHtml(merchant.name)}">Build an order</button>
          </div>
        </div>
      </article>`;
  }).join("");

  merchantGrid.querySelectorAll("button[data-ask-merchant]").forEach((button) => {
    button.addEventListener("click", () => {
      promptAgent(`Help me choose a meal from ${button.dataset.name} under 20 XLM`, button.dataset.askMerchant);
    });
  });
}

function configureHostedMode() {
  document.body.dataset.hostingMode = "cloud-real-connect";
  composerHint.textContent = "Create a one-time key in VelarumPay. Never share a device token or private key.";
  demoConnectButton.textContent = "Connect VelarumPay";
  addMessage("This hosted version uses VelarumPay Connect. Create a key in VelarumPay, paste it here, then approve my registered identity and scopes in the wallet.");
}

async function start() {
  try {
    const catalog = await api("/api/catalog");
    hostingMode = catalog.hosting_mode || "local_integration";
    renderMerchants(catalog.merchants);
    if (hostingMode === "cloud_real_connect") configureHostedMode();
    else {
      composerHint.textContent = "Paste a fresh key from the VelarumPay app.";
      demoConnectButton.textContent = "Connect VelarumPay";
    }
  } catch (error) {
    merchantGrid.innerHTML = `<p>Catalog unavailable: ${escapeHtml(error.message)}</p>`;
  }

  await configureIdentity();
  if (sessionId || (connectInvitationId && claimToken)) beginPolling();
}

start();
