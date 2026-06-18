package ai.agentwallet.hd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.time.Instant;

/**
 * M12: a payment request whose server payload carries no expires_at (or a drifted /
 * unparseable one) must NOT be force-expired after a local 5-minute default. It should
 * stay valid until the server says otherwise, while an explicit server expiry is honoured.
 */
public final class PaymentRequestExpiryTest {

    private static JSONObject base() throws Exception {
        return new JSONObject()
                .put("request_id", "req_expiry_test")
                .put("status", "pending")
                .put("payment", new JSONObject()
                        .put("network", "base_mainnet")
                        .put("asset", "USDC")
                        .put("amount", "10")
                        .put("to", "0x1111111111111111111111111111111111111111"));
    }

    @Test
    public void missingExpiryNeverExpires() throws Exception {
        PaymentRequest request = PaymentRequest.parse(base());
        assertFalse("a request with no expiry must not be marked expired", request.isExpired());
        assertFalse("a request with no expiry has no expiry window", request.hasExpiry());
        assertEquals(PaymentRequest.NO_EXPIRY, request.expiresAt);

        // PaymentIntent wraps the same request and must agree.
        PaymentIntent intent = PaymentIntent.parse(base());
        assertFalse(intent.isExpired());
        assertFalse(intent.hasExpiry());
    }

    @Test
    public void unparseableExpiryNeverExpires() throws Exception {
        PaymentRequest request = PaymentRequest.parse(base().put("expires_at", "soon-ish"));
        assertFalse(request.isExpired());
        assertFalse(request.hasExpiry());
    }

    @Test
    public void explicitFutureExpiryIsHonouredAndNotExpired() throws Exception {
        PaymentRequest request = PaymentRequest.parse(
                base().put("expires_at", Instant.now().plusSeconds(3600).toString()));
        assertTrue(request.hasExpiry());
        assertFalse(request.isExpired());
    }

    @Test
    public void explicitPastExpiryIsExpired() throws Exception {
        PaymentRequest request = PaymentRequest.parse(
                base().put("expires_at", Instant.now().minusSeconds(3600).toString()));
        assertTrue(request.hasExpiry());
        assertTrue(request.isExpired());
    }

    @Test
    public void explicitEpochMillisExpiryIsHonoured() throws Exception {
        PaymentRequest past = PaymentRequest.parse(
                base().put("expires_at_ms", System.currentTimeMillis() - 1_000L));
        assertTrue(past.hasExpiry());
        assertTrue(past.isExpired());

        PaymentRequest future = PaymentRequest.parse(
                base().put("expires_at_ms", System.currentTimeMillis() + 3_600_000L));
        assertTrue(future.hasExpiry());
        assertFalse(future.isExpired());
    }
}
