package ai.agentwallet.hd.ui.wallet

import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.agentwallet.hd.WalletState
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpHomeTopBar
import ai.agentwallet.hd.ui.components.VpWhiteButton
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumRadii
import ai.agentwallet.hd.ui.theme.VelarumTheme

/**
 * 首页（原生，全部入口已收回原生）：余额卡 + 资产列表。
 * 搜索→AssetSearch、＋→AssetCustomize、点资产→AssetDetail、Send/Receive→原生、扫码→相机。
 */
@Composable
fun HomeScreen(
    vm: WalletViewModel,
    onSend: () -> Unit,
    onReceive: () -> Unit,
    onScan: () -> Unit,
    onSearch: () -> Unit,
    onAdd: () -> Unit,
    onAssetClick: (String) -> Unit,
) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val wallet = ui.wallet
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpHomeTopBar(onSearch = onSearch, onScan = onScan)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            BalanceCard(totalUsd = totalUsd(wallet), refreshing = ui.refreshing, onSend = onSend, onReceive = onReceive)
            AssetsPanel(wallet = wallet, displayed = ui.displayedKeys, onAdd = onAdd, onAssetClick = onAssetClick)
        }
    }
}

@Composable
private fun BalanceCard(totalUsd: Double, refreshing: Boolean, onSend: () -> Unit, onReceive: () -> Unit) {
    Surface(shape = VelarumRadii.xl, color = VelarumTheme.colors.surfaceInverse, modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Spacing.s6), verticalArrangement = Arrangement.spacedBy(Spacing.s2)) {
            Text(
                text = "TOTAL BALANCE",
                style = MaterialTheme.typography.labelMedium.copy(letterSpacing = 1.5.sp),
                color = Color.White.copy(alpha = 0.7f),
            )
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(Spacing.s2)) {
                Text(formatUsd(totalUsd), style = MaterialTheme.typography.displaySmall, color = Color.White)
                Text("USD", style = MaterialTheme.typography.titleMedium, color = Color.White.copy(alpha = 0.7f))
            }
            Text(
                text = if (refreshing) "Refreshing balances…"
                else if (totalUsd > 0) "Estimated value across your assets"
                else "No funds yet · deposit to get started",
                style = MaterialTheme.typography.bodyMedium,
                color = Color.White.copy(alpha = 0.7f),
            )
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = Spacing.s2),
                horizontalArrangement = Arrangement.spacedBy(Spacing.s3),
            ) {
                VpWhiteButton("Send", onSend, modifier = Modifier.weight(1f))
                VpWhiteButton("Receive", onReceive, modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun AssetsPanel(wallet: WalletState, displayed: List<String>, onAdd: () -> Unit, onAssetClick: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.s2)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("Crypto assets", style = MaterialTheme.typography.titleLarge, color = VelarumTheme.colors.textStrong)
            IconButton(onClick = onAdd) {
                Icon(Icons.Filled.Add, contentDescription = "Customize assets", tint = VelarumTheme.colors.primary)
            }
        }
        VpCard(modifier = Modifier.fillMaxWidth()) {
            HOME_ASSETS.filter { it.balanceKey in displayed }.forEach { asset ->
                AssetRow(asset = asset, wallet = wallet, onClick = { onAssetClick(asset.balanceKey) })
            }
        }
    }
}

@Composable
private fun AssetRow(asset: DisplayAsset, wallet: WalletState, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable { onClick() }.padding(vertical = Spacing.s2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s3),
    ) {
        Box(
            modifier = Modifier.size(40.dp).clip(CircleShape).background(Color(asset.markColor)),
            contentAlignment = Alignment.Center,
        ) {
            Text(asset.symbol.take(1), style = MaterialTheme.typography.titleMedium, color = Color.White)
        }
        Column(modifier = Modifier.weight(1f)) {
            Text("${asset.symbol} on ${asset.chain}", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
            Text(shortAddress(addressFor(asset.addressKind, wallet)), style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
        }
        Text(
            "${displayBalance(wallet.balances[asset.balanceKey])} ${asset.symbol}",
            style = MaterialTheme.typography.titleMedium,
            color = VelarumTheme.colors.textStrong,
        )
    }
}
