import { PortalApiError, ReauthenticationRequiredError, SessionExpiredError } from "../../../public/modules/api-client.js";
import { AGENT_SCOPES, renderAgents } from "../../components/agents/view.js";

const MANAGER_ROLES = new Set(["owner", "admin", "developer"]);
const SENSITIVE_INPUT = /PRIVATE KEY|SECRET KEY|SEED PHRASE|MNEMONIC|BEGIN [A-Z ]*PRIVATE KEY/i;

export function createAgentsModel({ api, session, confirmAction = () => false, onSessionInvalid = () => {} }) {
  if (!api || !session?.merchantId) throw new TypeError("Agent model requires API and authenticated merchant session");
  let state = Object.freeze({ agents: [], selectedAgentId: "", credentials: [], showCreate: false, showCredentialForm: false, pendingProof: null, busy: false, message: "", errorCode: "", stepUpRequired: false, stepUpFresh: false });
  const listeners = new Set();

  function publish(patch) {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener(state);
  }

  async function run(operation, { clearOnNotFound = false } = {}) {
    publish({ busy: true, message: "", errorCode: "" });
    try {
      const result = await operation();
      publish({ busy: false });
      return result;
    } catch (error) {
      if (error instanceof SessionExpiredError || error instanceof ReauthenticationRequiredError) {
        clearSensitive("session_invalid", "Your session can no longer authorize this page.");
        onSessionInvalid(error);
        return null;
      }
      if (clearOnNotFound && (error?.status === 404 || error?.code === "resource_not_found")) {
        clearSensitive("resource_not_found", "The Agent resource is unavailable.");
        return null;
      }
      const code = String(error?.code || "agent_request_failed");
      publish({ busy: false, errorCode: code, message: errorMessage(code), stepUpRequired: code === "step_up_required" });
      return null;
    }
  }

  function clearSensitive(errorCode, message) {
    publish({ agents: [], selectedAgentId: "", credentials: [], showCreate: false, showCredentialForm: false, pendingProof: null, busy: false, errorCode, message, stepUpRequired: false, stepUpFresh: false });
  }

  async function load() {
    const agents = await run(() => api.listAgents());
    if (!agents) return;
    const safeAgents = Array.isArray(agents) ? agents.map(sanitizeAgent) : [];
    publish({ agents: safeAgents, selectedAgentId: safeAgents[0]?.agent_id || "", showCreate: false });
    if (safeAgents[0]) await select(safeAgents[0].agent_id);
  }

  async function select(agentId) {
    const agent = state.agents.find((item) => item.agent_id === agentId);
    if (!agent) return null;
    publish({ selectedAgentId: agentId, credentials: [], pendingProof: null, showCreate: false, showCredentialForm: false });
    const credentials = await run(() => api.listAgentCredentials(agentId), { clearOnNotFound: true });
    if (credentials) publish({ credentials: Array.isArray(credentials) ? credentials.map(sanitizeCredential) : [] });
    return credentials;
  }

  async function create(input) {
    if (!canManage()) return forbidden();
    const agent = await run(() => api.createAgent({ name: input.name, runtime: input.runtime, environment: input.environment, allowed_scopes: validScopes(input.allowedScopes) }));
    if (agent) {
      const safe = sanitizeAgent(agent);
      publish({ agents: [...state.agents, safe], selectedAgentId: safe.agent_id, credentials: [], showCreate: false, message: "Agent registered as a draft." });
    }
    return agent;
  }

  async function changeScopes(scopes, confirmed) {
    const agent = selectedAgent();
    if (!canManage() || !agent || confirmed !== true || confirmAction("scopes") !== true) return null;
    if (!state.stepUpFresh) return requireStepUp();
    return updateAgent({ allowed_scopes: validScopes(scopes), version: agent.version }, "Agent scopes updated.");
  }

  async function changeStatus(status, confirmed) {
    const agent = selectedAgent();
    if (!canManage() || !agent || confirmed !== true || confirmAction(status) !== true) return null;
    if (["suspended", "revoked"].includes(status) && !state.stepUpFresh) return requireStepUp();
    return updateAgent({ status, version: agent.version }, `Agent is now ${status}.`);
  }

  async function updateAgent(input, message) {
    const agent = selectedAgent();
    const updated = await run(() => api.updateAgent(agent.agent_id, input), { clearOnNotFound: true });
    if (updated) {
      const safe = sanitizeAgent(updated);
      publish({ agents: state.agents.map((item) => item.agent_id === safe.agent_id ? safe : item), message, stepUpFresh: false });
    }
    return updated;
  }

  async function registerCredential(input) {
    const agent = selectedAgent();
    if (!canManage() || !agent) return forbidden();
    const publicKey = String(input.publicKey || "").trim();
    if (!publicKey || SENSITIVE_INPUT.test(publicKey)) {
      publish({ errorCode: "credential_input_rejected", message: "Only an Ed25519 public key is accepted. Private key or seed material was rejected." });
      return null;
    }
    const result = await run(() => api.registerAgentCredential(agent.agent_id, {
      kid: input.kid,
      alg: "Ed25519",
      public_key: publicKey,
      not_before: isoFromLocal(input.notBefore),
      expires_at: isoFromLocal(input.expiresAt)
    }), { clearOnNotFound: true });
    if (result) {
      const credential = sanitizeCredential(result.credential);
      publish({
        credentials: [...state.credentials, credential],
        showCredentialForm: false,
        pendingProof: Object.freeze({ credentialId: credential.credential_id, challenge: String(result.proof_challenge || ""), expiresAt: String(result.proof_expires_at || "") }),
        message: "Public credential registered. Complete local proof of possession."
      });
    }
    return result;
  }

  async function activateCredential(signature) {
    const agent = selectedAgent();
    const proof = state.pendingProof;
    if (!canManage() || !agent || !proof) return forbidden();
    const value = String(signature || "").trim();
    if (!value || SENSITIVE_INPUT.test(value)) return invalidProofInput();
    const result = await run(() => api.activateAgentCredential(agent.agent_id, proof.credentialId, { challenge: proof.challenge, signature: value }), { clearOnNotFound: true });
    if (result) {
      const activated = sanitizeCredential(result.credential);
      let credentials = state.credentials.map((item) => item.credential_id === activated.credential_id ? activated : item);
      if (result.rotated_credential) {
        const rotated = sanitizeCredential(result.rotated_credential);
        credentials = credentials.map((item) => item.credential_id === rotated.credential_id ? rotated : item);
      }
      publish({ credentials, pendingProof: null, message: "Proof verified and credential activated." });
    }
    return result;
  }

  async function revokeCredential(credentialId, version, confirmed) {
    const agent = selectedAgent();
    if (!canManage() || !agent || confirmed !== true || confirmAction("credential_revoke") !== true) return null;
    if (!state.stepUpFresh) return requireStepUp();
    const result = await run(() => api.revokeAgentCredential(agent.agent_id, credentialId, { version }), { clearOnNotFound: true });
    if (result) {
      const credential = sanitizeCredential(result.credential);
      publish({ credentials: state.credentials.map((item) => item.credential_id === credential.credential_id ? credential : item), message: "Credential revoked. Existing access is invalidated.", stepUpFresh: false });
    }
    return result;
  }

  async function startStepUp() {
    const result = await run(() => api.startStepUp());
    if (result) publish({ stepUpRequired: true, message: "A short-lived step-up challenge was sent to the verified account email." });
    return result;
  }

  async function completeStepUp(token) {
    const result = await run(() => api.completeStepUp(token));
    if (result) publish({ stepUpRequired: false, stepUpFresh: true, message: "Step-up completed. Confirm the sensitive action again." });
    return result;
  }

  function selectedAgent() { return state.agents.find((item) => item.agent_id === state.selectedAgentId) || null; }
  function canManage() { return MANAGER_ROLES.has(String(session.role || "").toLowerCase()); }
  function requireStepUp() { publish({ stepUpRequired: true, errorCode: "step_up_required", message: errorMessage("step_up_required") }); return null; }
  function forbidden() { publish({ errorCode: "forbidden", message: errorMessage("forbidden") }); return null; }
  function invalidProofInput() { publish({ errorCode: "credential_proof_invalid", message: errorMessage("credential_proof_invalid") }); return null; }

  return Object.freeze({
    getState: () => state,
    canManage,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setView(patch) { publish(patch); },
    load, select, create, changeScopes, changeStatus, registerCredential, activateCredential, revokeCredential, startStepUp, completeStepUp
  });
}

