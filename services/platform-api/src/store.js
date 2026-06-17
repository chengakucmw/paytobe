import fs from "fs";
import path from "path";

const DATA_PATH = path.resolve("data/relay-store.json");

function initialState() {
  return {
    devices: {},
    demoSessions: {},
    telegramBindings: {},
    pairingSessions: {},
    pairingCodes: {},
    connections: {},
    connectionTokens: {},
    paymentRequests: {},
    paymentRequestIdempotency: {},
    intents: {},
    transactionContexts: {},
    idempotency: {},
    events: [],
    dailySpent: {}
  };
}

function paymentRequestIdempotencyScope(key, connectionId = "") {
  return `${connectionId || "legacy"}:${key}`;
}

export class Store {
  constructor(file = DATA_PATH) {
    this.file = file;
    this.state = initialState();
    this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) {
      this.save();
      return;
    }
    this.state = { ...initialState(), ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  registerDevice(deviceId, token) {
    this.state.devices[deviceId] = {
      device_id: deviceId,
      token,
      registered_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString()
    };
    this.save();
    return this.state.devices[deviceId];
  }

  createDemoSession(sessionId, deviceId, data = {}) {
    const now = new Date().toISOString();
    const session = {
      session_id: sessionId,
      device_id: deviceId,
      label: data.label || "AgentWallet Demo",
      telegram_bot: data.telegram_bot || "",
      stellar_address: data.stellar_address || "",
      evm_address: data.evm_address || "",
      status: "ready",
      created_at: now,
      updated_at: now
    };
    this.state.demoSessions[sessionId] = session;
    this.save();
    return session;
  }

  demoSession(sessionId) {
    return this.state.demoSessions[sessionId] || null;
  }

  updateDemoSession(sessionId, patch = {}) {
    const session = this.demoSession(sessionId);
    if (!session) return null;
    Object.assign(session, patch, { updated_at: new Date().toISOString() });
    this.save();
    return session;
  }

  listDemoSessions() {
    return Object.values(this.state.demoSessions)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }

  bindTelegramChat(sessionId, chatHash, meta = {}) {
    const session = this.demoSession(sessionId);
    if (!session) return null;
    const binding = {
      chat_hash: chatHash,
      session_id: sessionId,
      device_id: session.device_id,
      telegram_user: meta.telegram_user || "",
      telegram_name: meta.telegram_name || "",
      bound_at: new Date().toISOString()
    };
    this.state.telegramBindings[chatHash] = binding;
    session.status = "bound";
    session.updated_at = binding.bound_at;
    this.save();
    return binding;
  }

  telegramBinding(chatHash) {
    return this.state.telegramBindings[chatHash] || null;
  }

  listTelegramBindings() {
    return Object.values(this.state.telegramBindings)
      .sort((a, b) => Date.parse(b.bound_at) - Date.parse(a.bound_at));
  }

  device(deviceId) {
    return this.state.devices[deviceId];
  }

  firstDeviceId() {
    return Object.keys(this.state.devices)[0] || "";
  }

  createPairingSession(sessionId, pairingCode, data = {}) {
    const now = new Date().toISOString();
    const session = {
      pairing_session_id: sessionId,
      pairing_code: pairingCode,
      pairing_uri: data.pairing_uri || "",
      agent_identity: data.agent_identity || {},
      requested_scopes: data.requested_scopes || [],
      status: "pending",
      created_at: now,
      updated_at: now,
      expires_at: data.expires_at
    };
    this.state.pairingSessions[sessionId] = session;
    this.state.pairingCodes[pairingCode] = sessionId;
    this.event("pairing_session.created", sessionId, { status: session.status });
    this.save();
    return session;
  }

  pairingSession(idOrCode) {
    if (this.state.pairingSessions[idOrCode]) return this.state.pairingSessions[idOrCode];
    const sessionId = this.state.pairingCodes[idOrCode];
    return sessionId ? this.state.pairingSessions[sessionId] || null : null;
  }

  pairingSessionByCode(pairingCode) {
    const sessionId = this.state.pairingCodes[pairingCode];
    return sessionId ? this.state.pairingSessions[sessionId] || null : null;
  }

  isPairingSessionExpired(session, nowMs = Date.now()) {
    if (!session?.expires_at) return true;
    return Date.parse(session.expires_at) <= nowMs;
  }

  updatePairingSession(sessionId, patch = {}) {
    const session = this.state.pairingSessions[sessionId];
    if (!session) return null;
    Object.assign(session, patch, { updated_at: new Date().toISOString() });
    this.event("pairing_session.status", sessionId, { status: session.status });
    this.save();
    return session;
  }

  expirePairingSessions(nowMs = Date.now()) {
    let changed = false;
    for (const session of Object.values(this.state.pairingSessions)) {
      if (session.status !== "pending") continue;
      if (!this.isPairingSessionExpired(session, nowMs)) continue;
      session.status = "expired";
      session.updated_at = new Date(nowMs).toISOString();
      this.event("pairing_session.status", session.pairing_session_id, { status: "expired" });
      changed = true;
    }
    if (changed) this.save();
    return changed;
  }

  createConnection(connectionId, token, data = {}) {
    const now = new Date().toISOString();
    const scopes = data.scopes || data.approved_scopes || [];
    const connection = {
      connection_id: connectionId,
      connection_token: token,
      agent_id: data.agent_identity?.agent_id || "",
      agent_identity: data.agent_identity || {},
      scopes,
      approved_scopes: scopes,
      status: "active",
      pairing_session_id: data.pairing_session_id || "",
      approved_by_device_id: data.approved_by_device_id || "",
      created_at: now,
      updated_at: now,
      last_activity_at: now,
      expires_at: data.expires_at
    };
    this.state.connections[connectionId] = connection;
    this.state.connectionTokens[token] = connectionId;
    this.event("connection.created", connectionId, { status: connection.status });
    this.save();
    return connection;
  }

  connection(connectionId) {
    return this.state.connections[connectionId] || null;
  }

  connectionByToken(token) {
    const connectionId = this.state.connectionTokens[token];
    return connectionId ? this.connection(connectionId) : null;
  }

  listConnectionsForDevice(deviceId) {
    return Object.values(this.state.connections)
      .filter((connection) => connection.approved_by_device_id === deviceId)
      .sort((a, b) => Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at));
  }

