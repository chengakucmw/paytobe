package ai.agentwallet.hd.ui.wallet

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import ai.agentwallet.hd.ui.components.VpRiskBanner
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.VpTone
import ai.agentwallet.hd.ui.components.vpToneOf
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
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
        VpSubheader(eyebrow = "Asset details", title = asset?.let { "${it.symbol} · ${it.chain}" } ?: "Asset", onBack = onBack)
        if (asset == null) {
            Box(Modifier.fillMaxWidth().padding(Spacing.s8), contentAlignment = Alignment.Center) {
                Text("Asset not found.", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
            }
        } else {
            val wallet = ui.wallet
            val assetBalance = wallet.balances[asset.balanceKey]
            val condition = balanceCondition(assetBalance)
            val balance = displayBalance(assetBalance)
            val address = addressFor(asset.addressKind, wallet)
            val statusTone = when (condition) {
                BalanceCondition.AVAILABLE -> VpTone.SAFE
                BalanceCondition.ZERO -> VpTone.INFO
                BalanceCondition.INACTIVE -> VpTone.CAUTION
                BalanceCondition.ERROR -> VpTone.DANGER
                BalanceCondition.UNKNOWN -> VpTone.INFO
            }
            Column(
                modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
                verticalArrangement = Arrangement.spacedBy(Spacing.s4),
            ) {
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("$balance ${asset.symbol}", style = MaterialTheme.typography.displaySmall, color = VelarumTheme.colors.textStrong)
                        Text(
                            if (condition in setOf(BalanceCondition.AVAILABLE, BalanceCondition.ZERO)) {
                                "≈ $${formatUsd(fiatUsd(asset.symbol, balance))}"
                            } else if (ui.refreshing) {
                                "Refreshing balance…"
                            } else {
                                balanceStatusLabel(assetBalance)
                            },
                            style = MaterialTheme.typography.bodyMedium,
                            color = VelarumTheme.colors.textMuted,
                        )
                    }
                }
                if (ui.refreshing) {
                    VpRiskBanner(
                        tone = VpTone.INFO,
                        title = "Refreshing balance",
                        body = "Checking the latest confirmed balance on Stellar Testnet.",
                    )
                } else if (condition == BalanceCondition.ERROR || ui.refreshError != null) {
                    VpRiskBanner(
                        tone = VpTone.DANGER,
                        title = "Balance refresh failed",
                        body = "The wallet could not reach Stellar Testnet. Check your connection and try again.",
                    )
                } else if (condition == BalanceCondition.INACTIVE) {
                    VpRiskBanner(
                        tone = VpTone.CAUTION,
                        title = "Account not activated",
                        body = "The latest refresh did not find this account on Stellar Testnet. After funding it, refresh again.",
                    )
                }
                VpOutlineButton(
                    text = if (ui.refreshing) "Refreshing…" else "Refresh balance",
                    onClick = vm::refresh,
                    enabled = !ui.refreshing,
                    modifier = Modifier.fillMaxWidth(),
                )
                PriceChartCard(symbol = asset.symbol)
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s3)) {
                    VpPrimaryButton("Send", onClick = { onSend(asset.symbol, asset.chain) }, modifier = Modifier.weight(1f))
                    VpOutlineButton("Receive", onClick = onReceive, modifier = Modifier.weight(1f))
                }
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    VpFactRow("Network", asset.chain)
                    VpFactRow("Wallet address", shortAddress(address))
                    VpFactRow(
                        "Status",
                        if (ui.refreshing) "Refreshing" else balanceStatusLabel(assetBalance),
                        if (ui.refreshing) VpTone.INFO else statusTone,
                    )
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

/** 价格走势卡（对照原型 05 的 sparkline + 时间段切换）。
 *  数据来自 CoinGecko 真实行情（[fetchPriceSeries]）；加载中显示转圈，无数据时显示占位文案。 */
@Composable
private fun PriceChartCard(symbol: String) {
    var timeframe by remember { mutableStateOf("1D") }
    var points by remember { mutableStateOf<List<Float>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(symbol, timeframe) {
        loading = true
        points = fetchPriceSeries(symbol, timeframe)
        loading = false
    }
    VpCard(modifier = Modifier.fillMaxWidth()) {
        Box(modifier = Modifier.fillMaxWidth().height(72.dp), contentAlignment = Alignment.Center) {
            when {
                points.size >= 2 -> Sparkline(points = points, modifier = Modifier.fillMaxWidth().height(72.dp))
                loading -> CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                else -> Text("Price chart unavailable", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
            }
        }
        Spacer(Modifier.height(Spacing.s3))
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(Spacing.s2),
        ) {
            listOf("1H", "1D", "1W", "1M", "1Y", "All").forEach { tf ->
                VpChip(tf, active = tf == timeframe) { timeframe = tf }
            }
        }
    }
}

@Composable
private fun Sparkline(points: List<Float>, modifier: Modifier = Modifier) {
    val line = VelarumTheme.colors.primary
    Canvas(modifier = modifier) {
        if (points.size < 2) return@Canvas
        val min = points.minOrNull() ?: return@Canvas
        val max = points.maxOrNull() ?: return@Canvas
        val range = (max - min).takeIf { it > 0f } ?: 1f
        val dx = size.width / (points.size - 1)
        val path = Path()
        points.forEachIndexed { i, p ->
            val norm = (p - min) / range
            val x = dx * i
            val y = size.height * 0.95f - norm * size.height * 0.9f
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        drawPath(path, color = line, style = Stroke(width = 5f, cap = StrokeCap.Round, join = StrokeJoin.Round))
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
            ai.agentwallet.hd.ui.components.VpTextField(value = query, onValueChange = { query = it }, label = "Search token or network")
            if (results.isEmpty()) {
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Text("No asset found", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                    Text("Try XLM, SOL, ETH, USDC, or a network like Base.", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
                }
            } else {
                results.forEach { a -> VpMenuRow("${a.symbol} · ${a.chain}", "View details", onClick = { onOpen(a.balanceKey) }) }
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
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = Spacing.s8),
        verticalArrangement = Arrangement.spacedBy(Spacing.s4),
    ) {
        item {
            VpSubheader(eyebrow = "Crypto assets", title = "Customize list", onBack = onBack)
        }
        items(HOME_ASSETS) { a ->
            val on = a.balanceKey in displayed
            VpCard(modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5)) {
                Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s3)) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("${a.symbol} · ${a.chain}", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
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

/** 资产历史（原生）。对照 web 的 renderAssetHistory：按资产过滤的活动记录。 */
@Composable
fun AssetHistoryScreen(vm: ActivityViewModel, symbol: String, onBack: () -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val rows = ui.items.filter { it.asset.equals(symbol, true) }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = Spacing.s8),
        verticalArrangement = Arrangement.spacedBy(Spacing.s4),
    ) {
        item {
            VpSubheader(eyebrow = "Asset", title = "$symbol history", onBack = onBack)
        }
        if (rows.isEmpty()) {
            item {
                VpCard(modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5)) {
                    Text("No activity yet", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                    Text("Transfers of $symbol you sign on this device will appear here.", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
                }
            }
        } else {
            items(rows) { item ->
                VpCard(modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5)) {
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
