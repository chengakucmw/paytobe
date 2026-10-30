package ai.agentwallet.hd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.HashMap;
import java.util.Map;

public class FcmHintContractTest {
    @Test
    public void opaqueHintOnlyWakesAuthenticatedRestSync() {
        Map<String, String> data = new HashMap<>();
        data.put("type", "Paytobe.sync");
        data.put("sync_required", "true");
        data.put("event_id", "evt_opaque_1");
        data.put("request_id", "prq_opaque_1");
        data.put("event_seq", "42");

        PaytobeFirebaseMessagingService.PushHintDecision decision =
                PaytobeFirebaseMessagingService.evaluateData(data);

        assertTrue(decision.syncRequired);
        assertFalse(decision.ignoredFields);
        assertFalse(decision.malformedCoordinates);
        assertEquals("evt_opaque_1", decision.eventId);
        assertEquals("prq_opaque_1", decision.requestId);
        assertEquals("42", decision.eventSeq);
    }

    @Test
    public void paymentFactsAndSecretsAreIgnoredButCannotSuppressRecoverySync() {
        Map<String, String> data = new HashMap<>();
        data.put("type", "Paytobe.sync");
        data.put("sync_required", "true");
        data.put("request_id", "prq_opaque_2");
        data.put("amount", "999");
        data.put("recipient", "GSECRET");
        data.put("memo", "private memo");
        data.put("status", "confirmed");
        data.put("token", "bearer-secret");
        data.put("signature", "signed-material");

        PaytobeFirebaseMessagingService.PushHintDecision decision =
                PaytobeFirebaseMessagingService.evaluateData(data);

        assertTrue(decision.syncRequired);
        assertTrue(decision.ignoredFields);
        assertEquals("prq_opaque_2", decision.requestId);
    }

    @Test
    public void malformedCoordinatesAreDiscardedAndNonSyncMessagesDoNothing() {
        Map<String, String> malformed = new HashMap<>();
        malformed.put("type", "Paytobe.sync");
        malformed.put("sync_required", "true");
        malformed.put("event_id", "line\nbreak");
        malformed.put("event_seq", "0");
        PaytobeFirebaseMessagingService.PushHintDecision first =
                PaytobeFirebaseMessagingService.evaluateData(malformed);
        assertTrue(first.syncRequired);
        assertTrue(first.malformedCoordinates);
        assertEquals("", first.eventId);
        assertEquals("", first.eventSeq);

        PaytobeFirebaseMessagingService.PushHintDecision second =
                PaytobeFirebaseMessagingService.evaluateData(Map.of("type", "marketing", "sync_required", "true"));
        assertFalse(second.syncRequired);
    }
}
