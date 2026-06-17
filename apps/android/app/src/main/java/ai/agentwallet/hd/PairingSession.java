package ai.agentwallet.hd;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

final class PairingSession {
    final String pairingSessionId;
    final String pairingCode;
    final String pairingUri;
    final String status;
    final String agentId;
    final String agentName;
    final String runtime;
    final String deviceLabel;
    final String source;
    final String expiresAt;
    final List<String> requestedScopes;

    private PairingSession(
            String pairingSessionId,
            String pairingCode,
            String pairingUri,
            String status,
            String agentId,
            String agentName,
            String runtime,
            String deviceLabel,
            String source,
            String expiresAt,
            List<String> requestedScopes
    ) {
        this.pairingSessionId = pairingSessionId;
        this.pairingCode = pairingCode;
        this.pairingUri = pairingUri;
        this.status = status;
        this.agentId = agentId;
        this.agentName = agentName;
        this.runtime = runtime;
        this.deviceLabel = deviceLabel;
        this.source = source;
        this.expiresAt = expiresAt;
        this.requestedScopes = requestedScopes;
    }

    static PairingSession parse(JSONObject json) {
        JSONObject agent = json.optJSONObject("agent_identity");
        if (agent == null) agent = new JSONObject();
        return new PairingSession(
                json.optString("pairing_session_id", ""),
                json.optString("pairing_code", ""),
                json.optString("pairing_uri", ""),
                json.optString("status", ""),
                agent.optString("agent_id", ""),
                agent.optString("agent_name", "Unknown agent"),
                agent.optString("runtime", "unknown"),
                agent.optString("device_label", ""),
                agent.optString("source", ""),
                json.optString("expires_at", ""),
                stringArray(json.optJSONArray("requested_scopes"))
        );
    }

    boolean isPending() {
        return "pending".equalsIgnoreCase(status);
    }

    String displayName() {
        return agentName == null || agentName.trim().length() == 0 ? "Unknown agent" : agentName;
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
