package ai.agentwallet.hd

import com.sun.jna.Library
import com.sun.jna.Native
import com.sun.jna.NativeLong
import com.sun.jna.Pointer
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.util.Base64

/** Java-friendly adapter for the versioned C ABI exported by the Rust wallet core. */
object WalletCoreBridge {
    private const val EXPECTED_ABI_VERSION = 1
    private const val MAX_RESPONSE_BYTES = 1024 * 1024

    private interface WalletCoreNative : Library {
        fun velarum_wallet_core_abi_version(): Int

        fun velarum_wallet_core_call(
            method: ByteArray,
            methodLen: NativeLong,
            request: ByteArray,
            requestLen: NativeLong,
        ): Pointer?

        fun velarum_wallet_core_result_data(result: Pointer): Pointer?
        fun velarum_wallet_core_result_len(result: Pointer): NativeLong
        fun velarum_wallet_core_result_free(result: Pointer)
    }

    private val native: WalletCoreNative by lazy {
        Native.load("velarum_wallet_core", WalletCoreNative::class.java).also { core ->
            val actual = core.velarum_wallet_core_abi_version()
            check(actual == EXPECTED_ABI_VERSION) {
                "Unsupported wallet-core ABI $actual; expected $EXPECTED_ABI_VERSION."
            }
        }
    }

    private fun call(method: String, request: JSONObject): JSONObject {
        val methodBytes = method.toByteArray(StandardCharsets.UTF_8)
        val requestBytes = request.toString().toByteArray(StandardCharsets.UTF_8)
        val result = native.velarum_wallet_core_call(
            methodBytes,
            NativeLong(methodBytes.size.toLong()),
            requestBytes,
            NativeLong(requestBytes.size.toLong()),
        ) ?: throw WalletCoreException("native_null", "Wallet core returned a null result handle.")

        try {
            val length = native.velarum_wallet_core_result_len(result).toLong()
            if (length <= 0 || length > MAX_RESPONSE_BYTES) {
                throw WalletCoreException("invalid_response", "Wallet core returned an invalid response length.")
            }
            val data = native.velarum_wallet_core_result_data(result)
                ?: throw WalletCoreException("invalid_response", "Wallet core returned a null response pointer.")
            val response = JSONObject(String(data.getByteArray(0, length.toInt()), StandardCharsets.UTF_8))
            if (!response.optBoolean("ok", false)) {
                val error = response.optJSONObject("error")
                throw WalletCoreException(
                    error?.optString("code", "wallet_core_error") ?: "wallet_core_error",
                    error?.optString("message", "Wallet core rejected the request.")
                        ?: "Wallet core rejected the request.",
                )
            }
            return response.getJSONObject("value")
        } finally {
            native.velarum_wallet_core_result_free(result)
        }
    }

    private fun encodeSecret(secret: ByteArray): String = Base64.getEncoder().encodeToString(secret)
    private fun decodeSecret(encoded: String): ByteArray = Base64.getDecoder().decode(encoded)

    /** Derive the Stellar account at m/44'/148'/account' via the shared core. */
    @JvmStatic
    fun deriveStellar(mnemonic: String, account: Int): StellarCoreKeys {
        require(account >= 0) { "Stellar account index must not be negative." }
        val value = call(
            "stellar_derive",
            JSONObject()
                .put("mnemonic", mnemonic)
                .put("passphrase", "")
                .put("account", account),
        )
        return StellarCoreKeys(
            value.getString("address"),
            decodeSecret(value.getString("publicKey")),
            decodeSecret(value.getString("secretSeed")),
            value.getString("derivationPath"),
        )
    }

    /** Derive the EVM account at m/44'/60'/0'/0/0 via the shared core. */
    @JvmStatic
    fun deriveEvm(mnemonic: String): EvmCoreKeys {
        val value = call(
            "evm_derive",
            JSONObject().put("mnemonic", mnemonic).put("passphrase", ""),
        )
        return EvmCoreKeys(
            value.getString("address"),
            decodeSecret(value.getString("privateKey")),
            value.getString("derivationPath"),
        )
    }

    /** Derive the Solana account at m/44'/501'/0'/0' via the shared core. */
    @JvmStatic
    fun deriveSolana(mnemonic: String): SolanaCoreKeys {
        val value = call(
            "solana_derive",
            JSONObject().put("mnemonic", mnemonic).put("passphrase", ""),
        )
        return SolanaCoreKeys(
            value.getString("address"),
            decodeSecret(value.getString("publicKey")),
            decodeSecret(value.getString("secretSeed")),
            value.getString("derivationPath"),
        )
    }

