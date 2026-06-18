import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

const DEFAULT_AUDIT_RETENTION = 500;
const MAX_AUDIT_LIMIT = 200;
const SENSITIVE_KEY_PATTERN = /(authorization|token|secret|signature|password|private|seed|rawbody|raw_body|connection_token|pairing_code)/i;
const VALUE_FINGERPRINT_KEY_PATTERN = /(^to$|address|recipient|tx_hash|transaction_hash|hash$)/i;
const VALUE_REDACT_KEY_PATTERN = /(^amount$|total|fee|price|cost)/i;

export function createObservability(options = {}) {
  const service = options.service || "velarumpay-platform-api";
  const environment = options.environment || process.env.NODE_ENV || "development";
  const startedAt = Date.now();
  const auditRetention = normalizeRetention(options.auditRetention ?? process.env.AUDIT_EVENT_RETENTION);
  const logAuditToStdout = options.logAuditToStdout ?? process.env.AUDIT_LOG_STDOUT !== "false";
  const metrics = new MetricRegistry();
  const auditEvents = [];
  let nextAuditSeq = 1;

  function recordAuditEvent(action, outcome = "success", payload = {}) {
    const event = {
      seq: nextAuditSeq,
      at: new Date().toISOString(),
      service,
      environment,
      action: String(action || "unknown"),
      outcome: String(outcome || "unknown"),
      actor: sanitizeAuditPayload(payload.actor || {}),
      resource: sanitizeAuditPayload(payload.resource || {}),
      labels: sanitizeLabels(payload.labels || {}),
      details: sanitizeAuditPayload(payload.details || {})
    };
    nextAuditSeq += 1;
    auditEvents.push(event);
    while (auditEvents.length > auditRetention) auditEvents.shift();
    incrementCounter("velarumpay_audit_events_total", {
      action: event.action,
      outcome: event.outcome
    });
    if (logAuditToStdout) {
      const level = event.outcome === "success" ? "info" : "warn";
      console.log(JSON.stringify({ level, type: "audit", ...event }));
    }
    return event;
  }

  function httpMiddleware() {
    return (req, res, next) => {
      const requestId = requestIdFrom(req) || randomUUID();
      const started = process.hrtime.bigint();
      req.request_id = requestId;
      res.setHeader("x-request-id", requestId);

      res.on("finish", () => {
        const route = routeLabel(req);
        const status = Number(res.statusCode || 0);
        const durationSeconds = Number(process.hrtime.bigint() - started) / 1e9;
        incrementCounter("velarumpay_http_requests_total", {
          method: req.method,
          route,
          status: String(status),
          status_class: `${Math.floor(status / 100)}xx`
        });
        observeSummary("velarumpay_http_request_duration_seconds", {
          method: req.method,
          route
        }, durationSeconds);

        if (res.locals?.api_error) {
          const error = res.locals.api_error;
          incrementCounter("velarumpay_api_errors_total", {
            code: error.code || "unknown",
            status: String(error.status || status || 0),
            route
          });
          recordAuditEvent("api.error", "failure", {
            actor: { type: "http_client" },
            resource: { type: "http_route", id: route },
            labels: {
              code: error.code || "unknown",
              status: String(error.status || status || 0)
            },
            details: {
              request_id: requestId,
              method: req.method,
              field: error.field || null
            }
          });
        }
      });

      next();
    };
  }

  function markApiError(res, error) {
    res.locals.api_error = sanitizeAuditPayload(error || {});
  }

  function auditEventCount() {
    return auditEvents.length;
  }

  function listAuditEvents(options = {}) {
    const since = Number(options.since || 0);
    const limit = clamp(Number(options.limit || 100), 1, MAX_AUDIT_LIMIT);
    let items = auditEvents.filter((event) => event.seq > since);
    if (options.action) items = items.filter((event) => event.action === options.action);
    if (options.outcome) items = items.filter((event) => event.outcome === options.outcome);
    if (options.resource_type) {
      items = items.filter((event) => event.resource?.type === options.resource_type);
    }
    items = items.slice(-limit);
    return {
      items,
      next_since: items.length ? items[items.length - 1].seq : since
    };
  }

  function incrementCounter(name, labels = {}, amount = 1) {
    metrics.incrementCounter(name, sanitizeLabels(labels), amount);
  }

  function setGauge(name, labels = {}, value = 0) {
    metrics.setGauge(name, sanitizeLabels(labels), value);
  }

  function observeSummary(name, labels = {}, value = 0) {
    metrics.observeSummary(name, sanitizeLabels(labels), value);
  }

  function prometheusText() {
    setGauge("velarumpay_audit_buffer_events", {}, auditEvents.length);
    setGauge("velarumpay_process_uptime_seconds", {}, (Date.now() - startedAt) / 1000);
    return metrics.toPrometheus();
  }

  function authorizeMetricsRequest(req) {
    const expected = process.env.METRICS_TOKEN || process.env.OBSERVABILITY_TOKEN || "";
    if (!expected) return { ok: true };
    return authorizeBearer(req, expected, "metrics");
  }

  function authorizeAuditRequest(req) {
    const expected = process.env.AUDIT_LOG_READ_TOKEN || process.env.OBSERVABILITY_TOKEN || "";
    if (!expected) {
      return {
        ok: false,
        status: 403,
        code: "audit_log_token_required",
        message: "AUDIT_LOG_READ_TOKEN or OBSERVABILITY_TOKEN is required before reading audit events"
      };
    }
    return authorizeBearer(req, expected, "audit_log");
  }

  return {
    auditEventCount,
    authorizeAuditRequest,
    authorizeMetricsRequest,
    httpMiddleware,
    incrementCounter,
    listAuditEvents,
    markApiError,
    observeSummary,
    prometheusText,
    recordAuditEvent,
    setGauge
  };
}

