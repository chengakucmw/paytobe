import express from "express";

import { roleAllows } from "../application/merchant-memberships/service.js";
import { sanitizeAuditPayload } from "../observability.js";

export function createMerchantAuditRouter(deps) {
  const { store, verifyMerchantSession, sendApiError } = deps;
  const router = express.Router();

  router.get("/events", (req, res) => {
    const auth = verifyMerchantSession(req);
    if (!auth.ok) return sendApiError(res, auth.status, auth.code, auth.message);
    if (!roleAllows(auth.auth_context.role, "audit.read")) {
      return sendApiError(res, 403, "forbidden", "Merchant role is not permitted");
    }
    if (!store.db) return res.json({ ok: true, items: [], next_cursor: "" });
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 200));
    const decodedCursor = decodeCursor(String(req.query.cursor || ""));
    const cursor = decodedCursor[0] && decodedCursor[1] ? String(req.query.cursor || "") : "";
    const rows = store.db.prepare(`SELECT audit_event_id, actor_type, actor_id, action, resource_type, resource_id,
        result, request_id, details_json, occurred_at FROM audit_events
      WHERE merchant_id = ? AND (? = '' OR occurred_at < ? OR (occurred_at = ? AND audit_event_id < ?))
      ORDER BY occurred_at DESC, audit_event_id DESC LIMIT ?`)
      .all(auth.auth_context.merchant_id, cursor, decodedCursor[0], decodedCursor[0], decodedCursor[1], limit + 1);
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map(publicAuditEvent);
    return res.json({ ok: true, items, next_cursor: more ? encodeCursor(rows[limit - 1]) : "" });
  });

  return router;
}

function publicAuditEvent(row) {
  let details = {};
  try { details = JSON.parse(row.details_json || "{}"); } catch { /* malformed legacy detail is omitted */ }
  return {
    audit_event_id: row.audit_event_id,
    actor: { type: row.actor_type, id: row.actor_id },
    action: row.action,
    resource: { type: row.resource_type, id: row.resource_id },
    result: row.result,
    request_id: row.request_id,
    details: sanitizeAuditPayload(details),
    occurred_at: row.occurred_at
  };
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify([row.occurred_at, row.audit_event_id])).toString("base64url");
}
function decodeCursor(value) {
  if (!value) return ["", ""];
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return Array.isArray(parsed) && parsed.length === 2 ? parsed.map(String) : ["", ""];
  } catch { return ["", ""]; }
}
