package ai.agentwallet.hd.ui.wallet

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.agentwallet.hd.ui.components.LocalToastController
import ai.agentwallet.hd.ui.components.VpBadge
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpEyebrow
import ai.agentwallet.hd.ui.components.VpQrCode
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.VpTone
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumFonts
import ai.agentwallet.hd.ui.theme.VelarumRadii
import ai.agentwallet.hd.ui.theme.VelarumTheme

/**
 * 收款页（原生）：选资产 → 显示该资产对应地址的二维码 + 可复制地址。
 * 对照 web 的 renderReceive：默认按所选资产展示正确链的地址，避免给错链地址。
 */
@Composable
fun ReceiveScreen(vm: WalletViewModel, onBack: () -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val wallet = ui.wallet
    var selected by remember { mutableStateOf(HOME_ASSETS.first()) }
    val toast = LocalToastController.current
    val clipboard = LocalClipboardManager.current
    val address = addressFor(selected.addressKind, wallet)

    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Receive assets", title = "Your wallet address", onBack = onBack)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s2)) {
                HOME_ASSETS.forEach { asset ->
                    AssetChip(label = asset.symbol, active = asset.symbol == selected.symbol) { selected = asset }
                }
            }

            VpCard(modifier = Modifier.fillMaxWidth()) {
                Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    if (address != null) {
                        VpQrCode(content = address, modifier = Modifier.size(220.dp))
                    } else {
                        Text(
                            "Wallet address is not ready yet.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = VelarumTheme.colors.textMuted,
                        )
                    }
                }
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = Spacing.s4),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("Network", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                    VpBadge(selected.chain, VpTone.SAFE)
                }
            }

            VpCard(modifier = Modifier.fillMaxWidth()) {
                VpEyebrow("Receive ${selected.symbol}")
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = Spacing.s3),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Spacing.s2),
                ) {
                    Text(
                        text = address ?: "Not ready",
                        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = VelarumFonts.mono),
                        color = VelarumTheme.colors.textBody,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(
                        onClick = {
                            if (address != null) {
                                clipboard.setText(AnnotatedString(address))
                                toast.show("Copied", "Address copied to clipboard.")
                            }
                        },
                    ) {
                        Icon(Icons.Filled.ContentCopy, contentDescription = "Copy address", tint = VelarumTheme.colors.primary)
                    }
                }
                Surface(
                    shape = VelarumRadii.md,
                    color = VelarumTheme.colors.primarySoft,
                    modifier = Modifier.fillMaxWidth().padding(top = Spacing.s3),
                ) {
                    Text(
                        text = "${selected.chain} network only · only send ${selected.symbol} to this address. Sending a different network or asset here can lose your funds.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = VelarumTheme.colors.primaryActive,
                        modifier = Modifier.padding(Spacing.s4),
                    )
                }
            }
        }
    }
}

@Composable
private fun AssetChip(label: String, active: Boolean, onClick: () -> Unit) {
    Surface(
        shape = VelarumRadii.pill,
        color = if (active) VelarumTheme.colors.primary else VelarumTheme.colors.surfaceCard,
        border = if (active) null else BorderStroke(1.dp, VelarumTheme.colors.borderDefault),
        modifier = Modifier.clickable { onClick() },
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            color = if (active) VelarumTheme.colors.onPrimary else VelarumTheme.colors.textStrong,
            modifier = Modifier.padding(horizontal = Spacing.s4, vertical = Spacing.s2),
        )
    }
}