function sanitizeAgent(value) {
  if (!value?.agent_id || !Array.isArray(value.allowed_scopes)) throw new TypeError("Agent response is invalid");
  return Object.freeze({ agent_id: String(value.agent_id), name: String(value.name || "Unnamed Agent"), runtime: String(value.runtime || "unknown"), environment: String(value.environment || "unknown"), allowed_scopes: validScopes(value.allowed_scopes), status: String(value.status || "draft"), version: Number(value.version || 0) });
}

function sanitizeCredential(value) {
  if (!value?.credential_id || !value.kid) throw new TypeError("Credential response is invalid");
  return Object.freeze({ credential_id: String(value.credential_id), kid: String(value.kid), alg: String(value.alg || "Ed25519"), status: String(value.status || "pending_proof"), not_before: String(value.not_before || ""), expires_at: String(value.expires_at || ""), last_used_at: String(value.last_used_at || ""), overlap_expires_at: String(value.overlap_expires_at || ""), version: Number(value.version || 0) });
}

function validScopes(values) {
  const input = Array.isArray(values) ? values : [];
  return [...new Set(input.filter((scope) => AGENT_SCOPES.includes(scope)))].sort();
}

function isoFromLocal(value) {
  const time = new Date(String(value || ""));
  if (!Number.isFinite(time.getTime())) throw new TypeError("Credential validity time is invalid");
  return time.toISOString();
}

