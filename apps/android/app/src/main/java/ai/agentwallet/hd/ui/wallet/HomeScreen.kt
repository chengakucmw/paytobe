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
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import ai.agentwallet.hd.ui.components.LocalToastController
import ai.agentwallet.hd.ui.components.VpRiskBanner
import ai.agentwallet.hd.ui.components.VpTone
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
    val toast = LocalToastController.current
    var manualRefreshBaseline by remember { mutableStateOf<Long?>(null) }

    LaunchedEffect(ui.completedRefreshCount, manualRefreshBaseline) {
        val baseline = manualRefreshBaseline ?: return@LaunchedEffect
        if (ui.completedRefreshCount > baseline) {
            if (ui.refreshError == null) {
                toast.show("Balances updated", "The latest confirmed balances are now displayed.")
            } else {
                toast.show("Balance refresh failed", "Check your connection and try again.", isError = true)
            }
            manualRefreshBaseline = null
        }
    }

    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpHomeTopBar(
            onSearch = onSearch,
            onScan = onScan,
            onRefresh = {
                manualRefreshBaseline = ui.completedRefreshCount
                toast.show("Refreshing balances", "Checking Stellar Testnet for the latest balance.")
                vm.refresh()
            },
            refreshing = ui.refreshing,
        )
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            if (ui.refreshError != null) {
                VpRiskBanner(
                    tone = VpTone.DANGER,
                    title = "Balance refresh failed",
                    body = "Check your connection, then tap the refresh button to try again.",
                )
            }
            HeroBalanceCard(
                totalUsd = totalUsd(wallet),
                onSend = onSend,
                onReceive = onReceive,
            )
            AssetsPanel(wallet = wallet, displayed = ui.displayedKeys, onAdd = onAdd, onAssetClick = onAssetClick)
        }
    }
}

@Composable
private fun HeroBalanceCard(
    totalUsd: Double?,
    onSend: () -> Unit,
    onReceive: () -> Unit,
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
            Text(
                "TOTAL BALANCE",
                style = MaterialTheme.typography.labelMedium.copy(letterSpacing = 1.5.sp),
                color = Color.White.copy(alpha = 0.72f),
            )
            Text(
                totalUsd?.let { "$" + formatUsd(it) } ?: "—",
                style = MaterialTheme.typography.displaySmall,
                color = Color.White,
                fontWeight = FontWeight.SemiBold,
            )
            // Quick actions: Send + Receive only, centred with a comfortable gap between them.
            // (Scan and Buy were removed from the hero card; Scan still lives in the top bar.)
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = Spacing.s4),
                horizontalArrangement = Arrangement.spacedBy(Spacing.s10, Alignment.CenterHorizontally),
            ) {
                HeroAction(Icons.Filled.ArrowUpward, "Send", onSend)
                HeroAction(Icons.Filled.ArrowDownward, "Receive", onReceive)
            }
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
            // P4：按币种分组。仅当某币种横跨多条链时显示聚合组头（币种 ｜ $合计 ｜ N 网络）；
            // 单链币种保持原样、无冗余组头。组内仍是各链一行的绑定资产。
            HOME_ASSETS.filter { it.balanceKey in displayed }
                .groupBy { it.symbol }
                .forEach { (symbol, assets) ->
                    if (assets.size > 1) {
                        AssetGroupHeader(symbol = symbol, assets = assets, wallet = wallet)
                    }
                    assets.forEach { asset ->
                        AssetRow(asset = asset, wallet = wallet, onClick = { onAssetClick(asset.balanceKey) })
                    }
                }
        }
    }
}

/** P4 组头：某币种横跨多条链时的聚合行（合计法币估值 + 网络数）。仅在 size>1 时渲染。 */
@Composable
private fun AssetGroupHeader(symbol: String, assets: List<DisplayAsset>, wallet: WalletState) {
    val usd = assets.sumOf { fiatUsd(it.symbol, displayBalance(wallet.balances[it.balanceKey])) }
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = Spacing.s2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s3),
    ) {
        Text(
            symbol,
            style = MaterialTheme.typography.titleMedium,
            color = VelarumTheme.colors.textStrong,
            modifier = Modifier.weight(1f),
        )
        Column(horizontalAlignment = Alignment.End) {
            Text(
                "$" + formatUsd(usd),
                style = MaterialTheme.typography.titleMedium,
                color = VelarumTheme.colors.textStrong,
            )
            Text(
                "${assets.size} networks",
                style = MaterialTheme.typography.bodySmall,
                color = VelarumTheme.colors.textMuted,
            )
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
            Text("${asset.symbol} · ${asset.chain}", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
            Text(shortAddress(addressFor(asset.addressKind, wallet)), style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
        }
        Text(
            "${displayBalance(wallet.balances[asset.balanceKey])} ${asset.symbol}",
            style = MaterialTheme.typography.titleMedium,
            color = VelarumTheme.colors.textStrong,
        )
    }
}
