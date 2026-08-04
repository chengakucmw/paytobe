package ai.agentwallet.hd

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ai.agentwallet.hd.ui.VelarumApp
import ai.agentwallet.hd.ui.navigation.Routes
import ai.agentwallet.hd.ui.onboarding.OnboardingHost
import ai.agentwallet.hd.ui.theme.VelarumTheme

/** 通知/深链进入 App 的入口意图（退役 MainActivity 后由本 Activity 接住并路由到原生屏）。 */
sealed class AppEntry {
    data object None : AppEntry()
    data class OpenPayment(val intentId: String) : AppEntry()
    data class OpenConnectInvitation(val invitationId: String) : AppEntry()
    data class DeepLink(val uri: String) : AppEntry()
}

/**
 * 原生 (Jetpack Compose) 宿主 + LAUNCHER + 通知/深链入口。WebView 与旧 MainActivity 均已退役。
 *  - 没钱包/未备份 → 原生开通流程；完成后进入原生主界面。
 *  - 已就绪 → 原生主界面（VelarumApp）。
 *  - 通知点击（EXTRA_OPEN_PAYMENT_INTENT_ID）→ 原生收件箱详情；
 *    深链 velarumpay://pair → 配对；agentwallet://relay|configure-relay|setup?url= → 配置 relay。
 *
 * enableEdgeToEdge() 拥抱边到边；继承 FragmentActivity 以便支付用 BiometricPrompt。
 */
class MainComposeActivity : FragmentActivity() {
    companion object {
        // 与旧 MainActivity 相同的 extra key，保证在途/历史 PendingIntent 仍能匹配。
        const val EXTRA_OPEN_PAYMENT_INTENT_ID = "ai.agentwallet.hd.OPEN_PAYMENT_INTENT_ID"
        const val EXTRA_OPEN_CONNECT_INVITATION_ID = "com.velarumpay.wallet.OPEN_CONNECT_INVITATION_ID"
    }

    private val pendingEntry = mutableStateOf<AppEntry>(AppEntry.None)

    // 一次性启动守卫：常驻推送服务每进程只启动一次（START_STICKY 自行续命）。
    private var relayServiceStarted = false

    // 运行时通知权限（Android 13+）。授予与否都继续——服务照常运行，仅在拒绝时不展示通知。
    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* no-op: service runs regardless */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        pendingEntry.value = parseEntry(intent)

        maybeRequestNotificationPermission()

        setContent {
            VelarumTheme {
                // 启动判定（是否已开通 + 起始路由）此前在首帧前同步读取加密存储，会阻塞主线程拖慢冷启动。
                // 现改为异步在 IO 线程读取：解析完成前显示与主题同色的中性占位，避免白屏或「先错屏再跳转」的闪烁。
                var gate by rememberSaveable { mutableStateOf<Boolean?>(null) }   // null = 判定中
                var startRoute by rememberSaveable { mutableStateOf(Routes.CREATE_WALLET) }
                LaunchedEffect(Unit) {
                    if (gate == null) {
                        val ctx = this@MainComposeActivity
                        val resolved = withContext(Dispatchers.IO) {
                            val has = WalletRepository.hasWallet(ctx)
                            val onboarded = has && WalletRepository.isBackupVerified(ctx)
                            onboarded to (if (has) Routes.KEY_BACKUP else Routes.CREATE_WALLET)
                        }
                        startRoute = resolved.second
                        gate = resolved.first
                    }
                }
                when (gate) {
                    true -> VelarumApp(entry = pendingEntry.value, onEntryHandled = { pendingEntry.value = AppEntry.None })
                    false -> OnboardingHost(startRoute = startRoute, onFinished = {
                        gate = true
                        ensureRelayServiceStarted()
                    })
                    null -> StartupPlaceholder()
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // 钱包 + relay 就绪后（含本次会话内刚配置好的）启动常驻推送服务；幂等、每进程一次。
        ensureRelayServiceStarted()
    }

    private fun maybeRequestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    /**
     * 启动常驻中继推送前台服务——仅当已有钱包且已配置 relay 时，且每进程仅一次。
     * 服务负责打开 WS、补拉漏掉的请求并发通知（START_STICKY 自行续命）。迁移到 Compose
     * 宿主时遗漏了这一步，导致 App 内永远收不到代理主动发起的付款请求。
     */
    private fun ensureRelayServiceStarted() {
        if (relayServiceStarted) return
        if (!WalletRepository.hasWallet(this)) return
        if (!WalletRepository.isRelayConfigured(this)) return
        try {
            ContextCompat.startForegroundService(this, Intent(this, RelayPushService::class.java))
            relayServiceStarted = true
        } catch (e: Exception) {
            VpLog.w("MainComposeActivity", "failed to start relay push service", e)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingEntry.value = parseEntry(intent)
    }

    private fun parseEntry(intent: Intent?): AppEntry {
        if (intent == null) return AppEntry.None
        val paymentId = intent.getStringExtra(EXTRA_OPEN_PAYMENT_INTENT_ID)
        if (!paymentId.isNullOrBlank()) return AppEntry.OpenPayment(paymentId.trim())
        val invitationId = intent.getStringExtra(EXTRA_OPEN_CONNECT_INVITATION_ID)
        if (!invitationId.isNullOrBlank()) return AppEntry.OpenConnectInvitation(invitationId.trim())
        val data = intent.data?.toString()
        if (!data.isNullOrBlank()) return AppEntry.DeepLink(data)
        return AppEntry.None
    }
}

/** 启动判定期间的中性占位：与主题背景同色的全屏面板，避免白屏或「先错屏再跳转」的闪烁。 */
@Composable
private fun StartupPlaceholder() {
    Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background))
}
