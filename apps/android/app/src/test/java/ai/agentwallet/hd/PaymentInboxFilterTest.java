package ai.agentwallet.hd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class PaymentInboxFilterTest {
    @Test
    public void pendingFilterIncludesPreSignatureAttentionStates() {
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "pending"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "missing_context"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "blocked"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "needs_review"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "network_disabled"));
    }

    @Test
    public void pendingFilterExcludesSignedAndTerminalStates() {
        // 已签名/广播中归入 Signed；终态/失败归入 Completed。
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "signed_locally"));
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "broadcasting"));
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "failed"));
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "confirmed"));
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "rejected"));
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "expired"));
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "cancelled"));
    }

    @Test
    public void signedFilterContainsOnlySignedStates() {
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_SIGNED, "signed_locally"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_SIGNED, "broadcasting"));
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_SIGNED, "pending"));
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_SIGNED, "confirmed"));
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_SIGNED, "failed"));
    }

    @Test
    public void completedFilterContainsTerminalStatesAndFailed() {
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_COMPLETED, "confirmed"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_COMPLETED, "rejected"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_COMPLETED, "expired"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_COMPLETED, "cancelled"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_COMPLETED, "failed"));
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_COMPLETED, "pending"));
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_COMPLETED, "broadcasting"));
    }

    @Test
    public void legacyFinalFilterStillMatchesCompletedStates() {
        // 旧 "final" 值仍可用，等同 "completed"。
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_FINAL, "confirmed"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_FINAL, "expired"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_FINAL, "failed"));
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_FINAL, "pending"));
    }

    @Test
    public void allFilterMatchesEveryState() {
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_ALL, "pending"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_ALL, "signed_locally"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_ALL, "expired"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_ALL, "failed"));
    }

    @Test
    public void toneForStateGivesExpiredItsOwnTone() {
        assertEquals("expired", PaymentInboxFilter.toneForState("expired"));
        assertEquals("safe", PaymentInboxFilter.toneForState("confirmed"));
        assertEquals("danger", PaymentInboxFilter.toneForState("failed"));
        assertEquals("danger", PaymentInboxFilter.toneForState("rejected"));
        assertEquals("caution", PaymentInboxFilter.toneForState("pending"));
        assertEquals("info", PaymentInboxFilter.toneForState("broadcasting"));
    }

    @Test
    public void effectiveStateAppliesRiskAndExpiryProjection() {
        assertEquals("missing_context", PaymentInboxFilter.effectiveState("pending", "", "missing_context", "caution", false));
        assertEquals("blocked", PaymentInboxFilter.effectiveState("pending", "", "blocked", "danger", false));
        assertEquals("expired", PaymentInboxFilter.effectiveState("pending", "", "", "safe", true));
        assertEquals("broadcasting", PaymentInboxFilter.effectiveState("broadcasted", "", "", "safe", false));
    }

    @Test
    public void attentionStatesSortBeforeOrdinaryPendingAndSoonerExpiryWins() {
        assertTrue(PaymentInboxFilter.compare("blocked", 100L, 500L, "pending", 200L, 300L) < 0);
        assertTrue(PaymentInboxFilter.compare("pending", 100L, 300L, "pending", 200L, 500L) < 0);
    }
}