export function sanitizeAuditPayload(value, depth = 0, key = "") {
  if (depth > 6) return "[TRUNCATED]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeAuditPayload(item, depth + 1, key));
  }
  if (typeof value === "object") {
    const output = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(entryKey)) {
        output[entryKey] = "[REDACTED]";
      } else if (VALUE_REDACT_KEY_PATTERN.test(entryKey)) {
        output[entryKey] = "[REDACTED_VALUE]";
      } else if (VALUE_FINGERPRINT_KEY_PATTERN.test(entryKey)) {
        output[entryKey] = fingerprint(entryValue);
      } else {
        output[entryKey] = sanitizeAuditPayload(entryValue, depth + 1, entryKey);
      }
    }
    return output;
  }
  if (VALUE_REDACT_KEY_PATTERN.test(key)) return "[REDACTED_VALUE]";
  if (VALUE_FINGERPRINT_KEY_PATTERN.test(key)) return fingerprint(value);
  if (typeof value === "string" && value.length > 256) return `${value.slice(0, 253)}...`;
  return value;
}

function requestIdFrom(req) {
  return String(req.get?.("x-request-id") || "").trim();
}

function routeLabel(req) {
  if (req.route?.path) return `${req.baseUrl || ""}${req.route.path}`;
  return req.path || "unmatched";
}

function sanitizeLabels(labels) {
  const output = {};
  for (const [rawKey, rawValue] of Object.entries(labels || {})) {
    const key = String(rawKey).replace(/[^a-zA-Z0-9_]/g, "_");
    if (!key) continue;
    output[key] = String(rawValue ?? "none").slice(0, 120);
  }
  return output;
}

function normalizeRetention(value) {
  const retention = Number(value || DEFAULT_AUDIT_RETENTION);
  if (!Number.isFinite(retention) || retention < 1) return DEFAULT_AUDIT_RETENTION;
  return Math.min(Math.floor(retention), 5000);
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function fingerprint(value) {
  if (value === null || value === undefined || value === "") return value;
  const text = String(value);
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
  return `sha256:${digest}`;
}

function authorizeBearer(req, expected, scope) {
  const supplied = bearerFromRequest(req);
  if (!supplied || !safeEqual(supplied, expected)) {
    return {
      ok: false,
      status: 401,
      code: "observability_unauthorized",
      message: `${scope} token is invalid or missing`
    };
  }
  return { ok: true };
}

function bearerFromRequest(req) {
  const authorization = String(req.get?.("authorization") || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return String(req.get?.("x-observability-token") || req.query?.observability_token || "").trim();
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

class MetricRegistry {
  constructor() {
    this.counters = new Map();
    this.gauges = new Map();
    this.summaries = new Map();
  }

  incrementCounter(name, labels, amount) {
    const entry = this.entry(this.counters, name, labels);
    entry.value += Number(amount || 0);
  }

  setGauge(name, labels, value) {
    const entry = this.entry(this.gauges, name, labels);
    entry.value = Number(value || 0);
  }

  observeSummary(name, labels, value) {
    const entry = this.entry(this.summaries, name, labels);
    entry.count += 1;
    entry.sum += Number(value || 0);
  }

  entry(registry, name, labels) {
    if (!registry.has(name)) registry.set(name, new Map());
    const bucket = registry.get(name);
    const key = stableLabelKey(labels);
    if (!bucket.has(key)) bucket.set(key, { labels, value: 0, count: 0, sum: 0 });
    return bucket.get(key);
  }

  toPrometheus() {
    const lines = [];
    for (const [name, bucket] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const entry of bucket.values()) lines.push(renderMetric(name, entry.labels, entry.value));
    }
    for (const [name, bucket] of this.gauges) {
      lines.push(`# TYPE ${name} gauge`);
      for (const entry of bucket.values()) lines.push(renderMetric(name, entry.labels, entry.value));
    }
    for (const [name, bucket] of this.summaries) {
      lines.push(`# TYPE ${name} summary`);
      for (const entry of bucket.values()) {
        lines.push(renderMetric(`${name}_count`, entry.labels, entry.count));
        lines.push(renderMetric(`${name}_sum`, entry.labels, entry.sum));
      }
    }
    return `${lines.join("\n")}\n`;
  }
}

function stableLabelKey(labels) {
  return JSON.stringify(Object.keys(labels).sort().map((key) => [key, labels[key]]));
}

function renderMetric(name, labels, value) {
  const labelEntries = Object.entries(labels || {});
  const labelText = labelEntries.length
    ? `{${labelEntries.map(([key, labelValue]) => `${key}="${escapeLabel(labelValue)}"`).join(",")}}`
    : "";
  return `${name}${labelText} ${formatNumber(value)}`;
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return String(number);
}
