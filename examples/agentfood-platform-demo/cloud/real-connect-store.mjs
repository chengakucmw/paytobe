const CONNECT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS agentfood_app_devices (
    device_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agentfood_connect_invitations (
    connect_invitation_id TEXT PRIMARY KEY,
    connect_key_hash TEXT NOT NULL UNIQUE,
    claim_token_hash TEXT UNIQUE,
    target_app_device_id TEXT NOT NULL,
    status TEXT NOT NULL,
    agent_identity_json TEXT,
    identity_assurance TEXT,
    requested_scopes_json TEXT NOT NULL DEFAULT '[]',
    pairing_session_id TEXT UNIQUE,
    connection_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    claimed_at TEXT,
    approved_at TEXT,
    connected_at TEXT,
    rejected_at TEXT,
    cancelled_at TEXT,
    expired_at TEXT,
    expires_at TEXT NOT NULL,
    exchange_count INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS agentfood_connect_invitations_device_idx ON agentfood_connect_invitations(target_app_device_id, created_at DESC)",
  `CREATE TABLE IF NOT EXISTS agentfood_connections (
    connection_id TEXT PRIMARY KEY,
    connection_token_hash TEXT UNIQUE,
    target_app_device_id TEXT NOT NULL,
    pairing_session_id TEXT NOT NULL,
    agent_identity_json TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agentfood_transaction_contexts (
    transaction_id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agentfood_payment_requests (
    request_id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    target_app_device_id TEXT NOT NULL,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS agentfood_payment_requests_device_idx ON agentfood_payment_requests(target_app_device_id, created_at DESC)"
];

let d1SchemaReady = false;

async function ensureConnectSchema(db) {
  if (d1SchemaReady) return;
  await db.batch(CONNECT_SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)));
  d1SchemaReady = true;
}

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function invitationFromRow(row) {
  if (!row) return null;
  return {
    connect_invitation_id: row.connect_invitation_id,
    connect_key_hash: row.connect_key_hash,
    claim_token_hash: row.claim_token_hash || "",
    target_app_device_id: row.target_app_device_id,
    status: row.status,
    agent_identity: parseJson(row.agent_identity_json, null),
    identity_assurance: row.identity_assurance || null,
    requested_scopes: parseJson(row.requested_scopes_json, []),
    pairing_session_id: row.pairing_session_id || "",
    connection_id: row.connection_id || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
    claimed_at: row.claimed_at || null,
    approved_at: row.approved_at || null,
    connected_at: row.connected_at || null,
    rejected_at: row.rejected_at || null,
    cancelled_at: row.cancelled_at || null,
    expired_at: row.expired_at || null,
    expires_at: row.expires_at,
    exchange_count: Number(row.exchange_count || 0)
  };
}

function connectionFromRow(row) {
  if (!row) return null;
  return {
    connection_id: row.connection_id,
    connection_token_hash: row.connection_token_hash || "",
    target_app_device_id: row.target_app_device_id,
    pairing_session_id: row.pairing_session_id,
    agent_identity: parseJson(row.agent_identity_json, {}),
    scopes: parseJson(row.scopes_json, []),
    approved_scopes: parseJson(row.scopes_json, []),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_activity_at: row.updated_at,
    expires_at: row.expires_at
  };
}

class D1ConnectStore {
  constructor(db) { this.db = db; }

  async ready() { await ensureConnectSchema(this.db); }

  async registerDevice(deviceId, tokenHash, at) {
    await this.ready();
    const existing = await this.db.prepare("SELECT * FROM agentfood_app_devices WHERE device_id = ?").bind(deviceId).first();
    if (existing) {
      if (existing.token_hash !== tokenHash) return { conflict: true };
      await this.db.prepare("UPDATE agentfood_app_devices SET last_seen_at = ? WHERE device_id = ?").bind(at, deviceId).run();
      return { device_id: deviceId, registered_at: existing.registered_at, last_seen_at: at };
    }
    await this.db.prepare("INSERT INTO agentfood_app_devices (device_id, token_hash, registered_at, last_seen_at) VALUES (?, ?, ?, ?)")
      .bind(deviceId, tokenHash, at, at).run();
    return { device_id: deviceId, registered_at: at, last_seen_at: at };
  }

  async verifyDevice(deviceId, tokenHash) {
    await this.ready();
    const row = await this.db.prepare("SELECT token_hash FROM agentfood_app_devices WHERE device_id = ?").bind(deviceId).first();
    return Boolean(row && row.token_hash === tokenHash);
  }

  async createInvitation(value) {
    await this.ready();
    await this.db.prepare(`INSERT INTO agentfood_connect_invitations (
      connect_invitation_id, connect_key_hash, target_app_device_id, status,
      requested_scopes_json, created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, 'waiting', '[]', ?, ?, ?)`)
      .bind(value.connect_invitation_id, value.connect_key_hash, value.target_app_device_id, value.created_at, value.updated_at, value.expires_at).run();
    return this.invitationById(value.connect_invitation_id);
  }

  async invitationById(id) {
    await this.ready();
    return invitationFromRow(await this.db.prepare("SELECT * FROM agentfood_connect_invitations WHERE connect_invitation_id = ?").bind(id).first());
  }

  async invitationByClaimHash(hash) {
    await this.ready();
    return invitationFromRow(await this.db.prepare("SELECT * FROM agentfood_connect_invitations WHERE claim_token_hash = ?").bind(hash).first());
  }

  async invitationByPairingId(id) {
    await this.ready();
    return invitationFromRow(await this.db.prepare("SELECT * FROM agentfood_connect_invitations WHERE pairing_session_id = ?").bind(id).first());
  }

  async expireInvitation(invitation, at) {
    if (!invitation || !["waiting", "claimed"].includes(invitation.status) || invitation.expires_at > at) return invitation;
    await this.db.prepare("UPDATE agentfood_connect_invitations SET status = 'expired', expired_at = ?, updated_at = ? WHERE connect_invitation_id = ? AND status IN ('waiting','claimed')")
      .bind(at, at, invitation.connect_invitation_id).run();
    return this.invitationById(invitation.connect_invitation_id);
  }

  async claimInvitation(keyHash, claimHash, agent, scopes, pairingId, at) {
    await this.ready();
    const result = await this.db.prepare(`UPDATE agentfood_connect_invitations
      SET status = 'claimed', claim_token_hash = ?, agent_identity_json = ?, identity_assurance = 'unverified',
          requested_scopes_json = ?, pairing_session_id = ?, claimed_at = ?, updated_at = ?
      WHERE connect_key_hash = ? AND status = 'waiting' AND expires_at > ?`)
      .bind(claimHash, JSON.stringify(agent), JSON.stringify(scopes), pairingId, at, at, keyHash, at).run();
    if (Number(result.meta?.changes || 0) !== 1) return null;
    return invitationFromRow(await this.db.prepare("SELECT * FROM agentfood_connect_invitations WHERE connect_key_hash = ?").bind(keyHash).first());
  }

  async cancelInvitation(id, deviceId, at) {
    await this.ready();
    const result = await this.db.prepare(`UPDATE agentfood_connect_invitations
      SET status = 'cancelled', cancelled_at = ?, updated_at = ?
      WHERE connect_invitation_id = ? AND target_app_device_id = ? AND status IN ('waiting','claimed')`)
      .bind(at, at, id, deviceId).run();
    return Number(result.meta?.changes || 0) === 1 ? this.invitationById(id) : null;
  }

  async approveInvitation(invitation, scopes, connectionId, at, expiresAt) {
    await this.ready();
    const connection = {
      connection_id: connectionId,
      target_app_device_id: invitation.target_app_device_id,
      pairing_session_id: invitation.pairing_session_id,
      agent_identity: invitation.agent_identity,
      scopes,
      status: "active",
      created_at: at,
      updated_at: at,
      expires_at: expiresAt
    };
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO agentfood_connections (
        connection_id, target_app_device_id, pairing_session_id, agent_identity_json,
        scopes_json, status, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
        .bind(connectionId, invitation.target_app_device_id, invitation.pairing_session_id, JSON.stringify(invitation.agent_identity), JSON.stringify(scopes), at, at, expiresAt),
      this.db.prepare(`UPDATE agentfood_connect_invitations
        SET status = 'approved', connection_id = ?, approved_at = ?, updated_at = ?
        WHERE connect_invitation_id = ? AND status = 'claimed'`)
        .bind(connectionId, at, at, invitation.connect_invitation_id)
    ]);
    if (Number(results[1]?.meta?.changes || 0) !== 1) return null;
    return { invitation: await this.invitationById(invitation.connect_invitation_id), connection };
  }

  async rejectInvitation(invitation, at) {
    const result = await this.db.prepare(`UPDATE agentfood_connect_invitations
      SET status = 'rejected', rejected_at = ?, updated_at = ?
      WHERE connect_invitation_id = ? AND status = 'claimed'`)
      .bind(at, at, invitation.connect_invitation_id).run();
    return Number(result.meta?.changes || 0) === 1 ? this.invitationById(invitation.connect_invitation_id) : null;
  }

  async exchangeInvitation(invitation, connectionTokenHash, at) {
    await this.ready();
    const results = await this.db.batch([
      this.db.prepare("UPDATE agentfood_connections SET connection_token_hash = ?, updated_at = ? WHERE connection_id = ? AND status = 'active'")
        .bind(connectionTokenHash, at, invitation.connection_id),
      this.db.prepare(`UPDATE agentfood_connect_invitations
        SET status = 'connected', connected_at = COALESCE(connected_at, ?), updated_at = ?, exchange_count = exchange_count + 1
        WHERE connect_invitation_id = ? AND status IN ('approved','connected')`)
        .bind(at, at, invitation.connect_invitation_id)
    ]);
    if (Number(results[0]?.meta?.changes || 0) !== 1 || Number(results[1]?.meta?.changes || 0) !== 1) return null;
    return {
      invitation: await this.invitationById(invitation.connect_invitation_id),
      connection: connectionFromRow(await this.db.prepare("SELECT * FROM agentfood_connections WHERE connection_id = ?").bind(invitation.connection_id).first())
    };
  }

  async connectionByTokenHash(hash) {
    await this.ready();
    return connectionFromRow(await this.db.prepare("SELECT * FROM agentfood_connections WHERE connection_token_hash = ?").bind(hash).first());
  }

  async listConnections(deviceId) {
    await this.ready();
    const result = await this.db.prepare("SELECT * FROM agentfood_connections WHERE target_app_device_id = ? ORDER BY created_at DESC").bind(deviceId).all();
    return (result.results || []).map(connectionFromRow);
  }

  async updateConnection(id, deviceId, status, at) {
    await this.ready();
    const result = await this.db.prepare("UPDATE agentfood_connections SET status = ?, updated_at = ? WHERE connection_id = ? AND target_app_device_id = ?")
      .bind(status, at, id, deviceId).run();
    if (Number(result.meta?.changes || 0) !== 1) return null;
    return connectionFromRow(await this.db.prepare("SELECT * FROM agentfood_connections WHERE connection_id = ?").bind(id).first());
  }

  async upsertContext(connectionId, payload, at) {
    await this.ready();
    await this.db.prepare(`INSERT INTO agentfood_transaction_contexts (transaction_id, connection_id, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(transaction_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`)
      .bind(payload.transaction_id, connectionId, JSON.stringify(payload), at, at).run();
    return payload;
  }

  async createPayment(connection, payload, at) {
    await this.ready();
    const existing = await this.db.prepare("SELECT payload_json FROM agentfood_payment_requests WHERE request_id = ?").bind(payload.request_id).first();
    if (existing) return parseJson(existing.payload_json, payload);
    await this.db.prepare(`INSERT INTO agentfood_payment_requests
      (request_id, connection_id, target_app_device_id, status, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(payload.request_id, connection.connection_id, connection.target_app_device_id, payload.status, JSON.stringify(payload), at, at).run();
    return payload;
  }

  async listPayments(deviceId) {
    await this.ready();
    const result = await this.db.prepare("SELECT payload_json FROM agentfood_payment_requests WHERE target_app_device_id = ? ORDER BY created_at DESC").bind(deviceId).all();
    return (result.results || []).map((row) => parseJson(row.payload_json, {}));
  }

  async paymentById(id) {
    await this.ready();
    const row = await this.db.prepare("SELECT * FROM agentfood_payment_requests WHERE request_id = ?").bind(id).first();
    return row ? { ...row, payload: parseJson(row.payload_json, {}) } : null;
  }

  async updatePayment(id, deviceId, status, patch, at) {
    const current = await this.paymentById(id);
    if (!current || current.target_app_device_id !== deviceId) return null;
    const payload = { ...current.payload, status, updated_at: at, ...patch };
    await this.db.prepare("UPDATE agentfood_payment_requests SET status = ?, payload_json = ?, updated_at = ? WHERE request_id = ? AND target_app_device_id = ?")
      .bind(status, JSON.stringify(payload), at, id, deviceId).run();
    return payload;
  }
}

class MemoryConnectStore {
  constructor() {
    this.devices = new Map();
    this.invitations = new Map();
    this.connections = new Map();
    this.contexts = new Map();
    this.payments = new Map();
  }

  async registerDevice(deviceId, tokenHash, at) {
    const existing = this.devices.get(deviceId);
    if (existing && existing.token_hash !== tokenHash) return { conflict: true };
    const device = existing || { device_id: deviceId, token_hash: tokenHash, registered_at: at };
    device.last_seen_at = at;
    this.devices.set(deviceId, device);
    return { device_id: deviceId, registered_at: device.registered_at, last_seen_at: at };
  }

  async verifyDevice(deviceId, tokenHash) { return this.devices.get(deviceId)?.token_hash === tokenHash; }

  async createInvitation(value) { this.invitations.set(value.connect_invitation_id, { ...value, status: "waiting", requested_scopes: [], exchange_count: 0 }); return { ...this.invitations.get(value.connect_invitation_id) }; }
  async invitationById(id) { const value = this.invitations.get(id); return value ? structuredClone(value) : null; }
  async invitationByClaimHash(hash) { return [...this.invitations.values()].find((item) => item.claim_token_hash === hash) || null; }
  async invitationByPairingId(id) { return [...this.invitations.values()].find((item) => item.pairing_session_id === id) || null; }

  async expireInvitation(invitation, at) {
    if (invitation && ["waiting", "claimed"].includes(invitation.status) && invitation.expires_at <= at) {
      Object.assign(this.invitations.get(invitation.connect_invitation_id), { status: "expired", expired_at: at, updated_at: at });
      return this.invitationById(invitation.connect_invitation_id);
    }
    return invitation;
  }

  async claimInvitation(keyHash, claimHash, agent, scopes, pairingId, at) {
    const invitation = [...this.invitations.values()].find((item) => item.connect_key_hash === keyHash);
    if (!invitation || invitation.status !== "waiting" || invitation.expires_at <= at) return null;
    Object.assign(invitation, { status: "claimed", claim_token_hash: claimHash, agent_identity: agent, identity_assurance: "unverified", requested_scopes: scopes, pairing_session_id: pairingId, claimed_at: at, updated_at: at });
    return structuredClone(invitation);
  }

  async cancelInvitation(id, deviceId, at) {
    const invitation = this.invitations.get(id);
    if (!invitation || invitation.target_app_device_id !== deviceId || !["waiting", "claimed"].includes(invitation.status)) return null;
    Object.assign(invitation, { status: "cancelled", cancelled_at: at, updated_at: at });
    return structuredClone(invitation);
  }

  async approveInvitation(invitation, scopes, connectionId, at, expiresAt) {
    const stored = this.invitations.get(invitation.connect_invitation_id);
    if (!stored || stored.status !== "claimed") return null;
    const connection = { connection_id: connectionId, target_app_device_id: invitation.target_app_device_id, pairing_session_id: invitation.pairing_session_id, agent_identity: invitation.agent_identity, scopes, approved_scopes: scopes, status: "active", created_at: at, updated_at: at, last_activity_at: at, expires_at: expiresAt };
    this.connections.set(connectionId, connection);
    Object.assign(stored, { status: "approved", connection_id: connectionId, approved_at: at, updated_at: at });
    return { invitation: structuredClone(stored), connection: structuredClone(connection) };
  }

  async rejectInvitation(invitation, at) {
    const stored = this.invitations.get(invitation.connect_invitation_id);
    if (!stored || stored.status !== "claimed") return null;
    Object.assign(stored, { status: "rejected", rejected_at: at, updated_at: at });
    return structuredClone(stored);
  }

  async exchangeInvitation(invitation, connectionTokenHash, at) {
    const stored = this.invitations.get(invitation.connect_invitation_id);
    const connection = this.connections.get(invitation.connection_id);
    if (!stored || !connection || !["approved", "connected"].includes(stored.status) || connection.status !== "active") return null;
    connection.connection_token_hash = connectionTokenHash;
    connection.updated_at = at;
    Object.assign(stored, { status: "connected", connected_at: stored.connected_at || at, updated_at: at, exchange_count: Number(stored.exchange_count || 0) + 1 });
    return { invitation: structuredClone(stored), connection: structuredClone(connection) };
  }

  async connectionByTokenHash(hash) { const value = [...this.connections.values()].find((item) => item.connection_token_hash === hash); return value ? structuredClone(value) : null; }
  async listConnections(deviceId) { return [...this.connections.values()].filter((item) => item.target_app_device_id === deviceId).map((item) => structuredClone(item)); }
  async updateConnection(id, deviceId, status, at) { const value = this.connections.get(id); if (!value || value.target_app_device_id !== deviceId) return null; value.status = status; value.updated_at = at; if (status === "revoked") value.connection_token_hash = ""; return structuredClone(value); }
  async upsertContext(connectionId, payload, at) { this.contexts.set(payload.transaction_id, { connectionId, payload: structuredClone(payload), updatedAt: at }); return payload; }
  async createPayment(connection, payload) { if (!this.payments.has(payload.request_id)) this.payments.set(payload.request_id, { connection_id: connection.connection_id, target_app_device_id: connection.target_app_device_id, payload: structuredClone(payload) }); return structuredClone(this.payments.get(payload.request_id).payload); }
  async listPayments(deviceId) { return [...this.payments.values()].filter((item) => item.target_app_device_id === deviceId).map((item) => structuredClone(item.payload)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))); }
  async paymentById(id) { const value = this.payments.get(id); return value ? { ...structuredClone(value), request_id: id } : null; }
  async updatePayment(id, deviceId, status, patch, at) { const value = this.payments.get(id); if (!value || value.target_app_device_id !== deviceId) return null; value.payload = { ...value.payload, status, updated_at: at, ...patch }; return structuredClone(value.payload); }
}

const memoryConnectStore = new MemoryConnectStore();

function realConnectStore(env) {
  return env?.DB ? new D1ConnectStore(env.DB) : memoryConnectStore;
}
