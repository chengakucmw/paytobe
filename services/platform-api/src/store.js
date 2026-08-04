import fs from "fs";
import { DatabaseSync } from "node:sqlite";
import path from "path";
import { timingSafeTextEqual, tokenHash, verifyTokenHash } from "./crypto.js";
import { createConnectionBinding } from "./application/connections/binding.js";
import { addDecimalStrings, compareDecimalStrings, normalizeDecimalString } from "./decimal.js";
import {
  applySqliteMerchantSchema,
  SQLITE_MERCHANT_SCHEMA_VERSION,
  sqliteMerchantMigrationReport
} from "./adapters/sqlite/merchant-schema.js";

const LEGACY_JSON_DATA_PATH = path.resolve("data/relay-store.json");
const DEFAULT_SQLITE_DATA_PATH = path.resolve("data/relay-store.sqlite");
const NORMALIZED_RELAY_SCHEMA_VERSION = 2;
const SQLITE_SCHEMA_VERSION = SQLITE_MERCHANT_SCHEMA_VERSION;

// Terminal payment lifecycle states — no further transitions, so records in these
// states are safe to retention-prune once old (mirrors the protocol's terminal set).
const TERMINAL_STATUSES = Object.freeze(new Set(["confirmed", "failed", "expired", "rejected", "cancelled"]));