function errorMessage(code) {
  const messages = {
    concurrency_conflict: "This Agent or credential changed elsewhere. Reload before retrying.",
    agent_revoked: "This Agent is revoked and cannot be changed.",
    invalid_credential_transition: "This revoked or expired credential cannot transition again.",
    credential_proof_invalid: "The local proof signature is invalid or expired.",
    credential_active_limit: "At most two usable credentials are allowed during rotation.",
    credential_input_rejected: "Only an Ed25519 public key is accepted.",
    step_up_required: "Recent step-up authentication is required for this sensitive action.",
    forbidden: "Your server-issued role does not permit Agent management."
  };
  return messages[code] || "The Agent request could not be completed.";
}

export function mountAgents({ container, api, session, onSessionInvalid }) {
  if (!container) return null;
  const model = createAgentsModel({
    api,
    session,
    confirmAction(action) {
      const messages = {
        scopes: "Change this Agent's maximum scopes? Existing tokens may be invalidated by server policy.",
        suspended: "Suspend this Agent and invalidate its current access?",
        revoked: "Revoke this Agent permanently? This cannot be undone.",
        credential_revoke: "Revoke this credential and invalidate access issued through it?",
        active: "Activate this Agent?"
      };
      return globalThis.confirm(messages[action] || "Confirm this Agent change?");
    },
    onSessionInvalid
  });
  const paint = (state) => { container.innerHTML = renderAgents(state, model.canManage()); bind(container, model); };
  model.subscribe(paint);
  paint(model.getState());
  void model.load();
  return model;
}

function bind(container, model) {
  for (const button of container.querySelectorAll("[data-select-agent]")) button.addEventListener("click", () => void model.select(button.dataset.selectAgent));
  container.querySelector("#show-create-agent")?.addEventListener("click", () => model.setView({ showCreate: true }));
  container.querySelector("#show-register-credential")?.addEventListener("click", () => model.setView({ showCredentialForm: true }));
  container.querySelector("#create-agent-form")?.addEventListener("submit", (event) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); void model.create({ name: data.get("name"), runtime: data.get("runtime"), environment: data.get("environment"), allowedScopes: data.getAll("allowed_scopes") });
  });
  container.querySelector("#change-agent-scopes-form")?.addEventListener("submit", (event) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); void model.changeScopes(data.getAll("allowed_scopes"), true);
  });
  for (const button of container.querySelectorAll("[data-agent-status]")) button.addEventListener("click", () => void model.changeStatus(button.dataset.agentStatus, true));
  container.querySelector("#register-credential-form")?.addEventListener("submit", (event) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); void model.registerCredential({ kid: data.get("kid"), publicKey: data.get("public_key"), notBefore: data.get("not_before"), expiresAt: data.get("expires_at") });
  });
  container.querySelector("#activate-credential-form")?.addEventListener("submit", (event) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); void model.activateCredential(data.get("signature")); event.currentTarget.reset();
  });
  for (const button of container.querySelectorAll("[data-revoke-credential]")) button.addEventListener("click", () => {
    const card = button.closest("[data-credential-id]"); void model.revokeCredential(card.dataset.credentialId, Number(button.dataset.version), true);
  });
  container.querySelector("#start-agent-step-up")?.addEventListener("click", () => void model.startStepUp());
  container.querySelector("#complete-agent-step-up-form")?.addEventListener("submit", (event) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); void model.completeStepUp(data.get("challenge_token")); event.currentTarget.reset();
  });
}

export { renderAgents };
