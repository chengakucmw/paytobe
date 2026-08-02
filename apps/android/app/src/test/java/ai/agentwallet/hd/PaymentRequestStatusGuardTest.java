package ai.agentwallet.hd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/**
 * Client-side lifecycle guard. A relay snapshot merged into the local inbox must never
 * downgrade a locally-advanced status or perform an illegal jump, mirroring the backend's
 * PAYMENT_REQUEST_STATUS_TRANSITIONS and iOS's H12 downgrade protection. Without the guard,
 * a stale "pending" snapshot arriving after a local "broadcasted" made a paid request look
 * actionable again (duplicate-payment risk) and dropped the known tx hash.
 */
public final class PaymentRequestStatusGuardTest {

    // ---- transition truth table (mirrors services/platform-api/src/domain/payment-request.js) ----

    @Test
    public void pendingMayAdvanceButNotJumpToConfirmed() {
        assertTrue(PaymentRequest.canApplyStatusUpdate("pending", "signed"));
        assertTrue(PaymentRequest.canApplyStatusUpdate("pending", "broadcasted"));
        assertTrue(PaymentRequest.canApplyStatusUpdate("pending", "failed"));
        assertTrue(PaymentRequest.canApplyStatusUpdate("pending", "rejected"));
        assertTrue(PaymentRequest.canApplyStatusUpdate("pending", "expired"));
        // skipping the signature/broadcast step is illegal
        assertFalse(PaymentRequest.canApplyStatusUpdate("pending", "confirmed"));
    }

    @Test
    public void idempotentSameStatusIsAllowed() {
        assertTrue(PaymentRequest.canApplyStatusUpdate("pending", "pending"));
        assertTrue(PaymentRequest.canApplyStatusUpdate("broadcasted", "broadcasted"));
        assertTrue(PaymentRequest.canApplyStatusUpdate("confirmed", "confirmed"));
    }

    @Test
    public void broadcastedMayOnlyConfirmOrFail() {
        assertTrue(PaymentRequest.canApplyStatusUpdate("broadcasted", "confirmed"));
        assertTrue(PaymentRequest.canApplyStatusUpdate("broadcasted", "failed"));
        // downgrades are blocked
        assertFalse(PaymentRequest.canApplyStatusUpdate("broadcasted", "pending"));
        assertFalse(PaymentRequest.canApplyStatusUpdate("broadcasted", "signed"));
    }

    @Test
    public void terminalStatusesAreImmutable() {
        for (String terminal : new String[] {"confirmed", "failed", "expired", "rejected"}) {
            assertFalse(terminal + " -> pending must be rejected",
                    PaymentRequest.canApplyStatusUpdate(terminal, "pending"));
            assertFalse(terminal + " -> broadcasted must be rejected",
                    PaymentRequest.canApplyStatusUpdate(terminal, "broadcasted"));
        }
    }

    @Test
    public void normalizesProjectionAliasesBeforeChecking() {
        // "broadcasting" is the projection alias for broadcasted; it must still block a downgrade.
        assertFalse(PaymentRequest.canApplyStatusUpdate("broadcasting", "pending"));
        // "signed_locally" normalizes to signed, which may advance to broadcasted.
        assertTrue(PaymentRequest.canApplyStatusUpdate("signed_locally", "broadcasted"));
    }

    // ---- reconcile() merge behaviour (no Android Context needed) ----

    private static JSONObject storedItem(String status, String txHash) throws Exception {
        JSONObject item = new JSONObject()
                .put("request_id", "req_guard_test")
                .put("status", status)
                .put("payment", new JSONObject()
                        .put("rail", "stellar_xlm")
                        .put("network", "stellar_public")
                        .put("asset", "XLM")
                        .put("amount", "5")
                        .put("to", "GADESTINATION00000000000000000000000000000000000000000000"));
        if (txHash != null) item.put("tx_hash", txHash);
        return item;
    }

    private static PaymentRequest incomingWithStatus(String status) throws Exception {
        return PaymentRequest.parse(storedItem(status, null));
    }

    @Test
    public void reconcileBlocksDowngradeAndPreservesTxHash() throws Exception {
        JSONObject existing = storedItem("broadcasted", "abc123hash");
        PaymentRequest stalePending = incomingWithStatus("pending");

        JSONObject merged = PaymentInboxStore.reconcile(existing, stalePending);

        assertEquals("local broadcasted must not be downgraded to a stale pending",
                "broadcasted", merged.optString("status"));
        assertEquals("a known tx hash must survive a rejected downgrade",
                "abc123hash", merged.optString("tx_hash"));
    }

    @Test
    public void reconcileAcceptsLegalAdvance() throws Exception {
        JSONObject existing = storedItem("pending", null);
        PaymentRequest advanced = incomingWithStatus("broadcasted");

        JSONObject merged = PaymentInboxStore.reconcile(existing, advanced);

        assertEquals("a legal pending -> broadcasted advance must be applied",
                "broadcasted", merged.optString("status"));
    }

    @Test
    public void reconcileKeepsTerminalStatusAgainstRevival() throws Exception {
        JSONObject existing = storedItem("confirmed", "confirmedhash");
        PaymentRequest revival = incomingWithStatus("pending");

        JSONObject merged = PaymentInboxStore.reconcile(existing, revival);

        assertEquals("a terminal confirmed request must not be revived to pending",
                "confirmed", merged.optString("status"));
    }
}
