package ai.agentwallet.hd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class WalletNetworkValidatorTest {
    @Test
    public void parsesDecimalAndHexChainIds() {
        assertEquals(8453L, WalletNetworkValidator.parseFlexibleChainId("8453"));
        assertEquals(84532L, WalletNetworkValidator.parseFlexibleChainId("0x14A34"));
        assertTrue(WalletNetworkValidator.matchesRpcChainId("0x2105", 8453L));
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsPlainHttpRpcOutsideLocalDevelopment() {
        WalletNetworkValidator.buildVerifiedEvmConfig(
                "Unsafe",
                "http://example.com",
                "1",
                "ETH",
                "",
                WalletNetworkConfig.SOURCE_USER,
                false
        );
    }

    @Test
    public void permitsLocalDevelopmentHttpRpcWhenExplicitlyAllowed() {
        WalletNetworkConfig config = WalletNetworkValidator.buildVerifiedEvmConfig(
                "Local",
                "http://localhost:8545",
                "31337",
                "ETH",
                "",
                WalletNetworkConfig.SOURCE_USER,
                true
        );
        assertEquals(31337L, config.chainId);
        assertEquals("ETH", config.currencySymbol);
    }
}