// Default retention for terminal records before pruning. Generous so historical
// status reads / idempotency replays keep working for a long time. Override with the
// RELAY_RETENTION_MS env var; set it to 0 to disable retention pruning entirely.
const DEFAULT_RETENTION_MS = (() => {
  const raw = Number(process.env.RELAY_RETENTION_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 7 * 24 * 60 * 60 * 1000;
})();

// Schema v2 persists the relay state as one normalized table per in-memory
// collection instead of a single JSON blob. Each row is (k, json): the
// collection's key and its JSON-encoded value, which preserves the exact
// round-trip the old single-blob store had. `events` (ordered, integer seq PK)
// and `meta` (scalars like eventSeq) are handled separately. Adding a new
// top-level collection = add one line here.
const OBJECT_COLLECTIONS = Object.freeze([
  { state: "devices", table: "devices" },
  { state: "pairingSessions", table: "pairing_sessions" },
  { state: "pairingCodes", table: "pairing_codes" },
  { state: "connectInvitations", table: "connect_invitations" },
  { state: "connectKeys", table: "connect_keys" },
  { state: "connectClaimTokens", table: "connect_claim_tokens" },
  { state: "connections", table: "connections" },
  { state: "connectionTokens", table: "connection_tokens" },
  { state: "paymentRequests", table: "payment_requests" },
  { state: "paymentRequestIdempotency", table: "payment_request_idempotency" },
  { state: "intents", table: "intents" },
  { state: "transactionContexts", table: "transaction_contexts" },
  { state: "idempotency", table: "idempotency" },
  { state: "dailySpent", table: "daily_spent" },
  // F1: in-flight daily-cap reservations (held -> settled/released). Persisted so
  // a restart does not lose committed-but-unconfirmed headroom.
  { state: "reservations", table: "reservations" }
]);

function initialState() {
  return {
    devices: {},
    pairingSessions: {},
    pairingCodes: {},
    connectInvitations: {},
    connectKeys: {},
    connectClaimTokens: {},
    connections: {},
    connectionTokens: {},
    paymentRequests: {},
    paymentRequestIdempotency: {},
    intents: {},
    transactionContexts: {},
    idempotency: {},
    events: [],
    eventSeq: 0,
    dailySpent: {},
    reservations: {}
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
    this.ensureSchema();

    // Already on the normalized relay schema: the per-collection tables are the
    // source of truth. Merchant schema migration runs after the v1/v2 import so
    // the migration can account for and attribute every imported row.
    if (this.schemaVersion() >= NORMALIZED_RELAY_SCHEMA_VERSION) {
      this.loadStateFromTables();
    } else {
      // First open under the normalized schema. Import from the best available
      // source exactly once, write it into the tables, then stamp v2 so we never
      // re-import. No source data is dropped.
      const legacy = this.db.prepare("SELECT state_json FROM relay_state WHERE id = 1").get();
      if (legacy?.state_json) {
        this.state = { ...initialState(), ...JSON.parse(legacy.state_json) };
        this.importStateAndStamp();
      } else if (this.legacyJsonFile && fs.existsSync(this.legacyJsonFile)) {
        this.state = { ...initialState(), ...JSON.parse(fs.readFileSync(this.legacyJsonFile, "utf8")) };
        this.importStateAndStamp();
        this.writeMigrationMarker();
      } else {
        this.importStateAndStamp();
      }
    }
    this.lastMerchantMigration = applySqliteMerchantSchema(this.db);
    if (this.schemaVersion() < SQLITE_SCHEMA_VERSION) {
      throw new Error("SQLite merchant schema migration did not reach the expected version");
    }
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
      this.persistFullRows();
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  // First-open import: write the imported state into the normalized tables AND
  // stamp the schema version in ONE transaction, so a crash can never leave the
  // data imported but the version unstamped (which would otherwise re-run the
  // import on the next open).
  importStateAndStamp() {
    if (!this.db) throw new Error("SQLite store is not open");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.persistFullRows();
      this.stampSchemaVersion(NORMALIZED_RELAY_SCHEMA_VERSION);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  // Hydrate the in-memory state from the normalized tables. Every read method
  // operates on this.state, so loading is "read each table back into the same
  // object shape initialState() defines".
  loadStateFromTables() {
    const next = initialState();
    for (const { state, table } of OBJECT_COLLECTIONS) {
      const out = {};
      for (const row of this.db.prepare(`SELECT k, json FROM ${table}`).all()) {
        out[row.k] = JSON.parse(row.json);
      }
      next[state] = out;
    }
    next.events = this.db.prepare("SELECT json FROM events ORDER BY seq").all().map((row) => JSON.parse(row.json));
    const seqRow = this.db.prepare("SELECT json FROM meta WHERE k = 'eventSeq'").get();
    next.eventSeq = seqRow ? JSON.parse(seqRow.json) : 0;
    this.state = next;
  }

  // Snapshot state as {collection: {key: jsonString}} so the following write can
  // touch ONLY the rows that actually changed — the whole point of the normalized
  // schema (no more rewriting the entire database on every single write).
  snapshotState() {
    const snap = {};
    for (const { state } of OBJECT_COLLECTIONS) {
      const out = {};
      for (const [k, value] of Object.entries(this.state[state] || {})) out[k] = JSON.stringify(value);
      snap[state] = out;
    }
    const events = {};
    for (const event of this.state.events || []) events[event.seq] = JSON.stringify(event);
    snap.events = events;
    snap.eventSeq = JSON.stringify(this.state.eventSeq ?? 0);
    return snap;
  }

  // Full flush: make the tables exactly match this.state. Used by save() and the
  // one-time import on first open. Caller already holds the transaction.
  persistFullRows() {
    for (const { state, table } of OBJECT_COLLECTIONS) {
      this.db.exec(`DELETE FROM ${table}`);
      const insert = this.db.prepare(`INSERT INTO ${table} (k, json) VALUES (?, ?)`);
      for (const [k, value] of Object.entries(this.state[state] || {})) insert.run(k, JSON.stringify(value));
    }
    this.db.exec("DELETE FROM events");
    const insertEvent = this.db.prepare("INSERT INTO events (seq, json) VALUES (?, ?) ON CONFLICT(seq) DO UPDATE SET json = excluded.json");
    for (const event of this.state.events || []) insertEvent.run(event.seq, JSON.stringify(event));
    this.writeMeta("eventSeq", this.state.eventSeq ?? 0);
  }

  // Delta flush: UPSERT changed rows and DELETE removed ones by comparing the
  // post-mutation state to `before` (the snapshot taken right after the in-lock
  // reload). Caller already holds the transaction.
  persistDeltaRows(before) {
    for (const { state, table } of OBJECT_COLLECTIONS) {
      const prev = before[state] || {};
      const curr = this.state[state] || {};
      const upsert = this.db.prepare(`INSERT INTO ${table} (k, json) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET json = excluded.json`);
      const remove = this.db.prepare(`DELETE FROM ${table} WHERE k = ?`);
      for (const [k, value] of Object.entries(curr)) {
        const json = JSON.stringify(value);
        if (prev[k] !== json) upsert.run(k, json);
      }
      for (const k of Object.keys(prev)) {
        if (!(k in curr)) remove.run(k);
      }
    }

    const prevEvents = before.events || {};
    const upsertEvent = this.db.prepare("INSERT INTO events (seq, json) VALUES (?, ?) ON CONFLICT(seq) DO UPDATE SET json = excluded.json");
    const removeEvent = this.db.prepare("DELETE FROM events WHERE seq = ?");
    const liveSeqs = new Set();
    for (const event of this.state.events || []) {
      liveSeqs.add(event.seq);
      const json = JSON.stringify(event);
      if (prevEvents[event.seq] !== json) upsertEvent.run(event.seq, json);
    }
    for (const seq of Object.keys(prevEvents)) {
      if (!liveSeqs.has(Number(seq))) removeEvent.run(Number(seq));
    }

    if (before.eventSeq !== JSON.stringify(this.state.eventSeq ?? 0)) {
      this.writeMeta("eventSeq", this.state.eventSeq ?? 0);
    }
  }

  writeMeta(key, value) {
    this.db.prepare("INSERT INTO meta (k, json) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET json = excluded.json").run(key, JSON.stringify(value));
  }

  reloadSqliteState() {
    if (this.db) this.loadStateFromTables();
  }

  // Concurrency-safe whole-store read-modify-write (H4).
  //
  // The store keeps the entire database in memory and, on SQLite, persists it as
  // one normalized table per collection (schema v2). The old code read state
  // ONCE at startup, then rewrote the whole thing on every change from its cache.
  // With two writers — a second API instance, or the backup/maintenance scripts
  // running beside the server — each overwrote the other's blob wholesale,
  // silently dropping the other's updates. It is the textbook lost update: the
  // "read" happened at load time, arbitrarily far from the "write".
  //
  // mutate(fn) closes that gap by holding the read and the write together:
  //   SQLite: BEGIN IMMEDIATE takes the write lock up front, we RE-READ the
  //           latest committed state inside that lock, apply fn() to that fresh
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
      const before = this.snapshotState();
      const result = fn();
      this.persistDeltaRows(before);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      // fn() may have partly mutated the cache before throwing; resync from the
      // durable tables so the in-memory state never drifts from disk.
      try { this.reloadSqliteState(); } catch { /* leave cache as-is */ }
      throw error;
    }
  }

  applySqlitePragmas() {
    // busy_timeout MUST be set first. Switching to WAL momentarily needs an
    // exclusive lock; if another connection (a second API instance or the
    // backup/maintenance script — the exact multi-writer case the H4 fix
    // supports) holds the file, this would otherwise fail immediately with
    // "database is locked" instead of waiting. Setting the timeout up front lets
    // every subsequent pragma and transaction wait out contention.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  ensureSchema() {
    const statements = [
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      // Legacy v1 single-blob table. Retained read-only so an existing v1 store
      // can be migrated into the normalized tables; never written after that.
      "CREATE TABLE IF NOT EXISTS relay_state (id INTEGER PRIMARY KEY CHECK (id = 1), state_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, json TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, json TEXT NOT NULL)"
    ];
    for (const { table } of OBJECT_COLLECTIONS) {
      statements.push(`CREATE TABLE IF NOT EXISTS ${table} (k TEXT PRIMARY KEY, json TEXT NOT NULL)`);
    }
    this.db.exec(statements.join(";\n"));
  }

  schemaVersion() {
    const row = this.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
    return Number(row?.version) || 0;
  }

  stampSchemaVersion(targetVersion = NORMALIZED_RELAY_SCHEMA_VERSION) {
    const now = new Date().toISOString();
    const insert = this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)");
    for (let version = 1; version <= targetVersion; version++) insert.run(version, now);
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
      merchant_migration: this.driver === "sqlite" && this.db ? sqliteMerchantMigrationReport(this.db) : null,
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
      // M6: first-create-only. Re-registering an existing device_id must NOT
      // silently overwrite its token_hash — that let anyone who knew or guessed
      // a device_id take the device over (and, with C1, hijack its inbox). The
      // existence check runs INSIDE the write lock so two concurrent registers
      // can't both win. Callers treat `null` as "already exists" → HTTP 409.
      if (this.state.devices[deviceId]) return null;
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

  setDevicePushToken(deviceId, record) {
    return this.mutate(() => {
      const device = this.device(deviceId);
      if (!device) return null;
      const now = new Date().toISOString();
      device.push = {
        provider: "fcm",
        status: "active",
        token_hash: record.token_hash,
        token_ciphertext: record.token_ciphertext,
        updated_at: now
      };
      device.last_seen_at = now;
      this.event("app_device.push_token_registered", deviceId, { device_id: deviceId, provider: "fcm" });
      return device;
    });
  }

  clearDevicePushToken(deviceId, expectedTokenHash = "") {
    return this.mutate(() => {
      const device = this.device(deviceId);
      if (!device?.push) return null;
      if (expectedTokenHash && device.push.token_hash !== expectedTokenHash) return null;
      const now = new Date().toISOString();
      device.push = {
        provider: "fcm",
        status: "inactive",
        updated_at: now
      };
      device.last_seen_at = now;
      this.event("app_device.push_token_cleared", deviceId, { device_id: deviceId, provider: "fcm" });
      return device;
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

  createConnectInvitation(invitationId, connectKey, data = {}) {
    return this.mutate(() => {
      const connectKeyHash = tokenHash(connectKey);
      if (this.state.connectKeys[connectKeyHash]) return null;
      const now = new Date().toISOString();
      const invitation = {
        connect_invitation_id: invitationId,
        connect_key_hash: connectKeyHash,
        target_app_device_id: data.target_app_device_id || "",
        status: "waiting",
        created_at: now,
        updated_at: now,
        expires_at: data.expires_at
      };
      this.state.connectInvitations[invitationId] = invitation;
      this.state.connectKeys[connectKeyHash] = invitationId;
      this.event("connect_invitation.created", invitationId, { status: invitation.status });
      return { ...invitation, connect_key: connectKey };
    });
  }

  connectInvitation(invitationId) {
    return this.state.connectInvitations[invitationId] || null;
  }

  listConnectInvitationsForDevice(deviceId) {
    return Object.values(this.state.connectInvitations)
      .filter((invitation) => invitation.target_app_device_id === deviceId)
      .sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || "")))
      .map((invitation) => ({ ...invitation }));
  }

  connectInvitationByKey(connectKey) {
    if (!connectKey) return null;
    const invitationId = this.state.connectKeys[tokenHash(connectKey)];
    return invitationId ? this.connectInvitation(invitationId) : null;
  }

  connectInvitationByClaimToken(claimToken) {
    if (!claimToken) return null;
    const invitationId = this.state.connectClaimTokens[tokenHash(claimToken)];
    return invitationId ? this.connectInvitation(invitationId) : null;
  }

  claimConnectInvitationAndCreatePairingSession(connectKey, claimToken, pairingSessionId, data = {}) {
    return this.mutate(() => {
      const invitationId = this.state.connectKeys[tokenHash(connectKey)];
      const invitation = invitationId ? this.state.connectInvitations[invitationId] : null;
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      if (!invitation || invitation.status !== "waiting") return null;
      if (!invitation.expires_at || Date.parse(invitation.expires_at) <= nowMs) {
        invitation.status = "expired";
        invitation.updated_at = now;
        invitation.expired_at = now;
        this.event("connect_invitation.status", invitation.connect_invitation_id, { status: "expired" });
        return null;
      }

      const claimTokenHash = tokenHash(claimToken);
      const session = {
        pairing_session_id: pairingSessionId,
        pairing_code: "",
        pairing_uri: "",
        agent_identity: data.agent_identity || {},
        identity_assurance: data.identity_assurance || "unverified",
        requested_scopes: data.requested_scopes || [],
        target_app_device_id: invitation.target_app_device_id,
        connect_invitation_id: invitation.connect_invitation_id,
        status: "pending",
        created_at: now,
        updated_at: now,
        expires_at: invitation.expires_at
      };
      if (data.auth_binding) session.auth_binding = { ...data.auth_binding };

      invitation.status = "claimed";
      invitation.updated_at = now;
      invitation.claimed_at = now;
      invitation.claim_token_hash = claimTokenHash;
      invitation.pairing_session_id = pairingSessionId;
      invitation.agent_identity = session.agent_identity;
      invitation.identity_assurance = session.identity_assurance;
      invitation.requested_scopes = session.requested_scopes;
      if (data.auth_binding) invitation.auth_binding = { ...data.auth_binding };
      this.state.connectClaimTokens[claimTokenHash] = invitation.connect_invitation_id;
      this.state.pairingSessions[pairingSessionId] = session;
      this.event("connect_invitation.status", invitation.connect_invitation_id, { status: invitation.status });
      this.event("pairing_session.created", pairingSessionId, { status: session.status });
      return {
        connect_invitation: { ...invitation },
        pairing_session: { ...session },
        claim_token: claimToken
      };
    });
  }

  updateConnectInvitation(invitationId, patch = {}) {
    return this.mutate(() => {
      const invitation = this.state.connectInvitations[invitationId];
      if (!invitation) return null;
      Object.assign(invitation, patch, { updated_at: new Date().toISOString() });
      this.event("connect_invitation.status", invitationId, { status: invitation.status });
      return invitation;
    });
  }

  cancelConnectInvitation(invitationId, deviceId) {
    return this.mutate(() => {
      const invitation = this.state.connectInvitations[invitationId];
      if (!invitation || invitation.target_app_device_id !== deviceId) return null;
      if (!["waiting", "claimed"].includes(invitation.status)) return { ...invitation, unchanged: true };
      const now = new Date().toISOString();
      invitation.status = "cancelled";
      invitation.cancelled_at = now;
      invitation.updated_at = now;
      const session = invitation.pairing_session_id
        ? this.state.pairingSessions[invitation.pairing_session_id]
        : null;
      if (session?.status === "pending") {
        session.status = "rejected";
        session.rejected_at = now;
        session.rejected_by_device_id = deviceId;
        session.updated_at = now;
        this.event("pairing_session.status", session.pairing_session_id, { status: session.status });
      }
      this.event("connect_invitation.status", invitationId, { status: invitation.status });
      return invitation;
    });
  }

  expireConnectInvitations(nowMs = Date.now()) {
    const expirable = Object.values(this.state.connectInvitations).some((invitation) => (
      ["waiting", "claimed"].includes(invitation.status)
      && invitation.expires_at
      && Date.parse(invitation.expires_at) <= nowMs
    ));
    if (!expirable) return false;
    return this.mutate(() => {
      let changed = false;
      const now = new Date(nowMs).toISOString();
      for (const invitation of Object.values(this.state.connectInvitations)) {
        if (!["waiting", "claimed"].includes(invitation.status)) continue;
        if (!invitation.expires_at || Date.parse(invitation.expires_at) > nowMs) continue;
        invitation.status = "expired";
        invitation.expired_at = now;
        invitation.updated_at = now;
        const session = invitation.pairing_session_id
          ? this.state.pairingSessions[invitation.pairing_session_id]
          : null;
        if (session?.status === "pending") {
          session.status = "expired";
          session.updated_at = now;
          this.event("pairing_session.status", session.pairing_session_id, { status: session.status });
        }
        this.event("connect_invitation.status", invitation.connect_invitation_id, { status: invitation.status });
        changed = true;
      }
      return changed;
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
        identity_assurance: data.identity_assurance || "unverified",
        requested_scopes: data.requested_scopes || [],
        target_app_device_id: data.target_app_device_id || "",
        connect_invitation_id: data.connect_invitation_id || "",
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
      const binding = createConnectionBinding(connectionId, data);
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
      if (binding) Object.assign(connection, binding, { token_generation: 1 });
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
      if (status === "revoked") {
        this.deleteConnectionTokenIndexes(connectionId);
        connection.connection_token_hash = "";
      }
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
      connection.token_generation = Number(connection.token_generation || 0) + 1;
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
        // F1: an expired intent never settles — give its reserved cap headroom back.
        this._releaseReservationLocked(intent.intent_id);
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
        // F1: an expired request never settles — give its reserved cap headroom back.
        this._releaseReservationLocked(request.request_id);
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

  // Retention prune: drop terminal payment requests / intents (plus their idempotency
  // back-references and any stray reservation) whose last update is older than ttlMs,
  // and transaction contexts no surviving request/intent still references. This bounds
  // the store so the per-write reload+snapshot cost (and memory) stays small as history
  // accumulates — a terminal record is never read by the hot path again. Runs in ONE
  // mutate() so it is atomic and multi-writer safe, exactly like every other write.
  // Returns the number of pruned records. Intended to be called from the background
  // maintenance loop, NOT the request path.
  pruneTerminal(nowMs = Date.now(), ttlMs = DEFAULT_RETENTION_MS) {
    if (!(ttlMs > 0)) return 0;
    const cutoff = nowMs - ttlMs;
    // Cheap read-only probe: never take the write lock when nothing is prunable.
    if (!this.hasPrunableRecords(cutoff)) return 0;
    return this.mutate(() => {
      let pruned = 0;
      for (const [requestId, request] of Object.entries(this.state.paymentRequests)) {
        if (!this._isPrunable(request, cutoff)) continue;
        delete this.state.paymentRequests[requestId];
        this._deleteIdempotencyPointingTo(this.state.paymentRequestIdempotency, requestId);
        this._releaseReservationLocked(requestId);
        pruned += 1;
      }
      for (const [intentId, intent] of Object.entries(this.state.intents)) {
        if (!this._isPrunable(intent, cutoff)) continue;
        delete this.state.intents[intentId];
        this._deleteIdempotencyPointingTo(this.state.idempotency, intentId);
        this._releaseReservationLocked(intentId);
        pruned += 1;
      }
      // Drop transaction contexts that are old AND unreferenced by any surviving
      // request/intent — never one a live record still points at.
      const referenced = new Set();
      for (const request of Object.values(this.state.paymentRequests)) {
        if (request.transaction_id) referenced.add(request.transaction_id);
      }
      for (const intent of Object.values(this.state.intents)) {
        if (intent.transaction_id) referenced.add(intent.transaction_id);
      }
      for (const [txId, context] of Object.entries(this.state.transactionContexts)) {
        if (referenced.has(txId)) continue;
        if (!this._olderThan(context, cutoff)) continue;
        delete this.state.transactionContexts[txId];
        pruned += 1;
      }
      return pruned;
    });
  }

  // Cheap, read-only probe mirroring pruneTerminal's conditions, so the fast path can
  // skip the write lock when there is nothing to prune.
  hasPrunableRecords(cutoff) {
    for (const request of Object.values(this.state.paymentRequests)) {
      if (this._isPrunable(request, cutoff)) return true;
    }
    for (const intent of Object.values(this.state.intents)) {
      if (this._isPrunable(intent, cutoff)) return true;
    }
    return false;
  }

  _isPrunable(record, cutoff) {
    return !!record
      && TERMINAL_STATUSES.has(String(record.status || ""))
      && this._olderThan(record, cutoff);
  }

  _olderThan(record, cutoff) {
    const ts = Date.parse(record?.updated_at || record?.created_at || "");
    return Number.isFinite(ts) && ts <= cutoff;
  }

  _deleteIdempotencyPointingTo(map, id) {
    if (!map) return;
    for (const [key, value] of Object.entries(map)) {
      if (value === id) delete map[key];
    }
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

  // Daily spend is tracked as an EXACT decimal string, never a float64 Number.
  // Accumulating money with `+` on Numbers (the old code) drifts a little with
  // every payment, so the stored total slowly diverges from the real sum — enough
  // to make the cap inaccurate and let spend slip past it (H3). All arithmetic
  // goes through BigInt minor units in decimal.js.
  //
  // F1 (check-to-record gap): the cap used to be CHECKED at request/intent
  // creation but only RECORDED at on-chain `confirmed`. Between those two moments
  // an unbounded number of payments could each pass the check against the same
  // un-incremented total, then all confirm — blowing the cap under concurrent
  // fan-out. Fix: a reservation ledger. A payment atomically RESERVES its amount
  // against the cap at commit time (reserveDailyLimit); the reservation is
  // RELEASED if it never settles (failed/expired/rejected) and SETTLED into
  // confirmed spend on `confirmed`. The cap is therefore checked against
  // "committed" = confirmed spend PLUS live reservations, so two concurrent
  // payments can never both fit into headroom only one of them has.

  // The daily-cap bucket key. The "day" is the UTC calendar date (toISOString) — the
  // cap resets at 00:00 UTC, not local midnight. Documented for operators in
  // services/platform-api/.env.example next to DAILY_LIMIT_*.
  dayKey(asset, day = new Date().toISOString().slice(0, 10)) {
    return `${day}:${String(asset || "").toUpperCase()}`;
  }

  // Confirmed (settled) spend for `asset` today as a canonical decimal string
  // ("0" when nothing recorded, or a legacy value cannot be parsed).
  dailySpent(asset) {
    return normalizeDecimalString(this.state.dailySpent[this.dayKey(asset)]) ?? "0";
  }

  // Sum of today's LIVE reservations for `asset`, derived from the reservation
  // ledger so it can never drift from the per-payment records. Exact decimals.
  dailyReserved(asset) {
    return this._reservedTotalLocked(new Date().toISOString().slice(0, 10), String(asset || "").toUpperCase());
  }

  // What the daily cap is actually checked against: confirmed spend + everything
  // currently reserved (in-flight) for today. Exact decimal string.
  dailyCommitted(asset) {
    return addDecimalStrings(this.dailySpent(asset), this.dailyReserved(asset));
  }

  // Record confirmed spend with no reservation involved. The low-level primitive;
  // settleDailyReservation falls back to it for payments that were never reserved
  // (legacy data, or a device that confirmed an already-blocked payment).
  addDailySpent(asset, amount) {
    // Validate before locking: a bad amount must never poison the cap, and we
    // must not take a write lock for a no-op.
    const addend = normalizeDecimalString(amount);
    if (addend === null) return; // never poison the cap with a bad amount
    this.mutate(() => this._addSpentLocked(asset, addend));
  }

  // --- locked helpers: mutate this.state directly. The caller already holds the
  // write lock, so these compose inside mutate() and inside expireStale. ---

  _addSpentLocked(asset, addend) {
    const key = this.dayKey(asset);
    // Read INSIDE the lock so concurrent writers accumulate exactly instead of
    // clobbering each other (H4). `?? "0"` still tolerates a legacy float total.
    const before = normalizeDecimalString(this.state.dailySpent[key]) ?? "0";
    this.state.dailySpent[key] = addDecimalStrings(before, addend);
  }

  _reservedTotalLocked(day, symbol) {
    let total = "0";
    for (const reservation of Object.values(this.state.reservations || {})) {
      if (reservation && reservation.state === "held" && reservation.day === day && reservation.asset === symbol) {
        total = addDecimalStrings(total, reservation.amount);
      }
    }
    return total;
  }

  _releaseReservationLocked(id) {
    const reservation = id ? this.state.reservations[id] : null;
    if (!reservation || reservation.state !== "held") return false;
    delete this.state.reservations[id];
    return true;
  }

  // Atomically reserve `amount` of `asset` against today's cap for payment `id`.
  // Returns { ok, reason?, duplicate? }. Fails CLOSED on a bad amount/limit and
  // when confirmed+reserved+amount would exceed the cap — WITHOUT recording, so a
  // rejected reservation never consumes headroom. The check and the record happen
  // in ONE lock, which is what actually closes the concurrent-bypass window:
  // among N racing reservations, only those that still fit are recorded.
  // Idempotent per id: a second reserve for an already-held id is a no-op success
  // (tolerates a create retried with the same payment id).
  reserveDailyLimit(id, asset, amount, limit) {
    const addend = normalizeDecimalString(amount);
    const cap = normalizeDecimalString(limit);
    if (!id || addend === null || cap === null) return { ok: false, reason: "invalid_input" };
    const symbol = String(asset || "").toUpperCase();
    if (!symbol) return { ok: false, reason: "invalid_asset" };
    return this.mutate(() => {
      const existing = this.state.reservations[id];
      if (existing && existing.state === "held") return { ok: true, duplicate: true };
      const day = new Date().toISOString().slice(0, 10);
      const spent = normalizeDecimalString(this.state.dailySpent[this.dayKey(asset, day)]) ?? "0";
      const committed = addDecimalStrings(spent, this._reservedTotalLocked(day, symbol));
      const next = addDecimalStrings(committed, addend);
      if (compareDecimalStrings(next, cap) > 0) return { ok: false, reason: "over_limit" };
      this.state.reservations[id] = { asset: symbol, amount: addend, day, state: "held" };
      return { ok: true, reserved: addend };
    });
  }

  // Release a held reservation (the payment failed / expired / was rejected before
  // it settled). Idempotent: releasing an unknown or already-resolved id is a no-op.
  releaseDailyReservation(id) {
    if (!id) return false;
    return this.mutate(() => this._releaseReservationLocked(id));
  }

  // Settle a payment's spend on `confirmed`: move its held reservation into the
  // confirmed bucket so the cap total is conserved across the transition (no
  // flicker where it briefly counts neither). If the payment was never reserved
  // (legacy data, or a device that confirmed an already-blocked payment), fall
  // back to recording the spend directly so confirmed money is always accounted.
  settleDailyReservation(id, asset, amount) {
    return this.mutate(() => {
      const reservation = id ? this.state.reservations[id] : null;
      if (reservation && reservation.state === "held") {
        const key = this.dayKey(reservation.asset, reservation.day);
        const before = normalizeDecimalString(this.state.dailySpent[key]) ?? "0";
        this.state.dailySpent[key] = addDecimalStrings(before, reservation.amount);
        delete this.state.reservations[id];
        return true;
      }
      const addend = normalizeDecimalString(amount);
      if (addend === null) return false;
      this._addSpentLocked(asset, addend);
      return true;
    });
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

  paymentRequestEventsForDevice(deviceId, seq = 0) {
    return this.eventsSince(seq).filter((event) => {
      if (!String(event.type || "").startsWith("payment_request.")) return false;
      if (event.data?.target_app_device_id) return event.data.target_app_device_id === deviceId;
      const requestId = event.data?.request_id || event.request_id || event.intent_id;
      const request = requestId ? this.paymentRequest(requestId) : null;
      return request?.target_app_device_id === deviceId;
    });
  }

  eventWindow(seq = 0) {
    const since = Number.isSafeInteger(Number(seq)) && Number(seq) >= 0 ? Number(seq) : 0;
    const latest = Number(this.state.eventSeq) || 0;
    const oldest = this.state.events.length ? Number(this.state.events[0].seq) || 0 : latest;
    return {
      latest_seq: latest,
      oldest_retained_seq: oldest,
      reset_required: since > 0 && this.state.events.length > 0 && since < oldest - 1
    };
  }
}
