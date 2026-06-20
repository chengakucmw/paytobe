package ai.agentwallet.hd.ui.wallet

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import ai.agentwallet.hd.AssetBalance
import ai.agentwallet.hd.SettingsRepository
import ai.agentwallet.hd.WalletRepository
import ai.agentwallet.hd.WalletState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale

/** Home / Receive 的共享 UI 状态。 */
data class WalletUiState(
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val wallet: WalletState = EMPTY_WALLET,
    val displayedKeys: List<String> = listOf("xlm", "sol", "eth", "base_usdc"),
) {
    companion object {
        val EMPTY_WALLET = WalletState(
            hasWallet = false,
            backupVerified = false,
            evmAddress = null,
            solanaAddress = null,
            stellarAddress = null,
            walletId = null,
            walletName = "My Wallet",
            avatar = "V",
            balances = emptyMap(),
        )
    }
}

/**
 * Home / Receive 共享的 ViewModel：先读缓存（loadWalletState），再联网刷新（refreshBalances）。
 * 全部走门面层 WalletRepository，逻辑不变。重活在 Dispatchers.IO。
 */
class WalletViewModel(app: Application) : AndroidViewModel(app) {

    private val _ui = MutableStateFlow(WalletUiState())
    val ui: StateFlow<WalletUiState> = _ui.asStateFlow()

    init {
        reloadCached()
        refresh()
    }

    private fun reloadCached() {
        viewModelScope.launch {
            val state = withContext(Dispatchers.IO) { WalletRepository.loadWalletState(getApplication()) }
            val keys = withContext(Dispatchers.IO) { SettingsRepository.displayedKeys(getApplication()) }
            _ui.update { it.copy(loading = false, wallet = state, displayedKeys = keys) }
        }
    }

    fun refresh() {
        if (_ui.value.refreshing) return
        _ui.update { it.copy(refreshing = true) }
        viewModelScope.launch {
            withContext(Dispatchers.IO) { runCatching { WalletRepository.refreshBalances(getApplication()) } }
            val state = withContext(Dispatchers.IO) { WalletRepository.loadWalletState(getApplication()) }
            val keys = withContext(Dispatchers.IO) { SettingsRepository.displayedKeys(getApplication()) }
            _ui.update { it.copy(refreshing = false, loading = false, wallet = state, displayedKeys = keys) }
        }
    }
}

// ---------------- 展示模型与纯函数 ----------------

enum class AddressKind { EVM, SOLANA, STELLAR }

/** Home 默认展示的真实、可发送资产（对照 web 的 HOME_PAIRS + app-bridge 的 BAL_MAP）。 */
data class DisplayAsset(
    val symbol: String,
    val chain: String,
    val balanceKey: String,
    val addressKind: AddressKind,
    val markColor: Long,
)

val HOME_ASSETS: List<DisplayAsset> = listOf(
    DisplayAsset("XLM", "Stellar", "xlm", AddressKind.STELLAR, 0xFF3E78A6),
    DisplayAsset("SOL", "Solana", "sol", AddressKind.SOLANA, 0xFF7E5BD0),
    DisplayAsset("ETH", "Ethereum", "eth", AddressKind.EVM, 0xFF5C6359),
    DisplayAsset("USDC", "Base", "base_usdc", AddressKind.EVM, 0xFF2E7D43),
)

fun assetByKey(key: String): DisplayAsset? = HOME_ASSETS.firstOrNull { it.balanceKey == key }

/** 近似单价（仅用于从真实余额估算总额；无实时行情，对照 web 的 assetUnitUsd）。 */
private val UNIT_USD: Map<String, Double> = mapOf(
    "USDC" to 1.0, "USDT" to 1.0, "DAI" to 1.0,
    "XLM" to 0.11, "SOL" to 150.0, "ETH" to 2400.0,
    "BTC" to 65000.0, "POL" to 0.45, "MATIC" to 0.45,
)

fun addressFor(kind: AddressKind, wallet: WalletState): String? = when (kind) {
    AddressKind.EVM -> wallet.evmAddress
    AddressKind.SOLANA -> wallet.solanaAddress
    AddressKind.STELLAR -> wallet.stellarAddress
}

/** error / inactive / 空 一律按 0 显示（对照 app-bridge 的归一化）。 */
fun displayBalance(bal: AssetBalance?): String {
    if (bal == null) return "0"
    if (bal.status == "error" || bal.status == "inactive") return "0"
    val b = bal.balance
    return if (b.isBlank() || b == "--") "0" else b
}

fun totalUsd(wallet: WalletState): Double = HOME_ASSETS.sumOf { asset ->
    val amount = displayBalance(wallet.balances[asset.balanceKey]).toDoubleOrNull() ?: 0.0
    amount * (UNIT_USD[asset.symbol] ?: 0.0)
}

fun formatUsd(value: Double): String = String.format(Locale.US, "%,.2f", if (value.isFinite()) value else 0.0)

/** 单笔金额的近似法币估值（用于发送复核页的 ≈ $X）。 */
fun fiatUsd(symbol: String, amount: String): Double {
    val value = amount.toDoubleOrNull() ?: return 0.0
    return value * (UNIT_USD[symbol] ?: 0.0)
}

fun shortAddress(addr: String?): String {
    if (addr.isNullOrBlank()) return "—"
    if (addr.length <= 12) return addr
    return addr.substring(0, 6) + "…" + addr.substring(addr.length - 4)
}
