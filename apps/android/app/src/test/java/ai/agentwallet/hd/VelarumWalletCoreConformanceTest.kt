package ai.agentwallet.hd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import uniffi.velarum_wallet_core.FfiWalletException
import uniffi.velarum_wallet_core.stellarDerive
import uniffi.velarum_wallet_core.stellarSignPayment

/**
 * Conformance test for the SHARED Rust wallet core (crates/velarum-wallet-core),
 * reached from Android through the generated UniFFI Kotlin bindings + the host
 * shared library (loaded by JNA; see build.gradle test wiring).
 *
 * Proves on the real Android/Kotlin toolchain that:
 *  1. Android builds against and calls the shared core, and
 *  2. the core derives the SAME cross-platform golden Stellar address as iOS and
 *     the independent SEP-0005 reference (tests/fixtures/hd-derivation-golden.json).
 *
 * The app's own HDWallet/StellarTransfer are left unchanged for now; this test
 * exercises only the shared core, so integration is proven with zero production risk.
 */
class VelarumWalletCoreConformanceTest {
    private val goldenMnemonic =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    private val goldenAddress = "GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX"
    private val testnetPassphrase = "Test SDF Network ; September 2015"

    @Test
    fun coreDerivesGoldenStellarAddress() {
        val keys = stellarDerive(goldenMnemonic, "", 0u)
        assertEquals(
            "Shared Rust core derived a different Stellar address on Android — cross-platform drift",
            goldenAddress,
            keys.address
        )
        assertEquals("m/44'/148'/0'", keys.derivationPath)
        assertEquals(32, keys.publicKey.size)
        assertEquals(32, keys.secretSeed.size)
    }

    @Test
    fun coreSignsDeterministically() {
        val keys = stellarDerive(goldenMnemonic, "", 0u)
        val a = stellarSignPayment(keys.secretSeed, testnetPassphrase, 7L, keys.address, "1.5", "", "", false)
        val b = stellarSignPayment(keys.secretSeed, testnetPassphrase, 7L, keys.address, "1.5", "", "", false)
        assertEquals(a.envelopeBase64, b.envelopeBase64)
        assertEquals(64, a.txHashHex.length)
    }

    @Test
    fun coreRejectsMuxedDestination() {
        val keys = stellarDerive(goldenMnemonic, "", 0u)
        assertThrows(FfiWalletException::class.java) {
            stellarSignPayment(
                keys.secretSeed,
                testnetPassphrase,
                1L,
                "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK",
                "1",
                "",
                "",
                false
            )
        }
    }
}
