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
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.QrCodeScanner
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.agentwallet.hd.WalletState
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpHomeTopBar
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumRadii
import ai.agentwallet.hd.ui.theme.VelarumTheme

/**
 * 首页（原生）：品牌头 + Velar Teal 渐变英雄卡（余额 + 快捷操作）+ 资产列表。
 * 2026-06-20 按原型 prototypes/html20260620/screens/04-home.html 换肤；金额/地址全部取自真实状态。
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
            HeroBalanceCard(
                totalUsd = totalUsd(wallet),
                refreshing = ui.refreshing,
                stellarAddress = stellarAddress(wallet),
                onSend = onSend, onReceive = onReceive, onScan = onScan, onAdd = onAdd,
            )
            AssetsPanel(wallet = wallet, displayed = ui.displayedKeys, onAdd = onAdd, onAssetClick = onAssetClick)
        }
    }
}

private fun stellarAddress(wallet: WalletState): String? =
    HOME_ASSETS.firstOrNull { it.symbol == "XLM" }?.let { addressFor(it.addressKind, wallet) }

@Composable
private fun HeroBalanceCard(
    totalUsd: Double,
    refreshing: Boolean,
    stellarAddress: String?,
    onSend: () -> Unit,
    onReceive: () -> Unit,
    onScan: () -> Unit,
    onAdd: () -> Unit,
) {
    val c = VelarumTheme.colors
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(VelarumRadii.xl)
            .background(Brush.linearGradient(listOf(c.primary, c.brandStrong, c.surfaceInverse)))
            .padding(Spacing.s6),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.s3)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    "TOTAL BALANCE",
                    style = MaterialTheme.typography.labelMedium.copy(letterSpacing = 1.5.sp),
                    color = Color.White.copy(alpha = 0.72f),
                )
                GlassChip("Stellar mainnet")
            }
            Text(
                "$" + formatUsd(totalUsd),
                style = MaterialTheme.typography.displaySmall,
                color = Color.White,
                fontWeight = FontWeight.SemiBold,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Spacing.s3),
            ) {
                Text(
                    if (refreshing) "Refreshing balances…"
                    else if (totalUsd > 0) "Estimated value across your assets"
                    else "No funds yet · deposit to get started",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color.White.copy(alpha = 0.78f),
                )
                if (!stellarAddress.isNullOrBlank()) AddressChip(shortAddress(stellarAddress))
            }
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = Spacing.s3),
                horizontalArrangement = Arrangement.spacedBy(Spacing.s2),
            ) {
                HeroAction(Icons.Filled.ArrowUpward, "Send", onSend, Modifier.weight(1f))
                HeroAction(Icons.Filled.ArrowDownward, "Receive", onReceive, Modifier.weight(1f))
                HeroAction(Icons.Filled.QrCodeScanner, "Scan", onScan, Modifier.weight(1f))
                HeroAction(Icons.Filled.Add, "Buy", onAdd, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun GlassChip(text: String) {
    Surface(shape = VelarumRadii.pill, color = Color.White.copy(alpha = 0.16f)) {
        Text(
            text,
            style = MaterialTheme.typography.labelMedium,
            color = Color.White,
            modifier = Modifier.padding(horizontal = Spacing.s3, vertical = Spacing.s1),
        )
    }
}

@Composable
private fun AddressChip(text: String) {
    Surface(shape = VelarumRadii.pill, color = Color.White.copy(alpha = 0.16f)) {
        Row(
            modifier = Modifier.padding(horizontal = Spacing.s3, vertical = Spacing.s1),
            horizontalArrangement = Arrangement.spacedBy(Spacing.s1),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(text, style = MaterialTheme.typography.bodyMedium, color = Color.White)
            Icon(Icons.Filled.ContentCopy, contentDescription = null, tint = Color.White.copy(alpha = 0.8f), modifier = Modifier.size(14.dp))
        }
    }
}

@Composable
private fun HeroAction(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.clip(VelarumRadii.md).clickable { onClick() }.padding(vertical = Spacing.s1),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Spacing.s2),
    ) {
        Box(
            modifier = Modifier.size(54.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.16f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = label, tint = Color.White)
        }
        Text(label, style = MaterialTheme.typography.bodyMedium, color = Color.White.copy(alpha = 0.85f))
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
            modifier = Modifier.size(44.dp).clip(CircleShape).background(Color(asset.markColor)),
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
