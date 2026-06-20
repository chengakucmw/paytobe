package ai.agentwallet.hd

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

/**
 * 新的原生 (Jetpack Compose) 宿主 + LAUNCHER。
 *
 * Phase 3 起：
 *  - 没钱包/未备份 → 原生开通流程；完成后进入原生主界面（不再整体 bounce 到 WebView）。
 *  - 已就绪 → 直接进入原生主界面（Home/Receive 已原生）。
 *  - 主界面里尚未迁移的入口（Inbox/Profile/Send/扫码/资产子页）通过 openWebApp() 临时 hand-off
 *    到 WebView；不 finish 本 Activity，所以从 WebView 返回会回到原生主界面。
 *
 * enableEdgeToEdge() 拥抱边到边；继承 FragmentActivity 以便后续发送流程用 BiometricPrompt。
 */
class MainComposeActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        val initiallyOnboarded = WalletRepository.hasWallet(this) && WalletRepository.isBackupVerified(this)
        val startRoute = if (WalletRepository.hasWallet(this)) Routes.KEY_BACKUP else Routes.CREATE_WALLET

        setContent {
            VelarumTheme {
                var onboarded by rememberSaveable { mutableStateOf(initiallyOnboarded) }
                if (onboarded) {
                    VelarumApp()
                } else {
                    OnboardingHost(startRoute = startRoute, onFinished = { onboarded = true })
                }
            }
        }
    }
}
