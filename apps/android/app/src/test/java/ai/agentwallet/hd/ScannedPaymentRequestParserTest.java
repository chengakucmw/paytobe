package ai.agentwallet.hd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeFalse;

import org.json.JSONObject;
import org.junit.Test;

public final class ScannedPaymentRequestParserTest {
    @Test
    public void PaytobeQrBecomesSignableBaseUsdcPaymentRequest() throws Exception {
        assumeFalse(BuildConfig.TESTNET_ONLY);

        PaymentIntent intent = ScannedPaymentRequestParser.parseIntent(
                "paytobe://pay?to=0x71d8B0d47f3c9d0bA9F1d2a6168A5F80f20356d0"
                        + "&amount=18.75"
                        + "&asset=USDC"
                        + "&network=Base"
                        + "&payee=Oaxaca%20Kitchen%20Register"
                        + "&memo=Counter%20order%20%231842"
        );

        assertNotNull(intent);
        assertTrue(intent.id.startsWith("scan_"));
        assertEquals(PaymentRequest.PROTOCOL_PAYMENT_REQUEST, intent.request.protocol);
        assertEquals("base_usdc", intent.rail);
        assertEquals("base_mainnet", intent.network);
        assertEquals(8453L, intent.chainId);
        assertEquals("USDC", intent.asset);
        assertEquals("18.75", intent.amount);
        assertEquals(RiskPolicy.BASE_USDC, intent.tokenContract);
        assertEquals("https://mainnet.base.org", intent.rpcUrl);
        assertEquals("pending", intent.request.reviewState);
        assertTrue(intent.request.signingAllowed);
    }

    @Test
    public void stellarPayQrBecomesXlmPaymentRequest() throws Exception {
        PaymentIntent intent = ScannedPaymentRequestParser.parseIntent(
                "web+stellar:pay?destination=" + stellarAddress()
                        + "&amount=1.2500000"
                        + "&network=testnet"
                        + "&memo=invoice-7"
        );

        assertNotNull(intent);
        assertEquals("stellar_xlm", intent.rail);
        assertEquals("stellar_testnet", intent.network);
        assertEquals("XLM", intent.asset);
        assertEquals("1.2500000", intent.amount);
        assertEquals("https://horizon-testnet.stellar.org", intent.horizonUrl);
        assertTrue(intent.stellarTestnet);
    }

    @Test
    public void ethereumUriKeepsBaseNativeEthSeparateFromBaseUsdc() throws Exception {
        assumeFalse(BuildConfig.TESTNET_ONLY);

        PaymentIntent intent = ScannedPaymentRequestParser.parseIntent(
                "ethereum:0x71d8B0d47f3c9d0bA9F1d2a6168A5F80f20356d0@8453?amount=0.002"
        );

        assertNotNull(intent);
        assertEquals("evm_native", intent.rail);
        assertEquals("base_mainnet", intent.network);
        assertEquals(8453L, intent.chainId);
        assertEquals("ETH", intent.asset);
        assertEquals("", intent.tokenContract);
        assertEquals("0.002", intent.amount);
    }

    @Test
    public void eip681TransferQrBecomesBaseUsdcPaymentRequest() throws Exception {
        assumeFalse(BuildConfig.TESTNET_ONLY);

        PaymentIntent intent = ScannedPaymentRequestParser.parseIntent(
                "ethereum:" + RiskPolicy.BASE_USDC + "@8453/transfer"
                        + "?address=0x71d8B0d47f3c9d0bA9F1d2a6168A5F80f20356d0"
                        + "&uint256=18750000"
                        + "&decimals=6"
        );

        assertNotNull(intent);
        assertEquals("base_usdc", intent.rail);
        assertEquals("base_mainnet", intent.network);
        assertEquals(8453L, intent.chainId);
        assertEquals("USDC", intent.asset);
        assertEquals(RiskPolicy.BASE_USDC, intent.tokenContract);
        assertEquals("18.75", intent.amount);
    }

    @Test
    public void fullPaymentRequestJsonIsAcceptedWithoutRewritingRequestId() throws Exception {
        JSONObject payload = new JSONObject()
                .put("protocol", PaymentRequest.PROTOCOL_PAYMENT_REQUEST)
                .put("request_id", "prq_scanned_json")
                .put("status", "pending")
                .put("created_at_ms", System.currentTimeMillis())
                .put("expires_at_ms", System.currentTimeMillis() + 300_000L)
                .put("source", new JSONObject().put("agent_name", "QR Checkout"))
                .put("payee", new JSONObject().put("name", "QR Merchant"))
                .put("payment", new JSONObject()
                        .put("rail", "stellar_xlm")
                        .put("network", "stellar_testnet")
                        .put("asset", "XLM")
                        .put("amount", "2.0000000")
                        .put("to", stellarAddress())
                        .put("horizon_url", "https://horizon-testnet.stellar.org"))
                .put("risk", new JSONObject()
                        .put("level", "safe")
                        .put("review_status", "ready")
                        .put("signing_allowed", true));

        PaymentIntent intent = ScannedPaymentRequestParser.parseIntent(payload.toString());

        assertNotNull(intent);
        assertEquals("prq_scanned_json", intent.id);
        assertEquals("stellar_xlm", intent.rail);
        assertEquals("2.0000000", intent.amount);
    }

    @Test
    public void arbitraryJsonDoesNotBecomePaymentRequest() throws Exception {
        JSONObject payload = new JSONObject()
                .put("type", "receipt")
                .put("payment", new JSONObject().put("note", "not a signable request"));

        assertNull(ScannedPaymentRequestParser.parseIntent(payload.toString()));
    }

    @Test
    public void bareAddressDoesNotBecomePaymentRequestWithoutAmount() throws Exception {
        assertNull(ScannedPaymentRequestParser.parseIntent("0x71d8B0d47f3c9d0bA9F1d2a6168A5F80f20356d0"));
        assertNull(ScannedPaymentRequestParser.parseIntent(stellarAddress()));
    }

    private static String stellarAddress() {
        return "G" + "A".repeat(55);
    }
}
