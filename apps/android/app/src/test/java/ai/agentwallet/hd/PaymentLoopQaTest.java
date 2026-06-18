package ai.agentwallet.hd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class PaymentLoopQaTest {
    @Test
    public void normalBaseUsdcRequestIsSignableAndVisibleInPendingLoop() throws Exception {
        PaymentRequest request = PaymentRequest.parse(baseRequest()
                .put("risk", new JSONObject()
                        .put("level", "safe")
                        .put("review_status", "ready")
                        .put("signing_allowed", true)));

        assertTrue(request.standard);
        assertTrue(request.isBaseUsdc());
        assertEquals("pending", request.reviewState);
        assertEquals("pending", request.inboxGroup);
        assertEquals("24.00", request.amount);
        assertEquals("USDC", request.asset);
        assertEquals("base_mainnet", request.network);
        assertTrue(request.signingAllowed);
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, request.reviewState));
    }

    @Test
    public void missingContextPausesSigningButKeepsPaymentFactsVisible() throws Exception {
        PaymentRequest request = PaymentRequest.parse(baseRequest()
                .put("risk", new JSONObject()
                        .put("level", "caution")
                        .put("review_status", "missing_context")
                        .put("warnings", new JSONArray().put(new JSONObject()
                                .put("code", "context_missing")
                                .put("message", "Required transaction context is missing."))))
                .put("context", new JSONObject().put("status", "missing")));

        assertEquals("missing_context", request.reviewState);
        assertEquals("Missing context", request.statusLabel);
        assertEquals("24.00", request.amount);
        assertEquals("0x6e182544a17bc2206ad7095b61f884e7f2d1d40b", request.recipient);
        assertFalse(request.signingAllowed);
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, request.reviewState));
    }

    @Test
    public void blockedMismatchDisablesSigningAndStaysInAttentionQueue() throws Exception {
        PaymentRequest request = PaymentRequest.parse(baseRequest()
                .put("risk", new JSONObject()
                        .put("level", "danger")
                        .put("review_status", "blocked")
                        .put("errors", new JSONArray().put(new JSONObject()
                                .put("code", "context_payee_mismatch")
                                .put("field", "payee.name")
                                .put("message", "Recipient differs from verified merchant.")))));

        assertEquals("blocked", request.reviewState);
        assertEquals("Risk blocked", request.statusLabel);
        assertFalse(request.signingAllowed);
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, request.reviewState));
        assertTrue(PaymentInboxFilter.compare("blocked", 100L, 500L, "pending", 200L, 300L) < 0);
    }

    @Test
    public void finalStatusLeavesPendingLoopAndCannotBeSignedAgain() throws Exception {
        PaymentRequest request = PaymentRequest.parse(baseRequest()
                .put("status", "confirmed")
                .put("risk", new JSONObject()
                        .put("level", "safe")
                        .put("review_status", "ready")));

        assertEquals(PaymentRequest.STATUS_CONFIRMED, request.status);
        assertEquals("confirmed", request.reviewState);
        assertEquals("final", request.inboxGroup);
        assertFalse(request.signingAllowed);
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, request.reviewState));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_FINAL, request.reviewState));
    }

    @Test
    public void signedLocallyMapsToStandardSignedLifecycle() throws Exception {
        PaymentRequest request = PaymentRequest.parse(baseRequest()
                .put("status", "signed_locally")
                .put("risk", new JSONObject()
                        .put("level", "safe")
                        .put("review_status", "ready")));

        assertEquals(PaymentRequest.STATUS_SIGNED, request.status);
        assertEquals("signed_locally", request.reviewState);
        assertEquals("Signed locally", request.statusLabel);
    }

    private static JSONObject baseRequest() throws Exception {
        return new JSONObject()
                .put("protocol", PaymentRequest.PROTOCOL_PAYMENT_REQUEST)
                .put("request_id", "prq_android_loop_qa")
                .put("transaction_id", "txn_android_loop_qa")
                .put("status", "pending")
                .put("created_at", "2026-06-17T00:00:00.000Z")
                .put("expires_at", "2026-06-17T00:05:00.000Z")
                .put("source", new JSONObject()
                        .put("agent_id", "agt_agentfood")
                        .put("agent_name", "AgentFood")
                        .put("runtime", "local")
                        .put("channel", "agentfood.eth"))
                .put("payee", new JSONObject()
                        .put("name", "Oaxaca Kitchen")
                        .put("domain", "oaxaca.example")
                        .put("verified", true))
                .put("payment", new JSONObject()
                        .put("rail", "base_usdc")
                        .put("network", "base_mainnet")
                        .put("chain_id", 8453)
                        .put("asset", "USDC")
                        .put("amount", "24.00")
                        .put("to", "0x6e182544a17bc2206ad7095b61f884e7f2d1d40b")
                        .put("token_contract", RiskPolicy.BASE_USDC)
                        .put("decimals", 6)
                        .put("estimated_fee", "0.01"))
                .put("payment_facts", new JSONObject()
                        .put("amount", "24.00")
                        .put("token", "USDC")
                        .put("network", "base_mainnet")
                        .put("recipient", "0x6e182544a17bc2206ad7095b61f884e7f2d1d40b"))
                .put("transaction_context_snapshot", new JSONObject()
                        .put("transaction_id", "txn_android_loop_qa")
                        .put("truth_fields", new JSONArray().put(new JSONObject()
                                .put("field", "merchant")
                                .put("value", "Oaxaca Kitchen")
                                .put("source", "signed checkout")
                                .put("verification_status", "signature_verified"))));
    }
}
