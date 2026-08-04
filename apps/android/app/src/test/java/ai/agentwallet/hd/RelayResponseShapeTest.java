package ai.agentwallet.hd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/**
 * Regression coverage for bug H7: the Android single fetch and status report must not hard-assume an
 * outer "payment_request" wrapper. RelayClient now feeds the whole relay response to
 * {@link PaymentRequest#parse(JSONObject)}, which already unwraps a "payment_request" wrapper, an
 * "intent" wrapper, or a bare object. These tests pin that wrapper-drift tolerance so the fetch can
 * never crash on a shape change and a successful status report can never look like it failed.
 */
public final class RelayResponseShapeTest {

    private static JSONObject paymentRequestPayload() throws Exception {
        return new JSONObject()
                .put("protocol", PaymentRequest.PROTOCOL_PAYMENT_REQUEST)
                .put("request_id", "prq_h7_shape_drift")
                .put("status", "pending")
                .put("payment", new JSONObject()
                        .put("rail", "base_usdc")
                        .put("network", "base_mainnet")
                        .put("asset", "USDC")
                        .put("amount", "24.00")
                        .put("to", "0x6e182544a17bc2206ad7095b61f884e7f2d1d40b"));
    }

    private static void assertSamePayment(PaymentRequest request) {
        assertTrue(request.standard);
        assertEquals("prq_h7_shape_drift", request.requestId);
        assertEquals("24.00", request.amount);
        assertEquals("USDC", request.asset);
    }

    @Test
    public void parsesWrappedPaymentRequestResponse() throws Exception {
        // Shape the current relay returns: { ok, payment_request: { ... } }.
        JSONObject response = new JSONObject().put("ok", true).put("payment_request", paymentRequestPayload());
        assertSamePayment(PaymentRequest.parse(response));
    }

    @Test
    public void parsesBareResponseWithoutWrapper() throws Exception {
        // Drifted shape: the relay returns the request object directly, with no wrapper.
        // The old getJSONObject("payment_request") threw here and crashed fetch / masked the report.
        assertSamePayment(PaymentRequest.parse(paymentRequestPayload()));
    }

    @Test
    public void parsesLegacyIntentWrappedResponse() throws Exception {
        // Legacy shape: { intent: { ... } } must also unwrap rather than crash.
        JSONObject response = new JSONObject().put("intent", paymentRequestPayload());
        assertSamePayment(PaymentRequest.parse(response));
    }

    @Test
    public void wrappedAndBareResponsesParseEquivalently() throws Exception {
        JSONObject wrapped = new JSONObject().put("ok", true).put("payment_request", paymentRequestPayload());
        PaymentRequest fromWrapped = PaymentRequest.parse(wrapped);
        PaymentRequest fromBare = PaymentRequest.parse(paymentRequestPayload());
        assertEquals(fromWrapped.requestId, fromBare.requestId);
        assertEquals(fromWrapped.amount, fromBare.amount);
        assertEquals(fromWrapped.asset, fromBare.asset);
        assertEquals(fromWrapped.network, fromBare.network);
    }

    @Test
    public void emptyOrAcknowledgementBodyHasNoRequestIdentity() throws Exception {
        // A successful status report may answer with an empty body or a bare ack like { ok: true }.
        // Parsing must not throw, and the result must carry no request id so RelayClient's
        // hasRequestIdentity() guard skips the local upsert and never clobbers the inbox entry.
        assertTrue(PaymentRequest.parse(new JSONObject()).requestId.isEmpty());
        assertTrue(PaymentRequest.parse(new JSONObject().put("ok", true)).requestId.isEmpty());
        assertFalse(PaymentRequest.parse(paymentRequestPayload()).requestId.isEmpty());
    }

    @Test
    public void jsonNullMemoDoesNotBecomeLiteralNullText() throws Exception {
        JSONObject payload = paymentRequestPayload();
        payload.getJSONObject("payment")
                .put("memo", JSONObject.NULL)
                .put("memo_type", JSONObject.NULL);
        PaymentRequest request = PaymentRequest.parse(payload);
        assertEquals("", request.memo);
        assertEquals("", request.memoType);
    }
}