  updateConnectionStatus(connectionId, status, data = {}) {
    const connection = this.connection(connectionId);
    if (!connection) return null;
    connection.status = status;
    connection.updated_at = new Date().toISOString();
    if (data.revoked_by_device_id) connection.revoked_by_device_id = data.revoked_by_device_id;
    if (data.revoked_at) connection.revoked_at = data.revoked_at;
    this.event("connection.status", connectionId, { status: connection.status });
    this.save();
    return connection;
  }

  touchConnection(connectionId) {
    const connection = this.connection(connectionId);
    if (!connection) return null;
    connection.last_activity_at = new Date().toISOString();
    connection.updated_at = connection.last_activity_at;
    this.save();
    return connection;
  }

  putIntent(intent) {
    this.state.intents[intent.intent_id] = intent;
    if (intent.idempotency_key) this.state.idempotency[intent.idempotency_key] = intent.intent_id;
    this.event("payment_intent.created", intent.intent_id, { status: intent.status });
    this.save();
    return intent;
  }

  intent(id) {
    return this.state.intents[id];
  }

  findByIdempotency(key) {
    const id = this.state.idempotency[key];
    return id ? this.state.intents[id] : null;
  }

  putTransactionContext(context) {
    const now = new Date().toISOString();
    const stored = {
      ...context,
      updated_at: context.updated_at || now
    };
    this.state.transactionContexts[stored.transaction_id] = stored;
    this.event("transaction_context.upserted", stored.transaction_id, {
      transaction_id: stored.transaction_id,
      status: stored.status
    });
    this.save();
    return stored;
  }

  transactionContext(transactionId) {
    return this.state.transactionContexts[transactionId] || null;
  }

  listTransactionContexts() {
    return Object.values(this.state.transactionContexts)
      .sort((a, b) => Date.parse(b.updated_at || b.created_at || 0) - Date.parse(a.updated_at || a.created_at || 0));
  }

  putPaymentRequest(request) {
    const stored = {
      ...request,
      history: request.history || [{ status: request.status, at: request.created_at }]
    };
    this.state.paymentRequests[stored.request_id] = stored;
    if (stored.idempotency_key) {
      this.state.paymentRequestIdempotency[paymentRequestIdempotencyScope(stored.idempotency_key, stored.connection_id)] = stored.request_id;
      if (!stored.connection_id) this.state.paymentRequestIdempotency[stored.idempotency_key] = stored.request_id;
    }
    this.event("payment_request.created", stored.request_id, {
      request_id: stored.request_id,
      transaction_id: stored.transaction_id || null,
      connection_id: stored.connection_id || null,
      target_app_device_id: stored.target_app_device_id || null,
      status: stored.status
    });
    this.save();
    return stored;
  }

  paymentRequest(requestId) {
    return this.state.paymentRequests[requestId] || null;
  }

  findPaymentRequestByIdempotency(key, connectionId = "") {
    const scopedId = this.state.paymentRequestIdempotency[paymentRequestIdempotencyScope(key, connectionId)];
    if (scopedId) return this.state.paymentRequests[scopedId] || null;
    const legacyId = this.state.paymentRequestIdempotency[key];
    const legacy = legacyId ? this.state.paymentRequests[legacyId] || null : null;
    if (!legacy) return null;
    if (connectionId && legacy.connection_id && legacy.connection_id !== connectionId) return null;
    return legacy;
  }

  listPaymentRequestsForConnection(connectionId) {
    return Object.values(this.state.paymentRequests)
      .filter((item) => item.connection_id === connectionId)
      .sort((a, b) => Date.parse(b.updated_at || b.created_at || 0) - Date.parse(a.updated_at || a.created_at || 0));
  }

