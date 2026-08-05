package ai.agentwallet.hd.ui.wallet

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import ai.agentwallet.hd.BuildConfig
import ai.agentwallet.hd.SettingsRepository
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpFactRow
import ai.agentwallet.hd.ui.components.VpMenuRow
import ai.agentwallet.hd.ui.components.VpPrimaryButton
import ai.agentwallet.hd.ui.components.VpRiskBanner
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.VpTone
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumTheme

/** 设置入口（原生）。对照 web 的 renderSettings。 */
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onSecurity: () -> Unit,
    onNetworks: () -> Unit,
    onNotifications: () -> Unit,
    onDisplayLanguage: () -> Unit,
    onDeveloper: () -> Unit,
    onActivity: () -> Unit,
) {
    val context = LocalContext.current
    val backup = remember { SettingsRepository.backupVerified(context) }
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Profile", title = "Settings", onBack = onBack)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            VpMenuRow("Security", "Seed phrase, backup, import", onSecurity, badgeText = if (backup) "Verified" else "Review", badgeTone = if (backup) VpTone.SAFE else VpTone.CAUTION)
            VpMenuRow("Networks", "Networks and RPC endpoints", onNetworks)
            VpMenuRow("Notifications", "Payment requests and confirmations", onNotifications)
            VpMenuRow("Display & language", "Language and text size", onDisplayLanguage)
            if (!BuildConfig.MANAGED_PLATFORM_SERVICE) {
                VpMenuRow("Developer", "Device, Platform API, and local pairing", onDeveloper)
            }
            VpMenuRow("Activity", "Transfer history", onActivity)
        }
    }
}

/** 安全（原生）。对照 web 的 renderSecurity（只读事实 + 提示，敏感操作经各自流程）。 */
@Composable
fun SecurityScreen(onBack: () -> Unit, onRecoveryPhrase: () -> Unit) {
    val context = LocalContext.current
    val backup = remember { SettingsRepository.backupVerified(context) }
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Settings", title = "Security", onBack = onBack)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            VpCard(modifier = Modifier.fillMaxWidth()) {
                Text("Seed phrase wallet", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                VpFactRow("Key source", "24-word BIP-39")
                VpFactRow("Local storage", "Encrypted keyring")
                VpFactRow("Backend key shares", "Not provided")
                VpFactRow("Backup status", if (backup) "Verified" else "Needs verification", if (backup) VpTone.SAFE else VpTone.CAUTION)
            }
            VpMenuRow(
                title = "Show recovery phrase",
                subtitle = "Authenticate to view it securely on this device",
                onClick = onRecoveryPhrase,
                badgeText = "Protected",
                badgeTone = VpTone.CAUTION,
            )
            VpRiskBanner(VpTone.SAFE, "Agents and servers never see the seed", "Approved agents can create requests only. The recovery phrase, seed, and final signature stay local on this device.")
        }
    }
}

/** 显示与语言（原生）。英文-only 构建，信息性页面。 */
@Composable
fun DisplayLanguageScreen(onBack: () -> Unit) {
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Settings", title = "Display & language", onBack = onBack)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            VpCard(modifier = Modifier.fillMaxWidth()) {
                VpFactRow("Language", "English")
                VpFactRow("Locale", "en")
            }
            VpRiskBanner(VpTone.INFO, "English UI", "This build ships English only (resourceConfigurations = en). Additional languages can be added later.")
        }
    }
}

/** 通知（原生）。状态 + 申请 POST_NOTIFICATIONS 权限。 */
@Composable
fun NotificationsScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    var enabled by remember { mutableStateOf(SettingsRepository.notificationsEnabled(context)) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> enabled = granted }
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Settings", title = "Notifications", onBack = onBack)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            VpCard(modifier = Modifier.fillMaxWidth()) {
                VpFactRow("Status", if (enabled) "Enabled" else "Disabled", if (enabled) VpTone.SAFE else VpTone.CAUTION)
                VpFactRow("Payment requests", "Alert when an agent asks you to review a payment")
                VpFactRow("Confirmations", "Tell you when a local signature completes")
            }
            if (!enabled) {
                VpPrimaryButton("Enable notifications", onClick = { launcher.launch(Manifest.permission.POST_NOTIFICATIONS) }, modifier = Modifier.fillMaxWidth())
            }
            VpRiskBanner(VpTone.INFO, "Quiet by default", "Notifications are factual: who requested, what amount, which network, and whether local signing is required.")
        }
    }
}
