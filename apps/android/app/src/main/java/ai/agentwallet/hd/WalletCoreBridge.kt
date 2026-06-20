package ai.agentwallet.hd

import uniffi.velarum_wallet_core.stellarDerive

/**
 * Java-friendly bridge to the shared Rust wallet core (crates/velarum-wallet-core).
 *
 * Exists so [HDWallet] (Java) can call the UniFFI Kotlin API without tripping over
 * Kotlin's `UInt` name-mangling — the core's `account` parameter is a Rust u32,
 * which Kotlin exposes as `UInt` and mangles the JVM method name for.
 */
object WalletCoreBridge {
    /** Derive the Stellar account at m/44'/148'/account' via the shared core. */
    @JvmStatic
    fun deriveStellar(mnemonic: String, account: Int): StellarCoreKeys {
        val k = stellarDerive(mnemonic, "", account.toUInt())
        return StellarCoreKeys(k.address, k.publicKey, k.secretSeed, k.derivationPath)
    }
}

/** Plain holder so Java sees simple public fields. */
class StellarCoreKeys(
    @JvmField val address: String,
    @JvmField val publicKey: ByteArray,
    @JvmField val secretSeed: ByteArray,
    @JvmField val derivationPath: String,
)
