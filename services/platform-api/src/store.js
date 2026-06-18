import fs from "fs";
import { DatabaseSync } from "node:sqlite";
import path from "path";
import { timingSafeTextEqual, tokenHash, verifyTokenHash } from "./crypto.js";
import { addDecimalStrings, normalizeDecimalString } from "./decimal.js";

const LEGACY_JSON_DATA_PATH = path.resolve("data/relay-store.json");
const DEFAULT_SQLITE_DATA_PATH = path.resolve("data/relay-store.sqlite");
const SQLITE_SCHEMA_VERSION = 1;

function initialState() {
  return {
    devices: {},
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
    eventSeq: 0,
    dailySpent: {}
  };
}

function paymentRequestIdempotencyScope(key, connectionId = "") {
  return `${connectionId || "legacy"}:${key}`;
}

// Idempotency keys are chosen by the caller, so a replay must only ever return a
// record that belongs to the SAME caller. For legacy payment intents the caller
// boundary is the wallet device the intent is delivered to (target_app_device_id),
// which is the exact dimension intent reads are authorized against. Scoping the
// idempotency map by that device stops a replayed key from leaking another
// device's payment intent.
function intentIdempotencyScope(key, targetAppDeviceId = "") {
  return `${targetAppDeviceId || "default"}:${key}`;
}

function defaultStorePath() {
  if (process.env.RELAY_STORE_PATH) return path.resolve(process.env.RELAY_STORE_PATH);
  if (normalizeDriver(process.env.RELAY_STORE_DRIVER || "") === "json") return LEGACY_JSON_DATA_PATH;
  return DEFAULT_SQLITE_DATA_PATH;
}

function inferDriver(file) {
  const ext = path.extname(String(file || "")).toLowerCase();
  if (ext === ".json") return "json";
  return "sqlite";
}

function normalizeDriver(value) {
  const driver = String(value || "").trim().toLowerCase();
  if (!driver) return "";
  if (driver === "json" || driver === "file") return "json";
  if (driver === "sqlite" || driver === "sqlite3" || driver === "db") return "sqlite";
  throw new Error(`Unsupported relay store driver: ${value}`);
}

function sqliteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export class Store {
  constructor(file = defaultStorePath(), options = {}) {
    this.file = file;
    this.driver = normalizeDriver(options.driver || process.env.RELAY_STORE_DRIVER || inferDriver(file));
    this.legacyJsonFile = options.legacyJsonFile || process.env.RELAY_STORE_LEGACY_JSON || (
      this.driver === "sqlite" && file === DEFAULT_SQLITE_DATA_PATH ? LEGACY_JSON_DATA_PATH : ""
    );
    this.db = null;
    this.state = initialState();
    this.load();
  }

  load() {
    if (this.driver === "sqlite") {
      this.loadSqlite();
      return;
    }
    this.loadJson();
  }

  loadJson() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) {
      this.save();
      return;
    }
    this.state = { ...initialState(), ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
  }

  loadSqlite() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.applySqlitePragmas();
    this.applySqliteMigrations();
    const row = this.db.prepare("SELECT state_json FROM relay_state WHERE id = 1").get();
    if (row?.state_json) {
      this.state = { ...initialState(), ...JSON.parse(row.state_json) };
      return;
    }
    if (this.legacyJsonFile && fs.existsSync(this.legacyJsonFile)) {
      this.state = { ...initialState(), ...JSON.parse(fs.readFileSync(this.legacyJsonFile, "utf8")) };
      this.save();
      this.writeMigrationMarker();
      return;
    }
    this.save();
  }

  save() {
    if (this.driver === "sqlite") {
      this.saveSqlite();
      return;
    }
    this.saveJson();
  }

  saveJson() {
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  saveSqlite() {
    if (!this.db) throw new Error("SQLite store is not open");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.writeStateRow();
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  // Persist the whole in-memory state into the single relay_state row. The
  // caller MUST already hold an open transaction (saveSqlite / mutateSqlite).
  writeStateRow() {
    const payload = JSON.stringify(this.state);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO relay_state (id, state_json, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(payload, now);
  }

  reloadSqliteState() {
    const row = this.db?.prepare("SELECT state_json FROM relay_state WHERE id = 1").get();
    if (row?.state_json) this.state = { ...initialState(), ...JSON.parse(row.state_json) };
  }

  // Concurrency-safe whole-store read-modify-write (H4).
  //
  // The store keeps the entire database in memory and, on SQLite, persists it as
  // one JSON blob in relay_state(id=1). The old code read that blob ONCE at
  // startup, then rewrote the whole thing on every change from its cached copy.
  // With two writers — a second API instance, or the backup/maintenance scripts
  // running beside the server — each overwrote the other's blob wholesale,
  // silently dropping the other's updates. It is the textbook lost update: the
  // "read" happened at load time, arbitrarily far from the "write".
  //
  // mutate(fn) closes that gap by holding the read and the write together:
  //   SQLite: BEGIN IMMEDIATE takes the write lock up front, we RE-READ the
  //           latest committed blob inside that lock, apply fn() to that fresh
  //           state, write it back, and COMMIT. A concurrent writer can no
  //           longer be clobbered, because nobody else can commit between our
  //           read and our write.
  //   JSON:   apply fn() and rewrite the file. The JSON driver is single-process
  //           only (a plain file has no cross-process lock); within one Node
  //           process its synchronous write is already atomic. Use the SQLite
  //           driver for multi-process / HA deployments.
  mutate(fn) {
    if (this.driver === "sqlite") return this.mutateSqlite(fn);
    const result = fn();
    this.saveJson();
    return result;
  }

  mutateSqlite(fn) {
    if (!this.db) throw new Error("SQLite store is not open");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.reloadSqliteState();
      const result = fn();
      this.writeStateRow();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      // fn() may have partly mutated the cache before throwing; resync from the
      // durable row so the in-memory state never drifts from disk.
      try { this.reloadSqliteState(); } catch { /* leave cache as-is */ }
      throw error;
    }
  }

  applySqlitePragmas() {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  applySqliteMigrations() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relay_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const applied = this.db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(SQLITE_SCHEMA_VERSION);
    if (!applied) {
      this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        SQLITE_SCHEMA_VERSION,
        new Date().toISOString()
      );
    }
  }

  writeMigrationMarker() {
    const marker = `${this.legacyJsonFile}.migrated-to-sqlite`;
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, `Migrated to ${this.file} at ${new Date().toISOString()}\n`);
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  info() {
    return {
      driver: this.driver,
      file: this.file,
      schema_version: this.driver === "sqlite" ? SQLITE_SCHEMA_VERSION : null,
      legacy_json_file: this.legacyJsonFile || null
    };
  }

  backup(targetFile) {
    if (!targetFile) throw new Error("backup targetFile is required");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    if (this.driver === "sqlite") {
      if (!this.db) throw new Error("SQLite store is not open");
      this.db.exec(`VACUUM INTO ${sqliteLiteral(targetFile)}`);
      return targetFile;
    }
    fs.copyFileSync(this.file, targetFile);
    return targetFile;
  }

  registerDevice(deviceId, token) {
    return this.mutate(() => {
      const now = new Date().toISOString();
      const device = {
        device_id: deviceId,
        token_hash: tokenHash(token),
        registered_at: now,
        last_seen_at: now
      };
      this.state.devices[deviceId] = device;
      return { ...device, token };
    });
  }

  device(deviceId) {
    return this.state.devices[deviceId];
  }

  verifyDeviceToken(deviceId, token) {
    const device = this.device(deviceId);
    if (!device || !token) return false;
    if (device.token_hash && verifyTokenHash(token, device.token_hash)) return true;
    if (device.token && timingSafeTextEqual(device.token, token)) {
      this.migrateDeviceToken(deviceId, token);
      return true;
    }
    return false;
  }

  rotateDeviceToken(deviceId, token) {
    return this.mutate(() => {
      const device = this.device(deviceId);
      if (!device) return null;
      device.token_hash = tokenHash(token);
      delete device.token;
      device.last_seen_at = new Date().toISOString();
      device.token_rotated_at = device.last_seen_at;
      this.event("app_device.token_rotated", deviceId, { device_id: deviceId });
      return { ...device, token };
    });
  }

  migrateDeviceToken(deviceId, token) {
    return this.mutate(() => {
      const device = this.device(deviceId);
      if (!device) return null;
      device.token_hash = tokenHash(token);
      delete device.token;
      device.last_seen_at = new Date().toISOString();
      return device;
    });
  }

  createPairingSession(sessionId, pairingCode, data = {}) {
    return this.mutate(() => {
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
      return session;
    });
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
    return this.mutate(() => {
      const session = this.state.pairingSessions[sessionId];
      if (!session) return null;
      Object.assign(session, patch, { updated_at: new Date().toISOString() });
      this.event("pairing_session.status", sessionId, { status: session.status });
      return session;
    });
  }

  expirePairingSessions(nowMs = Date.now()) {
    // Fast path: scanning is read-only, so don't take a write lock unless at
    // least one pending session is actually due to expire.
    if (!this.hasExpirablePairingSessions(nowMs)) return false;
    return this.mutate(() => {
      let changed = false;
      for (const session of Object.values(this.state.pairingSessions)) {
        if (session.status !== "pending") continue;
        if (!this.isPairingSessionExpired(session, nowMs)) continue;
        session.status = "expired";
        session.updated_at = new Date(nowMs).toISOString();
        this.event("pairing_session.status", session.pairing_session_id, { status: "expired" });
        changed = true;
      }
      return changed;
    });
  }

  hasExpirablePairingSessions(nowMs = Date.now()) {
    for (const session of Object.values(this.state.pairingSessions)) {
      if (session.status === "pending" && this.isPairingSessionExpired(session, nowMs)) return true;
    }
    return false;
  }

  createConnection(connectionId, token, data = {}) {
    return this.mutate(() => {
      const now = new Date().toISOString();
      const scopes = data.scopes || data.approved_scopes || [];
      const connection = {
        connection_id: connectionId,
        connection_token_hash: tokenHash(token),
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
      this.state.connectionTokens[connection.connection_token_hash] = connectionId;
      this.event("connection.created", connectionId, { status: connection.status });
      return { ...connection, connection_token: token };
    });
  }

  connection(connectionId) {
    return this.state.connections[connectionId] || null;
  }

  connectionByToken(token) {
    if (!token) return null;
    const hash = tokenHash(token);
    const connectionId = this.state.connectionTokens[hash] || this.state.connectionTokens[token];
    const connection = connectionId ? this.connection(connectionId) : null;
    if (connection?.connection_token && timingSafeTextEqual(connection.connection_token, token)) {
      this.migrateConnectionToken(connection.connection_id, token);
      // migrateConnectionToken may reload the cache, so return the fresh record.
      return this.connection(connection.connection_id);
    }
    return connection;
  }

  listConnectionsForDevice(deviceId) {
    return Object.values(this.state.connections)
      .filter((connection) => connection.approved_by_device_id === deviceId)
      .sort((a, b) => Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at));
  }

  updateConnectionStatus(connectionId, status, data = {}) {
    return this.mutate(() => {
      const connection = this.connection(connectionId);
      if (!connection) return null;
      connection.status = status;
      connection.updated_at = new Date().toISOString();
      if (data.revoked_by_device_id) connection.revoked_by_device_id = data.revoked_by_device_id;
      if (data.revoked_at) connection.revoked_at = data.revoked_at;
      this.event("connection.status", connectionId, { status: connection.status });
      return connection;
    });
  }

  rotateConnectionToken(connectionId, token) {
    return this.mutate(() => {
      const connection = this.connection(connectionId);
      if (!connection) return null;
      this.deleteConnectionTokenIndexes(connectionId);
      connection.connection_token_hash = tokenHash(token);
      delete connection.connection_token;
      connection.updated_at = new Date().toISOString();
      connection.token_rotated_at = connection.updated_at;
      this.state.connectionTokens[connection.connection_token_hash] = connectionId;
      this.event("connection.token_rotated", connectionId, { status: connection.status });
      return { ...connection, connection_token: token };
    });
  }

  migrateConnectionToken(connectionId, token) {
    return this.mutate(() => {
      const connection = this.connection(connectionId);
      if (!connection) return null;
      this.deleteConnectionTokenIndexes(connectionId);
      connection.connection_token_hash = tokenHash(token);
      delete connection.connection_token;
      this.state.connectionTokens[connection.connection_token_hash] = connectionId;
      return connection;
    });
  }

  deleteConnectionTokenIndexes(connectionId) {
    for (const [token, value] of Object.entries(this.state.connectionTokens)) {
      if (value === connectionId) delete this.state.connectionTokens[token];
    }
  }

  touchConnection(connectionId) {
    return this.mutate(() => {
      const connection = this.connection(connectionId);
      if (!connection) return null;
      connection.last_activity_at = new Date().toISOString();
      connection.updated_at = connection.last_activity_at;
      return connection;
    });
  }

  putIntent(intent) {
    return this.mutate(() => {
      this.state.intents[intent.intent_id] = intent;
      if (intent.idempotency_key) {
        this.state.idempotency[intentIdempotencyScope(intent.idempotency_key, intent.target_app_device_id)] = intent.intent_id;
      }
      this.event("payment_intent.created", intent.intent_id, { status: intent.status });
      return intent;
    });
  }

  intent(id) {
    return this.state.intents[id];
  }

  findByIdempotency(key, targetAppDeviceId = "") {
    // Scoped to the target wallet device on purpose: never fall back to a bare,
    // cross-device key. A miss simply means a fresh intent is created, which is
    // the safe outcome compared with returning someone else's intent.
    const id = this.state.idempotency[intentIdempotencyScope(key, targetAppDeviceId)];
    return id ? this.state.intents[id] : null;
  }

  putTransactionContext(context) {
    return this.mutate(() => {
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
      return stored;
    });
  }

  transactionContext(transactionId) {
    return this.state.transactionContexts[transactionId] || null;
  }

  listTransactionContexts() {
    return Object.values(this.state.transactionContexts)
      .sort((a, b) => Date.parse(b.updated_at || b.created_at || 0) - Date.parse(a.updated_at || a.created_at || 0));
  }

  // Authorization for the wallet "app" read path. A Transaction Context is owned
  // by the connection that created it, and that connection is bound to exactly
  // one wallet device at pairing time (connection.approved_by_device_id). A
  // wallet device may therefore read a context ONLY when it approved that
  // connection. Without this check any registered device could read any context
  // by id, because a valid device token alone proves nothing about ownership
  // (bug H6: transaction context readable by the wrong connection / any device).
  deviceCanReadTransactionContext(deviceId, context) {
    const device = String(deviceId || "").trim();
    if (!device || !context) return false;
    const connectionId = String(context.connection_id || "").trim();
    // An unbound/legacy context has no owning connection, so no wallet device can
    // claim it through the app path. It is reachable only via its own connection
    // token or the explicitly trusted legacy connector path.
    if (!connectionId) return false;
    const connection = this.connection(connectionId);
    if (!connection) return false;
    return String(connection.approved_by_device_id || "").trim() === device;
  }

  putPaymentRequest(request) {
    return this.mutate(() => {
      const stored = {
        ...request,
        history: request.history || [{ status: request.status, at: request.created_at }]
      };
      this.state.paymentRequests[stored.request_id] = stored;
      if (stored.idempotency_key) {
        // Always key by connection scope. Connection-less (legacy) requests land in
        // the shared "legacy" scope; we deliberately do NOT also write a bare,
        // unscoped key, because that bare entry could otherwise be read back by a
        // different, connection-authenticated caller and leak this request.
        this.state.paymentRequestIdempotency[paymentRequestIdempotencyScope(stored.idempotency_key, stored.connection_id)] = stored.request_id;
      }
      this.event("payment_request.created", stored.request_id, {
        request_id: stored.request_id,
        transaction_id: stored.transaction_id || null,
        connection_id: stored.connection_id || null,
        target_app_device_id: stored.target_app_device_id || null,
        status: stored.status
      });
      return stored;
    });
  }

  paymentRequest(requestId) {
    return this.state.paymentRequests[requestId] || null;
  }

  findPaymentRequestByIdempotency(key, connectionId = "") {
    const scopedId = this.state.paymentRequestIdempotency[paymentRequestIdempotencyScope(key, connectionId)];
    if (scopedId) return this.state.paymentRequests[scopedId] || null;

    // A connection-authenticated caller must only ever see its own scoped record.
    // Never fall back to a bare/legacy key for them, or a replayed idempotency key
    // would surface a request created by a different connection.
    if (connectionId) return null;

    // Connection-less (legacy) caller: tolerate bare keys persisted by older
    // builds, but only when the stored request is itself connection-less, so this
    // path can never reach into a real connection's data.
    const legacyId = this.state.paymentRequestIdempotency[key];
    const legacy = legacyId ? this.state.paymentRequests[legacyId] || null : null;
    if (!legacy) return null;
    if (legacy.connection_id) return null;
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
    return this.mutate(() => {
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
      return request;
    });
  }

  listForDevice(deviceId) {
    return Object.values(this.state.intents)
      .filter((item) => item.target_app_device_id === deviceId)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }

  expireStale(nowMs = Date.now()) {
    // Fast path: expireStale runs on read endpoints. Only escalate to a write
    // lock when there is actually stale work to do (an expiry is due, or a
    // stellar intent still needs its Horizon URL backfilled).
    if (!this.hasStaleWork(nowMs)) return false;
    return this.mutate(() => {
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
      return changed;
    });
  }

  // Cheap, read-only probe used by expireStale's fast path. Mirrors the
  // conditions under which expireStale would actually change state.
  hasStaleWork(nowMs = Date.now()) {
    for (const intent of Object.values(this.state.intents)) {
      if (intent.payment?.rail === "stellar_xlm" && !intent.payment.horizon_url) return true;
      if (intent.status === "pending" && Date.parse(intent.expires_at) <= nowMs) return true;
    }
    for (const request of Object.values(this.state.paymentRequests)) {
      if (request.status === "pending" && Date.parse(request.expires_at) <= nowMs) return true;
    }
    return false;
  }

  updateStatus(id, status, patch = {}) {
    return this.mutate(() => {
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
      return intent;
    });
  }

  // Daily spend is tracked as an EXACT decimal string, never a float64
  // Number. Accumulating money with `+` on Numbers (the old code) drifts a
  // little with every payment, so the stored total slowly diverges from the
  // real sum — enough to make the cap inaccurate and let spend slip past it
  // (H3). All arithmetic now goes through BigInt minor units in decimal.js.
  addDailySpent(asset, amount) {
    // Validate before locking: a bad amount must never poison the cap, and we
    // must not take a write lock for a no-op.
    const addend = normalizeDecimalString(amount);
    if (addend === null) return; // never poison the cap with a bad amount
    this.mutate(() => {
      const day = new Date().toISOString().slice(0, 10);
      const key = `${day}:${asset.toUpperCase()}`;
      // `before` is read INSIDE the locked read-modify-write, so concurrent
      // writers accumulate exactly instead of clobbering each other (H4) — the
      // bug that let parallel confirmations under-count the daily cap. `?? "0"`
      // still tolerates a legacy float total written by the old code.
      const before = normalizeDecimalString(this.state.dailySpent[key]) ?? "0";
      this.state.dailySpent[key] = addDecimalStrings(before, addend);
    });
  }

  // Returns today's spend for `asset` as a canonical decimal string ("0"
  // when nothing has been recorded, or when a legacy value can't be parsed).
  dailySpent(asset) {
    const day = new Date().toISOString().slice(0, 10);
    return normalizeDecimalString(this.state.dailySpent[`${day}:${asset.toUpperCase()}`]) ?? "0";
  }

  // Generate the next event sequence number from a persistent, monotonic
  // counter — NOT from `events.length`. The events array is capped at 1000
  // entries (see below), so deriving `seq` from its length would pin every
  // event past the cap at the same number, freezing every agent's `?since=N`
  // cursor and silently killing status updates. The counter only ever grows.
  nextEventSeq() {
    const counter = Number(this.state.eventSeq) || 0;
    // Defensive backfill for stores written before `eventSeq` existed (or
    // already corrupted by the old length-based logic): never hand out a seq
    // an agent may already have observed in the retained buffer.
    let highestSeen = counter;
    for (const event of this.state.events) {
      const seq = Number(event?.seq) || 0;
      if (seq > highestSeen) highestSeen = seq;
    }
    const next = highestSeen + 1;
    this.state.eventSeq = next;
    return next;
  }

  event(type, intentId, data) {
    this.state.events.push({
      seq: this.nextEventSeq(),
      type,
      intent_id: intentId,
      data,
      at: new Date().toISOString()
    });
    // Truncation bounds memory/storage only; it must never influence `seq`.
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
