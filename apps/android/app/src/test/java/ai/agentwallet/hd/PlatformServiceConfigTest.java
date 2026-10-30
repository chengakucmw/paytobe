package ai.agentwallet.hd;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeFalse;
import static org.junit.Assume.assumeTrue;

public final class PlatformServiceConfigTest {
    @Test
    public void standardAndStellarTestnetDebugUseOnlyOfficialManagedOrigin() {
        assumeFalse(BuildConfig.INTERNAL_PLATFORM_OVERRIDE_ENABLED);
        assertTrue(BuildConfig.OFFICIAL_TESTNET_ONLY);
        assertTrue(PlatformServiceConfig.isManaged());
        assertFalse(PlatformServiceConfig.isUnofficialEnvironment());
        assertFalse(PlatformServiceConfig.supportsWebSocket());
        assertEquals(
                PlatformServiceConfig.OFFICIAL_TESTNET_ORIGIN,
                PlatformServiceConfig.baseUrl("https://attacker.example")
        );
    }

    @Test
    public void internalDebugVariantIsUnmanagedAndVisiblyUnofficial() {
        assumeTrue(BuildConfig.INTERNAL_PLATFORM_OVERRIDE_ENABLED);
        assertFalse(PlatformServiceConfig.isManaged());
        assertTrue(PlatformServiceConfig.isUnofficialEnvironment());
        assertTrue(PlatformServiceConfig.supportsWebSocket());
        assertTrue(PlatformServiceConfig.environmentLabel(
                PlatformServiceConfig.baseUrl("https://platform-dev.paytobe.com"), true
        ).contains("Unofficial environment"));
    }

    @Test
    public void officialBuildFailsClosedWhenBuildConfigOriginIsMissingOrChanged() {
        assertThrows(IllegalStateException.class,
                () -> PlatformServiceConfig.baseUrl("", "", false));
        assertThrows(IllegalStateException.class,
                () -> PlatformServiceConfig.baseUrl("https://temporary.example", "", false));
        assertThrows(IllegalStateException.class,
                () -> PlatformServiceConfig.baseUrl("http://api.paytobe.com", "", false));
    }

    @Test
    public void ordinaryBuildIgnoresEveryUserOverride() {
        for (String override : new String[] {
                "http://127.0.0.1:8787",
                "https://192.168.1.10",
                "https://paytobe-connect-testnet.chengakucmw.chatgpt.site",
                "https://api.paytobe.com"
        }) {
            assertEquals(PlatformServiceConfig.OFFICIAL_TESTNET_ORIGIN,
                    PlatformServiceConfig.baseUrl(PlatformServiceConfig.OFFICIAL_TESTNET_ORIGIN, override, false));
        }
    }

    @Test
    public void internalDebugOverrideStillRejectsCleartextLanAndTemporaryHosts() {
        for (String override : new String[] {
                "http://platform.dev.paytobe.com",
                "https://127.0.0.1",
                "https://192.168.1.10",
                "https://platform",
                "https://platform.local",
                "https://platform.lan",
                "https://preview.trycloudflare.com",
                "https://paytobe-connect-testnet.chengakucmw.chatgpt.site",
                "https://platform.dev.paytobe.com/path"
        }) {
            assertThrows(override, IllegalStateException.class,
                    () -> PlatformServiceConfig.baseUrl(PlatformServiceConfig.OFFICIAL_TESTNET_ORIGIN, override, true));
        }
    }

    @Test
    public void internalDebugAllowsStableHttpsAndIsVisiblyUnofficial() {
        String resolved = PlatformServiceConfig.baseUrl(
                PlatformServiceConfig.OFFICIAL_TESTNET_ORIGIN,
                "https://platform-dev.paytobe.com/",
                true
        );
        assertEquals("https://platform-dev.paytobe.com", resolved);
        assertTrue(PlatformServiceConfig.environmentLabel(resolved, true).contains("Unofficial environment"));
        assertEquals("Official testnet",
                PlatformServiceConfig.environmentLabel(PlatformServiceConfig.OFFICIAL_TESTNET_ORIGIN, false));
    }
}
