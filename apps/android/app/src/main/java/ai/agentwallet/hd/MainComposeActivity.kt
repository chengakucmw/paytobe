package ai.agentwallet.hd

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.fragment.app.FragmentActivity
import ai.agentwallet.hd.ui.VelarumApp
import ai.agentwallet.hd.ui.navigation.Routes
import ai.agentwallet.hd.ui.onboarding.OnboardingHost
import ai.agentwallet.hd.ui.theme.VelarumTheme

/** 通知/深链进入 App 的入口意图（退役 MainActivity 后由本 Activity 接住并路由到原生屏）。 */
sealed class AppEntry {
    data object None : AppEntry()
    data class OpenPayment(val intentId: String) : AppEntry()
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
    }

    private val pendingEntry = mutableStateOf<AppEntry>(AppEntry.None)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        pendingEntry.value = parseEntry(intent)

        val initiallyOnboarded = WalletRepository.hasWallet(this) && WalletRepository.isBackupVerified(this)
        val startRoute = if (WalletRepository.hasWallet(this)) Routes.KEY_BACKUP else Routes.CREATE_WALLET

        setContent {
            VelarumTheme {
                var onboarded by rememberSaveable { mutableStateOf(initiallyOnboarded) }
                if (onboarded) {
                    VelarumApp(entry = pendingEntry.value, onEntryHandled = { pendingEntry.value = AppEntry.None })
                } else {
                    OnboardingHost(startRoute = startRoute, onFinished = { onboarded = true })
                }
            }
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
        val data = intent.data?.toString()
        if (!data.isNullOrBlank()) return AppEntry.DeepLink(data)
        return AppEntry.None
    }
}
