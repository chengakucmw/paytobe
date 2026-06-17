package ai.agentwallet.hd;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

final class AgentConnection {
    final String connectionId;
    final String connectionToken;
    final String pairingSessionId;
    final String agentId;
    final String agentName;
    final String runtime;
    final String deviceLabel;
    final String source;
    final String status;
    final String createdAt;
    final String updatedAt;
    final String lastActivityAt;
    final String expiresAt;
    final List<String> scopes;

    private AgentConnection(
            String connectionId,
            String connectionToken,
            String pairingSessionId,
            String agentId,
            String agentName,
            String runtime,
            String deviceLabel,
            String source,
            String status,
            String createdAt,
            String updatedAt,
            String lastActivityAt,
            String expiresAt,
            List<String> scopes
    ) {
        this.connectionId = connectionId;
        this.connectionToken = connectionToken;
        this.pairingSessionId = pairingSessionId;
        this.agentId = agentId;
        this.agentName = agentName;
        this.runtime = runtime;
        this.deviceLabel = deviceLabel;
        this.source = source;
        this.status = status;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
        this.lastActivityAt = lastActivityAt;
        this.expiresAt = expiresAt;
        this.scopes = scopes;
    }

    static AgentConnection parse(JSONObject json) {
        JSONObject agent = json.optJSONObject("agent_identity");
        if (agent == null) agent = new JSONObject();
        JSONArray scopeArray = json.optJSONArray("scopes");
        if (scopeArray == null) scopeArray = json.optJSONArray("approved_scopes");
        return new AgentConnection(
                json.optString("connection_id", ""),
                json.optString("connection_token", ""),
                json.optString("pairing_session_id", ""),
                agent.optString("agent_id", ""),
                agent.optString("agent_name", "Unknown agent"),
                agent.optString("runtime", "unknown"),
                agent.optString("device_label", ""),
                agent.optString("source", ""),
                json.optString("status", "active"),
                json.optString("created_at", ""),
                json.optString("updated_at", ""),
                json.optString("last_activity_at", ""),
                json.optString("expires_at", ""),
                stringArray(scopeArray)
        );
    }

    JSONObject toJson() throws Exception {
        JSONObject agent = new JSONObject()
                .put("agent_id", agentId)
                .put("agent_name", agentName)
                .put("runtime", runtime)
                .put("device_label", deviceLabel)
                .put("source", source);
        JSONArray scopeArray = new JSONArray();
        for (String scope : scopes) scopeArray.put(scope);
        return new JSONObject()
                .put("connection_id", connectionId)
                .put("connection_token", connectionToken)
                .put("pairing_session_id", pairingSessionId)
                .put("agent_identity", agent)
                .put("scopes", scopeArray)
                .put("status", status)
                .put("created_at", createdAt)
                .put("updated_at", updatedAt)
                .put("last_activity_at", lastActivityAt)
                .put("expires_at", expiresAt);
    }

    AgentConnection withStatus(String nextStatus) {
        return new AgentConnection(
                connectionId,
                connectionToken,
                pairingSessionId,
                agentId,
                agentName,
                runtime,
                deviceLabel,
                source,
                nextStatus,
                createdAt,
                updatedAt,
                lastActivityAt,
                expiresAt,
                scopes
        );
    }

    AgentConnection withTokenFrom(AgentConnection existing) {
        if (connectionToken.length() > 0 || existing == null || existing.connectionToken.length() == 0) return this;
        return new AgentConnection(
                connectionId,
                existing.connectionToken,
                pairingSessionId,
                agentId,
                agentName,
                runtime,
                deviceLabel,
                source,
                status,
                createdAt,
                updatedAt,
                lastActivityAt,
                expiresAt,
                scopes
        );
    }

    String displayName() {
        return agentName == null || agentName.trim().length() == 0 ? "Unknown agent" : agentName;
    }

    String scopeSummary() {
        if (scopes.isEmpty()) return "No approved scopes";
        StringBuilder out = new StringBuilder();
        for (String scope : scopes) {
            if (out.length() > 0) out.append(" / ");
            out.append(scope);
        }
        return out.toString();
    }

    boolean isRevoked() {
        return "revoked".equalsIgnoreCase(status);
    }

    private static List<String> stringArray(JSONArray array) {
        List<String> out = new ArrayList<>();
        if (array == null) return out;
        for (int i = 0; i < array.length(); i++) {
            String value = array.optString(i, "").trim();
            if (value.length() > 0 && !out.contains(value)) out.add(value);
        }
        return out;
    }
}
