package ai.agentwallet.hd;

import org.json.JSONObject;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertTrue;

public class BuildNetworkPolicyTest {
    private static final String RECIPIENT =
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

    @Test
    public void bothOfficialFlavorsAllowOnlyOfficialStellarTestnetXlm() throws Exception {
        assertTrue(BuildNetworkPolicy.violations(stellar(true), true, false).isEmpty());
        assertTrue(BuildNetworkPolicy.violations(stellar(true), true, true).isEmpty());
    }

    @Test
    public void bothOfficialFlavorsRejectStellarMainnet() throws Exception {
        for (boolean stellarFlavor : new boolean[] {false, true}) {
            List<String> errors = BuildNetworkPolicy.violations(stellar(false), true, stellarFlavor);
            assertTrue(errors.stream().anyMatch(value -> value.contains("Mainnet")));
            assertTrue(errors.stream().anyMatch(value -> value.contains("Horizon")));
        }
    }

    @Test
    public void officialBuildRejectsNonStellarMainnetRails() throws Exception {
        JSONObject payment = new JSONObject()
                .put("rail", "ethereum_eth")
                .put("network", "ethereum_mainnet")
                .put("chain_id", 1)
                .put("asset", "ETH")
                .put("amount", "1")
                .put("to", "0x000000000000000000000000000000000000dEaD");
        PaymentIntent intent = PaymentIntent.parse(new JSONObject()
                .put("request_id", "test-evm")
                .put("status", PaymentIntent.STATUS_PENDING)
                .put("payment", payment));
        List<String> errors = BuildNetworkPolicy.violations(intent, true, false);
        assertTrue(errors.stream().anyMatch(value -> value.contains("only Stellar testnet XLM")));
        assertTrue(errors.stream().anyMatch(value -> value.contains("Mainnet")));
    }

    @Test
    public void missingPaymentRequestFailsClosedForOfficialBuilds() {
        assertTrue(BuildNetworkPolicy.violations(null, true, false).stream()
                .anyMatch(value -> value.contains("requires a payment request")));
    }

    private static PaymentIntent stellar(boolean testnet) throws Exception {
        JSONObject payment = new JSONObject()
                .put("rail", "stellar_xlm")
                .put("network", testnet ? "stellar_testnet" : "stellar_public")
                .put("asset", "XLM")
                .put("amount", "1")
                .put("to", RECIPIENT)
                .put("stellar_testnet", testnet)
                .put("horizon_url", testnet
                        ? BuildNetworkPolicy.STELLAR_TESTNET_HORIZON
                        : "https://horizon.stellar.org");
        return PaymentIntent.parse(new JSONObject()
                .put("request_id", "test-stellar")
                .put("status", PaymentIntent.STATUS_PENDING)
                .put("payment", payment));
    }
}
