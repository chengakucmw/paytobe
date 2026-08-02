package ai.agentwallet.hd.ui.wallet

import ai.agentwallet.hd.AddressFormat

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import ai.agentwallet.hd.AssetBalance
import ai.agentwallet.hd.SettingsRepository
import ai.agentwallet.hd.WalletRepository
import ai.agentwallet.hd.WalletState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
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
    val refreshError: String? = null,
    val completedRefreshCount: Long = 0,
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
    private var refreshJob: Job? = null
    private var refreshAgain = false

    init {
        startRefresh(loadCachedFirst = true)
    }

    private fun startRefresh(loadCachedFirst: Boolean) {
        if (refreshJob?.isActive == true) {
            // A lifecycle/route/manual refresh that arrives during an in-flight request must
            // not be dropped. Run one more pass after the current request completes.
            if (!loadCachedFirst) refreshAgain = true
            return
        }
        refreshJob = viewModelScope.launch {
            if (loadCachedFirst) {
                publishSnapshot(refreshing = false, topLevelFailure = null, completedRefresh = false)
            }
            do {
                refreshAgain = false
                _ui.update { it.copy(refreshing = true, refreshError = null) }
                val failure = withContext(Dispatchers.IO) {
                    runCatching { WalletRepository.refreshBalances(getApplication()) }.exceptionOrNull()
                }
                publishSnapshot(refreshing = false, topLevelFailure = failure, completedRefresh = true)
            } while (refreshAgain)
        }
    }

    fun refresh() {
        startRefresh(loadCachedFirst = false)
    }

    private suspend fun publishSnapshot(
        refreshing: Boolean,
        topLevelFailure: Throwable?,
        completedRefresh: Boolean,
    ) {
        val state = withContext(Dispatchers.IO) { WalletRepository.loadWalletState(getApplication()) }
        val keys = withContext(Dispatchers.IO) { SettingsRepository.displayedKeys(getApplication()) }
        val hasAssetFailure = state.balances.values.any { it.status == "error" }
        val error = if (topLevelFailure != null || hasAssetFailure) {
            "Balance refresh failed. Check your connection and try again."
        } else {
            null
        }
        _ui.update {
            it.copy(
                refreshing = refreshing,
                loading = false,
                refreshError = error,
                completedRefreshCount = if (completedRefresh) it.completedRefreshCount + 1 else it.completedRefreshCount,
                wallet = state,
                displayedKeys = keys,
            )
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

/** Home 资产的 UI 装饰（余额键 / 地址族 / 品牌色），按 rail 关联到注册表正本。 */
private data class HomeAssetSpec(
    val rail: String,
    val balanceKey: String,
    val addressKind: AddressKind,
    val markColor: Long,
)

private val HOME_ASSET_SPECS: List<HomeAssetSpec> = listOf(
    HomeAssetSpec("stellar_xlm", "xlm", AddressKind.STELLAR, 0xFF3E78A6),
    HomeAssetSpec("solana_sol", "sol", AddressKind.SOLANA, 0xFF7E5BD0),
    HomeAssetSpec("ethereum_eth", "eth", AddressKind.EVM, 0xFF5C6359),
    HomeAssetSpec("base_usdc", "base_usdc", AddressKind.EVM, 0xFF2E7D43),
)

// 单一事实来源：symbol / chain 一律取自 WalletRepository.transferAssets()（= 包内 TransferAssetRegistry 正本），
// 首页不再硬编码资产名 / 链名，从根上杜绝与注册表漂移。UI 字段（余额键 / 地址族 / 色）仍按 rail 装饰。
val HOME_ASSETS: List<DisplayAsset> = run {
    val catalog = WalletRepository.transferAssets().associateBy { it.rail }
    HOME_ASSET_SPECS.mapNotNull { spec ->
        catalog[spec.rail]?.let { opt ->
            DisplayAsset(opt.symbol, opt.chain, spec.balanceKey, spec.addressKind, spec.markColor)
        }
    }
}

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

enum class BalanceCondition { AVAILABLE, ZERO, INACTIVE, ERROR, UNKNOWN }

fun balanceCondition(bal: AssetBalance?): BalanceCondition = when {
    bal == null -> BalanceCondition.UNKNOWN
    bal.status == "error" -> BalanceCondition.ERROR
    bal.status == "inactive" -> BalanceCondition.INACTIVE
    bal.status != "ok" -> BalanceCondition.UNKNOWN
    bal.balance.toBigDecimalOrNull()?.signum() == 0 -> BalanceCondition.ZERO
    bal.balance.toBigDecimalOrNull()?.signum() == 1 -> BalanceCondition.AVAILABLE
    else -> BalanceCondition.UNKNOWN
}

/** Never present an unfunded account or a failed request as a confirmed zero balance. */
fun displayBalance(bal: AssetBalance?): String {
    if (balanceCondition(bal) !in setOf(BalanceCondition.AVAILABLE, BalanceCondition.ZERO)) return "—"
    val b = bal?.balance.orEmpty()
    return if (b.isBlank() || b == "--") "—" else b
}

fun balanceStatusLabel(bal: AssetBalance?): String = when (balanceCondition(bal)) {
    BalanceCondition.AVAILABLE -> "In wallet"
    BalanceCondition.ZERO -> "Zero balance"
    BalanceCondition.INACTIVE -> "Account not activated"
    BalanceCondition.ERROR -> "Refresh failed"
    BalanceCondition.UNKNOWN -> "Not refreshed"
}

fun totalUsd(wallet: WalletState): Double? {
    if (HOME_ASSETS.any { balanceCondition(wallet.balances[it.balanceKey]) in setOf(BalanceCondition.ERROR, BalanceCondition.UNKNOWN) }) {
        return null
    }
    return HOME_ASSETS.sumOf { asset ->
        val amount = displayBalance(wallet.balances[asset.balanceKey]).toDoubleOrNull() ?: 0.0
        amount * (UNIT_USD[asset.symbol] ?: 0.0)
    }
}

fun formatUsd(value: Double): String = String.format(Locale.US, "%,.2f", if (value.isFinite()) value else 0.0)

/** 单笔金额的近似法币估值（用于发送复核页的 ≈ $X）。 */
fun fiatUsd(symbol: String, amount: String): Double {
    val value = amount.toDoubleOrNull() ?: return 0.0
    return value * (UNIT_USD[symbol] ?: 0.0)
}

// Delegates to the shared AddressFormat (D9/Q5) — single home for address shortening.
fun shortAddress(addr: String?): String = AddressFormat.shortAddress(addr)
