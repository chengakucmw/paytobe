package ai.agentwallet.hd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.List;

public class RestSyncPlanTest {
    @Test
    public void firstRunRetentionResetAndServerCursorRegressionRequireFullRefresh() throws Exception {
        RelayClient.RestSyncPlan first = RelayClient.planRestSync(new JSONObject()
                .put("latest_seq", 8)
                .put("reset_required", false), 0);
        assertTrue(first.fullRefresh);
        assertEquals(8L, first.latestSeq);

        RelayClient.RestSyncPlan retained = RelayClient.planRestSync(new JSONObject()
                .put("latest_seq", 80)
                .put("reset_required", true), 40);
        assertTrue(retained.fullRefresh);

        RelayClient.RestSyncPlan restarted = RelayClient.planRestSync(new JSONObject()
                .put("latest_seq", 2)
                .put("reset_required", false), 40);
        assertTrue(restarted.fullRefresh);
        assertEquals(2L, restarted.latestSeq);
    }

    @Test
    public void eventPageDeduplicatesRequestsAndKeepsMonotonicWindow() throws Exception {
        JSONArray events = new JSONArray()
                .put(event(11, "prq_a"))
                .put(event(12, "prq_a"))
                .put(event(14, "prq_b"));
        RelayClient.RestSyncPlan plan = RelayClient.planRestSync(new JSONObject()
                .put("latest_seq", 14)
                .put("reset_required", false)
                .put("items", events), 10);

        assertFalse(plan.fullRefresh);
        assertEquals(14L, plan.latestSeq);
        assertEquals(List.of("prq_a", "prq_b"), plan.requestIds);
    }

    @Test
    public void malformedOrCrossContractEventsCannotAdvanceCursor() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> RelayClient.planRestSync(new JSONObject()
                .put("latest_seq", 12)
                .put("items", new JSONArray().put(event(13, "prq_future"))), 10));

        assertThrows(IllegalArgumentException.class, () -> RelayClient.planRestSync(new JSONObject()
                .put("latest_seq", 12)
                .put("items", new JSONArray().put(new JSONObject()
                        .put("seq", 11)
                        .put("type", "merchant.updated")
                        .put("request_id", "prq_wrong_tenant"))), 10));

        assertThrows(IllegalArgumentException.class, () -> RelayClient.planRestSync(new JSONObject()
                .put("latest_seq", 12)
                .put("items", new JSONArray().put(event(11, "../wrong"))), 10));
    }

    private static JSONObject event(long seq, String requestId) throws Exception {
        return new JSONObject()
                .put("seq", seq)
                .put("type", "payment_request.status")
                .put("request_id", requestId);
    }
}