  listPaymentRequestsForDevice(deviceId) {
    return Object.values(this.state.paymentRequests)
      .filter((item) => item.target_app_device_id === deviceId)
      .sort((a, b) => Date.parse(b.updated_at || b.created_at || 0) - Date.parse(a.updated_at || a.created_at || 0));
  }

  updatePaymentRequestStatus(requestId, status, patch = {}) {
    const request = this.paymentRequest(requestId);
    if (!request) return null;
    request.status = status;
    request.updated_at = new Date().toISOString();
    if (patch.tx_hash) request.tx_hash = patch.tx_hash;
    if (patch.error) request.error = patch.error;
    request.history = request.history || [];
    request.history.push({
      status,
      tx_hash: patch.tx_hash || null,
      error: patch.error || null,
      at: request.updated_at
    });
    this.event("payment_request.status", requestId, {
      request_id: request.request_id,
      transaction_id: request.transaction_id || null,
      connection_id: request.connection_id || null,
      target_app_device_id: request.target_app_device_id || null,
      status,
      tx_hash: patch.tx_hash || null,
      error: patch.error || null
    });
    this.save();
    return request;
  }

  listForDevice(deviceId) {
    return Object.values(this.state.intents)
      .filter((item) => item.target_app_device_id === deviceId)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }

  expireStale(nowMs = Date.now()) {
    let changed = false;
    for (const intent of Object.values(this.state.intents)) {
      if (intent.payment?.rail === "stellar_xlm" && !intent.payment.horizon_url) {
        const testnet = String(intent.payment.network || "").toLowerCase().includes("test");
        intent.payment.horizon_url = testnet ? "https://horizon-testnet.stellar.org" : "https://horizon.stellar.org";
        intent.payment.stellar_testnet = testnet;
        changed = true;
      }
      if (intent.status !== "pending") continue;
      if (Date.parse(intent.expires_at) > nowMs) continue;
      intent.status = "expired";
      intent.updated_at = new Date(nowMs).toISOString();
      intent.error = intent.error || "Payment request expired";
      intent.history = intent.history || [];
      intent.history.push({
        status: "expired",
        tx_hash: null,
        error: intent.error,
        at: intent.updated_at
      });
      this.event("payment_intent.status", intent.intent_id, {
        status: "expired",
        tx_hash: null,
        error: intent.error
      });
      changed = true;
    }
    for (const request of Object.values(this.state.paymentRequests)) {
      if (request.status !== "pending") continue;
      if (Date.parse(request.expires_at) > nowMs) continue;
      request.status = "expired";
      request.updated_at = new Date(nowMs).toISOString();
      request.error = request.error || "Payment request expired";
      request.history = request.history || [];
      request.history.push({
        status: "expired",
        tx_hash: null,
        error: request.error,
        at: request.updated_at
      });
      this.event("payment_request.status", request.request_id, {
        status: "expired",
        tx_hash: null,
        error: request.error
      });
      changed = true;
    }
    if (changed) this.save();
    return changed;
  }

  updateStatus(id, status, patch = {}) {
    const intent = this.state.intents[id];
    if (!intent) return null;
    intent.status = status;
    intent.updated_at = new Date().toISOString();
    if (patch.tx_hash) intent.tx_hash = patch.tx_hash;
    if (patch.error) intent.error = patch.error;
    intent.history = intent.history || [];
    intent.history.push({
      status,
      tx_hash: patch.tx_hash || null,
      error: patch.error || null,
      at: intent.updated_at
    });
    this.event("payment_intent.status", id, { status, tx_hash: patch.tx_hash || null, error: patch.error || null });
    this.save();
    return intent;
  }

  addDailySpent(asset, amount) {
    const day = new Date().toISOString().slice(0, 10);
    const key = `${day}:${asset.toUpperCase()}`;
    const before = Number(this.state.dailySpent[key] || 0);
    this.state.dailySpent[key] = before + Number(amount);
    this.save();
  }

  dailySpent(asset) {
    const day = new Date().toISOString().slice(0, 10);
    return Number(this.state.dailySpent[`${day}:${asset.toUpperCase()}`] || 0);
  }

  event(type, intentId, data) {
    this.state.events.push({
      seq: this.state.events.length + 1,
      type,
      intent_id: intentId,
      data,
      at: new Date().toISOString()
    });
    if (this.state.events.length > 1000) this.state.events = this.state.events.slice(-1000);
  }

  eventsSince(seq) {
    return this.state.events.filter((event) => event.seq > seq);
  }

  paymentRequestEventsForConnection(connectionId, seq = 0) {
    return this.eventsSince(seq).filter((event) => {
      if (!String(event.type || "").startsWith("payment_request.")) return false;
      if (event.data?.connection_id) return event.data.connection_id === connectionId;
      const requestId = event.data?.request_id || event.request_id || event.intent_id;
      const request = requestId ? this.paymentRequest(requestId) : null;
      return request?.connection_id === connectionId;
    });
  }
}
