package ai.agentwallet.hd;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Wallet-owned, one-time Connect Invitation. The plaintext key exists only in the create response. */
final class ConnectInvitation {
    final String connectInvitationId;
    final String connectKey;
    final String status;
    final String pairingSessionId;
    final String connectionId;
    final String agentId;
    final String agentName;
    final String runtime;
    final String source;
    final String identityAssurance;
    final List<String> requestedScopes;
    final String expiresAt;
    final String reviewState;
    final boolean approvalAllowed;
    final String reviewReasonCode;
    final String merchantId;
    final String merchantName;
    final String merchantStatus;
    final String merchantVerificationState;
    final String verifiedDomain;
    final String agentStatus;
    final String credentialId;
    final String credentialStatus;
    final String credentialExpiresAt;

    private ConnectInvitation(
            String connectInvitationId,
            String connectKey,
            String status,
            String pairingSessionId,
            String connectionId,
            String agentId,
            String agentName,
            String runtime,
            String source,
            String identityAssurance,
            List<String> requestedScopes,
            String expiresAt,
            String reviewState,
            boolean approvalAllowed,
            String reviewReasonCode,
            String merchantId,
            String merchantName,
            String merchantStatus,
            String merchantVerificationState,
            String verifiedDomain,
            String agentStatus,
            String credentialId,
            String credentialStatus,
            String credentialExpiresAt
    ) {
        this.connectInvitationId = connectInvitationId;
        this.connectKey = connectKey;
        this.status = status;
        this.pairingSessionId = pairingSessionId;
        this.connectionId = connectionId;
        this.agentId = agentId;
        this.agentName = agentName;
        this.runtime = runtime;
        this.source = source;
        this.identityAssurance = identityAssurance;
        this.requestedScopes = requestedScopes;
        this.expiresAt = expiresAt;
        this.reviewState = reviewState;
        this.approvalAllowed = approvalAllowed;
        this.reviewReasonCode = reviewReasonCode;
        this.merchantId = merchantId;
        this.merchantName = merchantName;
        this.merchantStatus = merchantStatus;
        this.merchantVerificationState = merchantVerificationState;
        this.verifiedDomain = verifiedDomain;
        this.agentStatus = agentStatus;
        this.credentialId = credentialId;
        this.credentialStatus = credentialStatus;
        this.credentialExpiresAt = credentialExpiresAt;
    }

    static ConnectInvitation parse(JSONObject response, String preservedKey) {
        JSONObject invitation = response.optJSONObject("connect_invitation");
        if (invitation == null) invitation = response;
        JSONObject agent = invitation.optJSONObject("agent_identity");
        if (agent == null) agent = new JSONObject();
        JSONObject review = invitation.optJSONObject("identity_review");
        if (review == null) review = new JSONObject();
        JSONObject merchant = review.optJSONObject("merchant");
        if (merchant == null) merchant = new JSONObject();
        JSONObject reviewedAgent = review.optJSONObject("agent");
        if (reviewedAgent == null) reviewedAgent = new JSONObject();
        JSONObject credential = review.optJSONObject("credential");
        if (credential == null) credential = new JSONObject();
        JSONArray rawScopes = invitation.optJSONArray("requested_scopes");
        List<String> scopes = new ArrayList<>();
        boolean scopesSafe = true;
        if (rawScopes != null) {
            for (int index = 0; index < rawScopes.length(); index++) {
                String scope = rawScopes.optString(index, "").trim();
                if (!scope.isEmpty()) {
                    scopes.add(scope);
                    if (!isReviewableScope(scope)) scopesSafe = false;
                }
            }
        }
        String responseKey = response.optString("connect_key", "").trim();
        String reviewState = review.optString("state", "unverifiable").toLowerCase(java.util.Locale.US);
        boolean approvalAllowed = review.optBoolean("approval_allowed", false);
        String reviewReason = review.optString("reason_code", "identity_unverifiable");
        if (!scopesSafe) {
            reviewState = "unverifiable";
            approvalAllowed = false;
            reviewReason = "unsupported_or_sensitive_scope";
        }
        return new ConnectInvitation(
                invitation.optString("connect_invitation_id", ""),
                responseKey.isEmpty() ? value(preservedKey) : responseKey,
                invitation.optString("status", "waiting").toLowerCase(java.util.Locale.US),
                invitation.optString("pairing_session_id", ""),
                invitation.optString("connection_id", ""),
                firstNonEmpty(reviewedAgent.optString("agent_id", ""), agent.optString("agent_id", "")),
                firstNonEmpty(reviewedAgent.optString("name", ""), agent.optString("agent_name", "")),
                firstNonEmpty(reviewedAgent.optString("runtime", ""), agent.optString("runtime", "")),
                agent.optString("source", ""),
                invitation.optString("identity_assurance", ""),
                scopes,
                invitation.optString("expires_at", ""),
                reviewState,
                approvalAllowed,
                reviewReason,
                merchant.optString("merchant_id", agent.optString("merchant_id", "")),
                merchant.optString("display_name", ""),
                merchant.optString("status", ""),
                merchant.optString("verification_state", ""),
                merchant.optString("verified_domain", ""),
                reviewedAgent.optString("status", ""),
                credential.optString("credential_id", agent.optString("credential_id", "")),
                credential.optString("status", ""),
                credential.optString("expires_at", "")
        );
    }

    boolean isTerminal() {
        return "connected".equals(status)
                || "rejected".equals(status)
                || "cancelled".equals(status)
                || "expired".equals(status);
    }

    boolean hasClaimedAgent() {
        return !pairingSessionId.isEmpty() && !agentName.isEmpty();
    }

    boolean isApprovable(long nowMs) {
        if (!"claimed".equals(status) || !"verified".equals(reviewState) || !approvalAllowed) return false;
        try {
            return java.time.Instant.parse(expiresAt).toEpochMilli() > nowMs;
        } catch (Exception invalidExpiry) {
            return false;
        }
    }

    private static boolean isReviewableScope(String scope) {
        String normalized = value(scope).toLowerCase(java.util.Locale.US);
        return "payment.requests.create".equals(normalized)
                || "payment.requests.read".equals(normalized)
                || "transaction_contexts.create".equals(normalized)
                || "transaction_contexts.read".equals(normalized)
                || "wallet.addresses.read".equals(normalized);
    }

    private static String firstNonEmpty(String preferred, String fallback) {
        return value(preferred).trim().isEmpty() ? value(fallback) : preferred;
    }

    private static String value(String value) {
        return value == null ? "" : value;
    }
}
