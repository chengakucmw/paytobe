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

    /** Gate for the signing flip: the shared core must sign the byte-identical
     *  transaction (same hash) as the native bouncycastle path. */
    @Test
    fun coreSigningMatchesNativeTransaction() {
        val keys = stellarDerive(goldenMnemonic, "", 0u)
        // (amountXlm, memo, createAccount)
        val cases = listOf(
            Triple("1.5", "", false),
            Triple("2.5", "exchange-note", false),
            Triple("3", "", true),
        )
        for ((amount, memo, create) in cases) {
            StellarTransfer.USE_SHARED_CORE_SIGNING = false
            val native = StellarTransfer.buildSignedEnvelope(
                keys.secretSeed, keys.publicKey, 42L, keys.address, amount, create, memo, true)
            StellarTransfer.USE_SHARED_CORE_SIGNING = true
            val core = StellarTransfer.buildSignedEnvelope(
                keys.secretSeed, keys.publicKey, 42L, keys.address, amount, create, memo, true)
            assertEquals("tx hash differs for $amount/$memo/$create", native.txHash, core.txHash)
            assertEquals(native.envelope64.substring(0, 120), core.envelope64.substring(0, 120))
        }
        StellarTransfer.USE_SHARED_CORE_SIGNING = true
    }

    /** Core EVM + Solana addresses must match Android's existing native HDWallet. */
    @Test
    fun coreEvmAndSolanaMatchNativeHdWallet() {
        val wallet = HDWallet.restore(goldenMnemonic)
        val coreEvm = uniffi.velarum_wallet_core.evmDerive(goldenMnemonic, "")
        val coreSol = uniffi.velarum_wallet_core.solanaDerive(goldenMnemonic, "")
        assertEquals(wallet.evm.address, coreEvm.address)
        assertEquals(wallet.solana.address, coreSol.address)
    }

    /** Core EVM signing must byte-match web3j (Android's native EVM signer). */
    @Test
    fun coreEvmSigningMatchesWeb3j() {
        val evm = uniffi.velarum_wallet_core.evmDerive(goldenMnemonic, "")
        val to = "0x000000000000000000000000000000000000dEaD"
        val credentials = org.web3j.crypto.Credentials.create(Hex.bytesToHex(evm.privateKey))
        val tx = org.web3j.crypto.RawTransaction.createEtherTransaction(
            java.math.BigInteger.ZERO, java.math.BigInteger("20000000000"),
            java.math.BigInteger.valueOf(21000), to, java.math.BigInteger("1000000000000000000"))
        val web3jRaw = org.web3j.utils.Numeric.toHexString(
            org.web3j.crypto.TransactionEncoder.signMessage(tx, 1L, credentials))
        val core = WalletCoreBridge.signEvm(
            evm.privateKey, 1L, 0L, "20000000000", 21000L, to, "1000000000000000000", "")
        assertEquals(web3jRaw, core.rawTxHex)
    }

    /** Core Solana signing must byte-match Android's native SolanaTransfer. */
    @Test
    fun coreSolanaSigningMatchesNative() {
        val sol = uniffi.velarum_wallet_core.solanaDerive(goldenMnemonic, "")
        val toAddr = "11111111111111111111111111111112"
        val blockhash = "11111111111111111111111111111111"
        val lamports = 1_000_000_000L
        val nativeMessage = SolanaTransfer.buildMessage(
            sol.publicKey, Base58.decode(toAddr), Base58.decode(blockhash), lamports)
        val nativeB64 = SolanaTransfer.encodeSignedTx(sol.secretSeed, nativeMessage)
        val core = WalletCoreBridge.signSolana(sol.secretSeed, toAddr, lamports, blockhash)
        assertEquals(nativeB64, core.transactionBase64)
    }
}
