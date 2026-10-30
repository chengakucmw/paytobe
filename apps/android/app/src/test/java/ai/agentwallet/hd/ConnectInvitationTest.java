package ai.agentwallet.hd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class ConnectInvitationTest {
    @Test
    public void parsesOneTimeKeyAndFiltersForbiddenScopes() throws Exception {
        String key = "paytobe-connect:ck_" + "A".repeat(43);
        JSONObject response = new JSONObject()
                .put("connect_key", key)
                .put("connect_invitation", new JSONObject()
                        .put("connect_invitation_id", "cinv_test")
                        .put("status", "claimed")
                        .put("pairing_session_id", "pair_test")
                        .put("identity_assurance", "unverified")
                        .put("identity_review", new JSONObject()
                                .put("state", "unverifiable")
                                .put("approval_allowed", false)
                                .put("reason_code", "identity_not_registered"))
                        .put("expires_at", "2026-07-22T10:00:00.000Z")
                        .put("agent_identity", new JSONObject()
                                .put("agent_id", "agentfood")
                                .put("agent_name", "AgentFood")
                                .put("runtime", "cloudflare-worker")
                                .put("source", "demo_website"))
                        .put("requested_scopes", new JSONArray()
                                .put("payment.requests.create")
                                .put("wallet.sign")
                                .put("seed.read")));

        ConnectInvitation invitation = ConnectInvitation.parse(response, "");

        assertEquals(key, invitation.connectKey);
        assertEquals("AgentFood", invitation.agentName);
        assertEquals(3, invitation.requestedScopes.size());
        assertEquals("payment.requests.create", invitation.requestedScopes.get(0));
        assertTrue(invitation.hasClaimedAgent());
        assertFalse(invitation.isTerminal());
        assertFalse(invitation.isApprovable(System.currentTimeMillis()));
        assertEquals("unverifiable", invitation.reviewState);
        assertEquals("unsupported_or_sensitive_scope", invitation.reviewReasonCode);
    }

    @Test
    public void liveVerifiedReviewIsApprovableAndExposesStableFacts() throws Exception {
        JSONObject response = new JSONObject().put("connect_invitation", new JSONObject()
                .put("connect_invitation_id", "cinv_verified")
                .put("status", "claimed")
                .put("pairing_session_id", "pair_verified")
                .put("identity_assurance", "registered")
                .put("expires_at", "2099-01-01T00:00:00Z")
                .put("agent_identity", new JSONObject()
                        .put("agent_id", "agent_verified")
                        .put("agent_name", "Vеrified Agent")
                        .put("runtime", "node")
                        .put("merchant_id", "merchant_verified")
                        .put("credential_id", "credential_verified"))
                .put("requested_scopes", new JSONArray().put("payment.requests.create"))
                .put("identity_review", new JSONObject()
                        .put("state", "verified")
                        .put("approval_allowed", true)
                        .put("reason_code", "verified")
                        .put("merchant", new JSONObject()
                                .put("merchant_id", "merchant_verified")
                                .put("display_name", "Vеrified Merchant")
                                .put("status", "active")
                                .put("verification_state", "verified")
                                .put("verified_domain", "pay.example.com"))
                        .put("agent", new JSONObject().put("status", "active"))
                        .put("credential", new JSONObject()
                                .put("credential_id", "credential_verified")
                                .put("status", "active")
                                .put("expires_at", "2098-12-01T00:00:00Z"))));

        ConnectInvitation invitation = ConnectInvitation.parse(response, "");
        assertTrue(invitation.isApprovable(System.currentTimeMillis()));
        assertEquals("merchant_verified", invitation.merchantId);
        assertEquals("pay.example.com", invitation.verifiedDomain);
        assertEquals("active", invitation.credentialStatus);
    }

    @Test
    public void pendingSuspendedExpiredAndMissingReviewFailClosed() throws Exception {
        for (String state : new String[] { "pending", "suspended", "unverifiable" }) {
            JSONObject response = reviewResponse(state, true, "2099-01-01T00:00:00Z");
            assertFalse(state, ConnectInvitation.parse(response, "").isApprovable(System.currentTimeMillis()));
        }
        assertFalse(ConnectInvitation.parse(reviewResponse("verified", true, "2020-01-01T00:00:00Z"), "")
                .isApprovable(System.currentTimeMillis()));
        assertFalse(ConnectInvitation.parse(new JSONObject().put("connect_invitation", new JSONObject()
                .put("status", "claimed").put("expires_at", "2099-01-01T00:00:00Z")), "")
                .isApprovable(System.currentTimeMillis()));
    }

    private static JSONObject reviewResponse(String state, boolean allowed, String expiresAt) throws Exception {
        return new JSONObject().put("connect_invitation", new JSONObject()
                .put("connect_invitation_id", "cinv_state")
                .put("status", "claimed")
                .put("pairing_session_id", "pair_state")
                .put("expires_at", expiresAt)
                .put("agent_identity", new JSONObject().put("agent_name", "Agent"))
                .put("identity_review", new JSONObject().put("state", state).put("approval_allowed", allowed)));
    }
}
