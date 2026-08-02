package ai.agentwallet.hd.ui.wallet

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.agentwallet.hd.BuildConfig
import ai.agentwallet.hd.ui.components.VpBadge
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpChip
import ai.agentwallet.hd.ui.components.VpMenuRow
import ai.agentwallet.hd.ui.components.VpPrimaryButton
import ai.agentwallet.hd.ui.components.VpRiskBanner
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.VpTextField
import ai.agentwallet.hd.ui.components.VpTone
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumFonts
import ai.agentwallet.hd.ui.theme.VelarumTheme

/** 我的（Profile tab，原生）。对照 web 的 renderProfile：身份卡 + 代理/活动/开发者/设置入口。 */
@Composable
fun ProfileScreen(
    vm: IdentityViewModel,
    onIdentity: () -> Unit,
    onAgents: () -> Unit,
    onActivity: () -> Unit,
    onDeveloper: () -> Unit,
    onSettings: () -> Unit,
) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val id = ui.identity
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Personal center", title = "Profile")
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            VpCard(modifier = Modifier.fillMaxWidth().clickable { onIdentity() }) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s3)) {
                    Avatar(id?.avatar ?: "V", 52.dp)
                    Column(modifier = Modifier.weight(1f)) {
                        Text(id?.name ?: "My Wallet", style = MaterialTheme.typography.titleLarge, color = VelarumTheme.colors.textStrong)
                        Text(id?.walletId ?: "", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
                    }
                    VpBadge("Wallet ID", VpTone.SAFE)
                }
            }
            VpMenuRow("Connected agents", "Manage agent permissions and revocation", onAgents)
            VpMenuRow("Activity history", "Signed, broadcast, and recorded transfers", onActivity)
            if (!BuildConfig.MANAGED_PLATFORM_SERVICE) {
                VpMenuRow("Developer quickstart", "Payment Requests and local pairing", onDeveloper, badgeText = "v0.2")
            }
            VpMenuRow("Settings", "Security, notifications, networks, language", onSettings)
        }
    }
}

/** 钱包身份编辑（原生）。对照 web 的 renderWalletIdentity：昵称 + 头像本地偏好；展示钱包地址。 */
@Composable
fun WalletIdentityScreen(vm: IdentityViewModel, onBack: () -> Unit, onSaved: () -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val id = ui.identity
    var nickname by remember(id) { mutableStateOf(id?.name ?: "") }
    var avatar by remember(id) { mutableStateOf(id?.avatar ?: "V") }
    LaunchedEffect(ui.saved) { if (ui.saved) onSaved() }
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Profile", title = "Wallet identity", onBack = onBack)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8).imePadding(),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            VpCard(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    Avatar(avatar, 80.dp)
                    Text(nickname.ifBlank { "My Wallet" }, style = MaterialTheme.typography.titleLarge, color = VelarumTheme.colors.textStrong, modifier = Modifier.padding(top = Spacing.s3))
                    Text(id?.walletId ?: "", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
                }
            }
            VpTextField(value = nickname, onValueChange = { nickname = it }, label = "Nickname")
            VpCard(modifier = Modifier.fillMaxWidth()) {
                Text("Avatar", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong, modifier = Modifier.padding(bottom = Spacing.s2))
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s2)) {
                    listOf("V", "M", "MW", "Q").forEach { option ->
                        VpChip(option, option == avatar) { avatar = option }
                    }
                }
            }
            VpCard(modifier = Modifier.fillMaxWidth()) {
                Text("Wallet address (EVM)", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                Text(
                    id?.evmAddress ?: "—",
                    style = MaterialTheme.typography.bodyMedium.copy(fontFamily = VelarumFonts.mono),
                    color = VelarumTheme.colors.textBody,
                    modifier = Modifier.padding(top = Spacing.s2),
                )
            }
            VpRiskBanner(VpTone.INFO, "Public profile only", "These fields help you recognize this wallet. They do not expose your private key or signing device.")
            VpPrimaryButton("Save", onClick = { vm.save(nickname, avatar) }, modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun Avatar(initial: String, size: Dp) {
    Box(
        modifier = Modifier.size(size).clip(CircleShape).background(VelarumTheme.colors.primary),
        contentAlignment = Alignment.Center,
    ) {
        Text(initial.ifBlank { "V" }.take(2), style = MaterialTheme.typography.titleLarge, color = VelarumTheme.colors.onPrimary)
    }
}
