package ai.agentwallet.hd

import uniffi.velarum_wallet_core.evmSignTransaction
import uniffi.velarum_wallet_core.solanaSignTransfer
import uniffi.velarum_wallet_core.stellarDerive
import uniffi.velarum_wallet_core.stellarSignPayment

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

    /** Build + sign a Stellar payment / create-account via the shared core. */
    @JvmStatic
    fun signStellar(
        secretSeed: ByteArray,
        networkPassphrase: String,
        sequence: Long,
        destinationAddress: String,
        amountXlm: String,
        memo: String,
        memoType: String,
        createAccount: Boolean,
    ): SignedStellarCore {
        val s = stellarSignPayment(
            secretSeed, networkPassphrase, sequence, destinationAddress,
            amountXlm, memo, memoType, createAccount,
        )
        return SignedStellarCore(s.envelopeBase64, s.txHashHex, s.createAccount)
    }

    /** Build + sign a legacy EVM transaction via the shared core. */
    @JvmStatic
    fun signEvm(
        privateKey: ByteArray,
        chainId: Long,
        nonce: Long,
        gasPriceWei: String,
        gasLimit: Long,
        toAddress: String,
        valueWei: String,
        dataHex: String,
    ): EvmSignedCore {
        val s = evmSignTransaction(
            privateKey, chainId.toULong(), nonce.toULong(), gasPriceWei,
            gasLimit.toULong(), toAddress, valueWei, dataHex,
        )
        return EvmSignedCore(s.rawTxHex, s.txHashHex)
    }

    /** Build + sign a native SOL transfer via the shared core. */
    @JvmStatic
    fun signSolana(
        secretSeed: ByteArray,
        toAddress: String,
        lamports: Long,
        recentBlockhash: String,
    ): SolanaSignedCore {
        val s = solanaSignTransfer(secretSeed, toAddress, lamports.toULong(), recentBlockhash)
        return SolanaSignedCore(s.transactionBase64, s.signatureBase58)
    }
}

/** Plain holder so Java sees simple public fields. */
class StellarCoreKeys(
    @JvmField val address: String,
    @JvmField val publicKey: ByteArray,
    @JvmField val secretSeed: ByteArray,
    @JvmField val derivationPath: String,
)

/** Plain holder for a signed Stellar transaction. */
class SignedStellarCore(
    @JvmField val envelopeBase64: String,
    @JvmField val txHashHex: String,
    @JvmField val createAccount: Boolean,
)

/** Plain holder for a signed EVM transaction. */
class EvmSignedCore(
    @JvmField val rawTxHex: String,
    @JvmField val txHashHex: String,
)

/** Plain holder for a signed Solana transaction. */
class SolanaSignedCore(
    @JvmField val transactionBase64: String,
    @JvmField val signatureBase58: String,
)