    /** Fail closed if a recognized Horizon host contradicts the declared network. */
    @JvmStatic
    fun assertStellarNetwork(horizonHost: String, testnet: Boolean) {
        call(
            "stellar_assert_network_consistency",
            JSONObject().put("host", horizonHost).put("testnet", testnet),
        )
    }

    /** Parse an XLM decimal amount into exact stroops in the shared core. */
    @JvmStatic
    fun xlmToStroops(amount: String): Long = call(
        "stellar_xlm_to_stroops",
        JSONObject().put("amount", amount),
    ).getString("stroops").toLong()

    /** Build and sign a Stellar payment or create-account operation. */
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
        val value = call(
            "stellar_sign_payment",
            JSONObject()
                .put("secretSeed", encodeSecret(secretSeed))
                .put("networkPassphrase", networkPassphrase)
                .put("sequence", sequence.toString())
                .put("destinationAddress", destinationAddress)
                .put("amountXlm", amountXlm)
                .put("memo", memo)
                .put("memoType", memoType)
                .put("createAccount", createAccount),
        )
        return SignedStellarCore(
            value.getString("envelopeBase64"),
            value.getString("txHashHex"),
            value.getBoolean("createAccount"),
        )
    }

    /** Build and sign a legacy EVM transaction via the shared core. */
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
        require(chainId >= 0 && nonce >= 0 && gasLimit >= 0) { "EVM numeric inputs must not be negative." }
        val value = call(
            "evm_sign_transaction",
            JSONObject()
                .put("privateKey", encodeSecret(privateKey))
                .put("chainId", chainId.toString())
                .put("nonce", nonce.toString())
                .put("gasPriceWei", gasPriceWei)
                .put("gasLimit", gasLimit.toString())
                .put("toAddress", toAddress)
                .put("valueWei", valueWei)
                .put("dataHex", dataHex),
        )
        return EvmSignedCore(value.getString("rawTxHex"), value.getString("txHashHex"))
    }

    /** Build and sign a native SOL transfer via the shared core. */
    @JvmStatic
    fun signSolana(
        secretSeed: ByteArray,
        toAddress: String,
        lamports: Long,
        recentBlockhash: String,
    ): SolanaSignedCore {
        require(lamports >= 0) { "Lamports must not be negative." }
        val value = call(
            "solana_sign_transfer",
            JSONObject()
                .put("secretSeed", encodeSecret(secretSeed))
                .put("toAddress", toAddress)
                .put("lamports", lamports.toString())
                .put("recentBlockhash", recentBlockhash),
        )
        return SolanaSignedCore(value.getString("transactionBase64"), value.getString("signatureBase58"))
    }

    /** Build and sign an SPL transferChecked, optionally creating the destination ATA. */
    @JvmStatic
    fun signSplToken(
        secretSeed: ByteArray,
        sourceTokenAccount: String,
        destinationTokenAccount: String,
        mintAddress: String,
        recipientWallet: String,
        amountBaseUnits: String,
        decimals: Int,
        recentBlockhash: String,
        createDestinationAta: Boolean,
    ): SolanaSignedCore {
        require(decimals in 0..255) { "SPL decimals must be between 0 and 255." }
        val value = call(
            "solana_sign_spl_transfer",
            JSONObject()
                .put("secretSeed", encodeSecret(secretSeed))
                .put("sourceTokenAccount", sourceTokenAccount)
                .put("destinationTokenAccount", destinationTokenAccount)
                .put("mintAddress", mintAddress)
                .put("recipientWallet", recipientWallet)
                .put("amountBaseUnits", amountBaseUnits)
                .put("decimals", decimals)
                .put("recentBlockhash", recentBlockhash)
                .put("createDestinationAta", createDestinationAta),
        )
        return SolanaSignedCore(value.getString("transactionBase64"), value.getString("signatureBase58"))
    }
}

class WalletCoreException(@JvmField val code: String, message: String) : IllegalStateException(message)

class StellarCoreKeys(
    @JvmField val address: String,
    @JvmField val publicKey: ByteArray,
    @JvmField val secretSeed: ByteArray,
    @JvmField val derivationPath: String,
)

class EvmCoreKeys(
    @JvmField val address: String,
    @JvmField val privateKey: ByteArray,
    @JvmField val derivationPath: String,
)

class SolanaCoreKeys(
    @JvmField val address: String,
    @JvmField val publicKey: ByteArray,
    @JvmField val secretSeed: ByteArray,
    @JvmField val derivationPath: String,
)

class SignedStellarCore(
    @JvmField val envelopeBase64: String,
    @JvmField val txHashHex: String,
    @JvmField val createAccount: Boolean,
)

class EvmSignedCore(
    @JvmField val rawTxHex: String,
    @JvmField val txHashHex: String,
)

class SolanaSignedCore(
    @JvmField val transactionBase64: String,
    @JvmField val signatureBase58: String,
)
