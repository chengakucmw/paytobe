package ai.agentwallet.hd

import android.content.Context
import android.net.Uri
import org.json.JSONObject

private const val IDENTITY_PREFS = "velarum_identity_prefs"
private const val KEY_NICKNAME = "nickname"
private const val KEY_AVATAR = "avatar"

/** 本地身份偏好（昵称/头像）——纯 UI 偏好，不涉及私钥/业务逻辑（类似 web 的 VelarumPrototypePrefs）。 */
internal object IdentityStore {
    private fun prefs(context: Context) = context.getSharedPreferences(IDENTITY_PREFS, Context.MODE_PRIVATE)
    fun nickname(context: Context): String = prefs(context).getString(KEY_NICKNAME, "").orEmpty().ifBlank { "My Wallet" }
    fun avatar(context: Context): String = prefs(context).getString(KEY_AVATAR, "").orEmpty().ifBlank { "V" }
    fun setNickname(context: Context, value: String) = prefs(context).edit().putString(KEY_NICKNAME, value.trim()).apply()
    fun setAvatar(context: Context, value: String) = prefs(context).edit().putString(KEY_AVATAR, value.trim()).apply()
}

/**
 * 设置簇读取门面：身份、网络、活动历史、设备/relay 信息、备份与通知状态。
 * 全部包裹包内私有逻辑（WalletNetworkStore / TransactionHistoryStore / PaymentInboxStore /
 * SecureWalletStore / PaymentNotifications），映射 public 模型。
 */
object SettingsRepository {

    fun identity(context: Context): IdentityUi {
        val wallet = WalletRepository.loadWalletState(context)
        return IdentityUi(
            name = IdentityStore.nickname(context),
            avatar = IdentityStore.avatar(context),
            walletId = wallet.walletId ?: "",
            evmAddress = wallet.evmAddress,
            solanaAddress = wallet.solanaAddress,
            stellarAddress = wallet.stellarAddress,
        )
    }

    fun setNickname(context: Context, name: String) = IdentityStore.setNickname(context, name)
    fun setAvatar(context: Context, avatar: String) = IdentityStore.setAvatar(context, avatar)

    fun networks(context: Context): List<NetworkUi> = try {
        WalletNetworkStore.all(context).map {
            NetworkUi(it.name, it.chainId, it.rpcUrl, it.currencySymbol, it.source, it.verificationStatus)
        }
    } catch (e: Exception) {
        emptyList()
    }

    /** 添加自定义 EVM 网络（格式校验在 buildVerifiedEvmConfig，失败抛错）。请在 IO 线程调用。 */
    fun addEvmNetwork(context: Context, name: String, rpcUrl: String, chainId: String, symbol: String, explorer: String) {
        val config = WalletNetworkValidator.buildVerifiedEvmConfig(name, rpcUrl, chainId, symbol, explorer, WalletNetworkConfig.SOURCE_USER, false)
        WalletNetworkStore.upsert(context, config)
    }

    fun activity(context: Context): List<ActivityUi> = try {
        TransactionHistoryStore.list(context).map { it.toActivityUi() }
    } catch (e: Exception) {
        emptyList()
    }

    fun deviceInfo(context: Context): DeviceInfoUi = DeviceInfoUi(
        deviceId = PaymentInboxStore.deviceId(context),
        relayUrl = PaymentInboxStore.relayUrl(context),
        deviceToken = PaymentInboxStore.deviceToken(context),
    )

    fun setRelayUrl(context: Context, url: String) = PaymentInboxStore.setRelayUrl(context, url)

    /**
     * 处理 agentwallet://relay|configure-relay|setup?url=... 深链：取出 relay URL，校验、保存并尝试注册。
     * 成功返回 URL，否则 null（对照旧 MainActivity.handleRelayConfigUri）。请在 IO 线程调用。
     */
    fun applyRelayConfigLink(context: Context, uri: String): String? {
        return try {
            val parsed = Uri.parse(uri)
            if (!"agentwallet".equals(parsed.scheme, ignoreCase = true)) return null
            val host = parsed.host?.lowercase()
            if (host != "relay" && host != "configure-relay" && host != "setup") return null
            val url = (parsed.getQueryParameter("url") ?: parsed.getQueryParameter("relay_url"))?.trim()
            if (url.isNullOrBlank() || !(url.startsWith("https://") || url.startsWith("http://"))) return null
            PaymentInboxStore.setRelayUrl(context, url)
            try { RelayClient.register(context) } catch (e: Exception) {}
            url
        } catch (e: Exception) {
            null
        }
    }

    private val DEFAULT_DISPLAYED = listOf("xlm", "sol", "eth", "base_usdc")

    /** Home 上展示哪些资产（本地偏好）。 */
    fun displayedKeys(context: Context): List<String> {
        val raw = context.getSharedPreferences(IDENTITY_PREFS, Context.MODE_PRIVATE).getString("displayed_keys", "").orEmpty()
        return if (raw.isBlank()) DEFAULT_DISPLAYED else raw.split(",").filter { it.isNotBlank() }
    }

    fun setDisplayedKeys(context: Context, keys: List<String>) {
        context.getSharedPreferences(IDENTITY_PREFS, Context.MODE_PRIVATE).edit()
            .putString("displayed_keys", keys.joinToString(",")).apply()
    }

    fun backupVerified(context: Context): Boolean = try { SecureWalletStore.isBackupVerified(context) } catch (e: Exception) { false }

    fun notificationsEnabled(context: Context): Boolean = try { PaymentNotifications.hasNotificationPermission(context) } catch (e: Exception) { false }

    private fun JSONObject.toActivityUi(): ActivityUi {
        val status = optString("status", "")
        val tone = when (status.lowercase()) {
            "confirmed", "broadcasted" -> "safe"
            "failed", "rejected" -> "danger"
            // 过期态走独立语气（灰+时钟，EXPIRED），与 info(蓝) 区分。
            "expired", "cancelled" -> "expired"
            else -> "info"
        }
        val network = optString("network", "")
        return ActivityUi(
            title = optString("title", "Transfer"),
            subtitle = listOf(status, network).filter { it.isNotBlank() }.joinToString(" · "),
            amount = (optString("amount", "") + " " + optString("asset", "")).trim(),
            tone = tone,
            asset = optString("asset", ""),
        )
    }
}

data class IdentityUi(
    val name: String,
    val avatar: String,
    val walletId: String,
    val evmAddress: String?,
    val solanaAddress: String?,
    val stellarAddress: String?,
)

data class NetworkUi(
    val name: String,
    val chainId: Long,
    val rpcUrl: String,
    val symbol: String,
    val source: String,
    val verificationStatus: String,
)

data class ActivityUi(val title: String, val subtitle: String, val amount: String, val tone: String, val asset: String)

data class DeviceInfoUi(val deviceId: String, val relayUrl: String, val deviceToken: String)
