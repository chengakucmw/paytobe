// Runtime metric refresh + pairing-expiry audit.
//
// Needs the store, observability handle and the WS hub (for live socket
// counts), so it's produced by a factory wired once at startup.

export function createMetrics({ store, observability, wsHub }) {
  function refreshRuntimeMetrics() {
    const storage = store.info();
    observability.setGauge("Paytobe_store_info", {
      driver: storage.driver,
      schema_version: storage.schema_version || "none"
    }, 1);
    observability.setGauge("Paytobe_websocket_connections", { role: "app" }, wsHub.countOpenSockets(wsHub.appSockets));
    observability.setGauge("Paytobe_websocket_connections", { role: "agent" }, wsHub.countOpenSockets(wsHub.openclawSockets));
  }

  function recordPairingExpired(session, options = {}) {
    observability.recordAuditEvent("pairing_session.expired", "failure", {
      actor: { type: "wallet_device", id: options.actorDeviceId || "" },
      resource: { type: "pairing_session", id: session.pairing_session_id },
      labels: { status: "expired" },
      details: {
        agent_id: session.agent_identity?.agent_id || "",
        expires_at: session.expires_at || null
      }
    });
    observability.incrementCounter("Paytobe_pairing_sessions_total", { result: "expired" });
  }

  return { refreshRuntimeMetrics, recordPairingExpired };
}
