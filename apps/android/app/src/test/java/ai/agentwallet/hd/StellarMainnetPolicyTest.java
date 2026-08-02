package ai.agentwallet.hd;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class StellarMainnetPolicyTest {
    private static final String RECIPIENT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    private static final String OTHER = "GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H";
    private static final String HORIZON = "https://horizon.stellar.org";

    @Test
    public void testnetBypassesMainnetReleaseGate() {
        StellarMainnetPolicy.Config disabled = new StellarMainnetPolicy.Config(false, "", "", "");
        assertTrue(StellarMainnetPolicy.violations(true, "https://horizon-testnet.stellar.org", OTHER, "100", disabled).isEmpty());
    }

    @Test
    public void mainnetIsDisabledByDefaultConfig() {
        StellarMainnetPolicy.Config disabled = new StellarMainnetPolicy.Config(false, "1", HORIZON, RECIPIENT);
        List<String> errors = StellarMainnetPolicy.violations(false, HORIZON, RECIPIENT, "0.1", disabled);
        assertEquals(1, errors.size());
        assertTrue(errors.get(0).contains("disabled"));
    }

    @Test
    public void smallAllowlistedMainnetPaymentPasses() {
        StellarMainnetPolicy.Config enabled = new StellarMainnetPolicy.Config(true, "1", HORIZON, RECIPIENT);
        assertTrue(StellarMainnetPolicy.violations(false, HORIZON + "/", RECIPIENT, "0.1", enabled).isEmpty());
    }

    @Test
    public void mainnetRejectsOverLimitEndpointMismatchAndUnknownRecipient() {
        StellarMainnetPolicy.Config enabled = new StellarMainnetPolicy.Config(true, "1", HORIZON, RECIPIENT);
        List<String> errors = StellarMainnetPolicy.violations(
                false,
                "https://attacker.example",
                OTHER,
                "1.0000001",
                enabled
        );
        assertEquals(3, errors.size());
        assertTrue(errors.stream().anyMatch(error -> error.contains("endpoint")));
        assertTrue(errors.stream().anyMatch(error -> error.contains("limit")));
        assertTrue(errors.stream().anyMatch(error -> error.contains("allowlist")));
    }
}
