package ai.agentwallet.hd.ui.wallet

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpFactRow
import ai.agentwallet.hd.ui.components.VpPrimaryButton
import ai.agentwallet.hd.ui.components.VpRiskBanner
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.VpTextField
import ai.agentwallet.hd.ui.components.VpTone
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.PaytobeTheme

/** 网络（原生）。对照 web 的 renderNetworks：已启用网络列表 + 添加自定义 EVM 网络。 */
@Composable
fun NetworksScreen(vm: NetworksViewModel, onBack: () -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    var name by remember { mutableStateOf("") }
    var rpc by remember { mutableStateOf("") }
    var chainId by remember { mutableStateOf("") }
    var symbol by remember { mutableStateOf("") }
    var explorer by remember { mutableStateOf("") }
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Settings", title = "Networks", onBack = onBack)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8).imePadding(),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            VpCard(modifier = Modifier.fillMaxWidth()) {
                Text("Enabled networks", style = MaterialTheme.typography.titleMedium, color = PaytobeTheme.colors.textStrong)
                if (ui.networks.isEmpty()) {
                    Text("No networks configured.", style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textMuted)
                } else {
                    ui.networks.forEach { net ->
                        VpFactRow(net.name, "chain ${net.chainId} · ${net.symbol}")
                    }
                }
            }
            VpCard(modifier = Modifier.fillMaxWidth()) {
                Text("Add EVM network", style = MaterialTheme.typography.titleMedium, color = PaytobeTheme.colors.textStrong, modifier = Modifier.padding(bottom = Spacing.s2))
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.s3)) {
                    VpTextField(value = name, onValueChange = { name = it }, label = "Network name")
                    VpTextField(value = rpc, onValueChange = { rpc = it }, label = "RPC URL")
                    VpTextField(value = chainId, onValueChange = { chainId = it }, label = "Chain ID", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                    VpTextField(value = symbol, onValueChange = { symbol = it }, label = "Currency symbol")
                    VpTextField(value = explorer, onValueChange = { explorer = it }, label = "Block explorer URL (optional)")
                    val err = ui.error
                    if (err != null) VpRiskBanner(VpTone.DANGER, "Could not add network", err)
                    VpPrimaryButton(
                        text = if (ui.adding) "Adding…" else "Add network",
                        onClick = { vm.addEvm(name, rpc, chainId, symbol, explorer) },
                        enabled = !ui.adding && name.isNotBlank() && rpc.isNotBlank() && chainId.isNotBlank() && symbol.isNotBlank(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}
