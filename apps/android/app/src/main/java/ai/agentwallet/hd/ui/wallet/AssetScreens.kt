package ai.agentwallet.hd.ui.wallet

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.agentwallet.hd.SettingsRepository
import ai.agentwallet.hd.ui.components.VpBadge
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpChip
import ai.agentwallet.hd.ui.components.VpFactRow
import ai.agentwallet.hd.ui.components.VpMenuRow
import ai.agentwallet.hd.ui.components.VpOutlineButton
import ai.agentwallet.hd.ui.components.VpPrimaryButton
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.VpTone
import ai.agentwallet.hd.ui.components.vpToneOf
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumFonts
import ai.agentwallet.hd.ui.theme.VelarumTheme

/** 资产详情（原生）。对照 web 的 renderAssetDetail：余额/法币 + Send(预填)/Receive + 事实 + 历史入口。 */
@Composable
fun AssetDetailScreen(
    vm: WalletViewModel,
    assetKey: String,
    onBack: () -> Unit,
    onSend: (String, String) -> Unit,
    onReceive: () -> Unit,
    onHistory: (String) -> Unit,
) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val asset = assetByKey(assetKey)
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Asset details", title = asset?.let { "${it.symbol} on ${it.chain}" } ?: "Asset", onBack = onBack)
        if (asset == null) {
            Box(Modifier.fillMaxWidth().padding(Spacing.s8), contentAlignment = Alignment.Center) {
                Text("Asset not found.", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
            }
        } else {
            val wallet = ui.wallet
            val balance = displayBalance(wallet.balances[asset.balanceKey])
            val address = addressFor(asset.addressKind, wallet)
            Column(
                modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
                verticalArrangement = Arrangement.spacedBy(Spacing.s4),
            ) {
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("$balance ${asset.symbol}", style = MaterialTheme.typography.displaySmall, color = VelarumTheme.colors.textStrong)
                        Text("≈ $${formatUsd(fiatUsd(asset.symbol, balance))}", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s3)) {
                    VpPrimaryButton("Send", onClick = { onSend(asset.symbol, asset.chain) }, modifier = Modifier.weight(1f))
                    VpOutlineButton("Receive", onClick = onReceive, modifier = Modifier.weight(1f))
                }
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    VpFactRow("Network", asset.chain)
                    VpFactRow("Wallet address", shortAddress(address))
                    VpFactRow("Status", if (balance != "0") "In wallet" else "No balance yet", if (balance != "0") VpTone.SAFE else VpTone.INFO)
                    VpFactRow("Signing", "Local approval required")
                }
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Text("Full address", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                    Text(
                        address ?: "—",
                        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = VelarumFonts.mono),
                        color = VelarumTheme.colors.textBody,
                        modifier = Modifier.padding(top = Spacing.s2),
                    )
                }
                VpMenuRow("Activity history", "Transfers for ${asset.symbol}", onClick = { onHistory(asset.symbol) })
            }
        }
    }
}

/** 资产搜索（原生）。对照 web 的 renderAssetSearch（在真实可用资产中过滤）。 */
@Composable
fun AssetSearchScreen(onBack: () -> Unit, onOpen: (String) -> Unit) {
    var query by remember { mutableStateOf("") }
    val results = HOME_ASSETS.filter { query.isBlank() || it.symbol.contains(query, true) || it.chain.contains(query, true) }
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Crypto assets", title = "Search assets", onBack = onBack)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8).imePadding(),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            ai.agentwallet.hd.ui.components.VpTextField(value = query, onValueChange = { query = it }, label = "Search token or chain")
            if (results.isEmpty()) {
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Text("No asset found", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                    Text("Try XLM, SOL, ETH, USDC, or a chain like Base.", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
                }
            } else {
                results.forEach { a -> VpMenuRow("${a.symbol} on ${a.chain}", "View details", onClick = { onOpen(a.balanceKey) }) }
            }
        }
    }
}

/** 资产自定义（原生）。对照 web 的 renderAssetCustomize：切换 Home 展示哪些资产（至少 1 个）。 */
@Composable
fun AssetCustomizeScreen(vm: WalletViewModel, onBack: () -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val displayed = ui.displayedKeys.toSet()
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Crypto assets", title = "Customize list", onBack = onBack)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            HOME_ASSETS.forEach { a ->
                val on = a.balanceKey in displayed
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s3)) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("${a.symbol} on ${a.chain}", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                            Text(if (on) "Shown on Home" else "Hidden", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
                        }
                        VpChip(if (on) "Shown" else "Add", on) {
                            val next = if (on) displayed - a.balanceKey else displayed + a.balanceKey
                            if (next.isNotEmpty()) {
                                SettingsRepository.setDisplayedKeys(context, HOME_ASSETS.map { it.balanceKey }.filter { it in next })
                                vm.refresh()
                            }
                        }
                    }
                }
            }
        }
    }
}

/** 资产历史（原生）。对照 web 的 renderAssetHistory：按资产过滤的活动记录。 */
@Composable
fun AssetHistoryScreen(vm: ActivityViewModel, symbol: String, onBack: () -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val items = ui.items.filter { it.asset.equals(symbol, true) }
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Asset", title = "$symbol history", onBack = onBack)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            if (items.isEmpty()) {
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Text("No activity yet", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                    Text("Transfers of $symbol you sign on this device will appear here.", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
                }
            } else {
                items.forEach { item ->
                    VpCard(modifier = Modifier.fillMaxWidth()) {
                        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s3)) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(item.title, style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                                if (item.subtitle.isNotBlank()) {
                                    Text(item.subtitle, style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
                                }
                            }
                            VpBadge(item.amount.ifBlank { "—" }, vpToneOf(item.tone))
                        }
                    }
                }
            }
        }
    }
}
