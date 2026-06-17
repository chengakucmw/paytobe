package ai.agentwallet.hd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class PaymentInboxFilterTest {
    @Test
    public void pendingFilterIncludesActiveAttentionStates() {
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "pending"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "missing_context"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "blocked"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "broadcasting"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "failed"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "network_disabled"));
    }

    @Test
    public void pendingFilterExcludesFinalStates() {
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "confirmed"));
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "rejected"));
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "expired"));
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_PENDING, "cancelled"));
    }

    @Test
    public void finalFilterContainsOnlyFinalStates() {
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_FINAL, "confirmed"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_FINAL, "rejected"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_FINAL, "expired"));
        assertTrue(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_FINAL, "cancelled"));
        assertFalse(PaymentInboxFilter.matches(PaymentInboxFilter.FILTER_FINAL, "failed"));
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
