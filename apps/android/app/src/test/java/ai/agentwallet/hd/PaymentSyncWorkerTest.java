package ai.agentwallet.hd;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class PaymentSyncWorkerTest {
    @Test
    public void transientFailuresRetryWithinTheBound() {
        assertTrue(PaymentSyncWorker.shouldRetry(0));
        assertTrue(PaymentSyncWorker.shouldRetry(PaymentSyncWorker.MAX_ATTEMPTS - 2));
    }

    @Test
    public void finalFailureStopsRetrying() {
        assertFalse(PaymentSyncWorker.shouldRetry(PaymentSyncWorker.MAX_ATTEMPTS - 1));
        assertFalse(PaymentSyncWorker.shouldRetry(PaymentSyncWorker.MAX_ATTEMPTS));
    }
}
