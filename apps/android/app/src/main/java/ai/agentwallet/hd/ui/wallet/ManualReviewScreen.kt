package ai.agentwallet.hd.ui.wallet

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpFactRow
import ai.agentwallet.hd.ui.components.VpPrimaryButton
import ai.agentwallet.hd.ui.components.VpRiskBanner
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.VpTone
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumTheme

/**
 * 复核 + 签名广播页（原生）。点 "Sign & Broadcast" 走 SendViewModel.submit：
 * prepareSend(RiskPolicy) → 不通过即在此报错（不弹生物识别） → 生物识别 → confirmSend → 状态。
 * 状态对照真实桥：review →（提交）→ confirmed / failed（中间 signed/broadcasting 演示态不出现）。
 */
@Composable
fun ManualReviewScreen(
    vm: SendViewModel,
    onEdit: () -> Unit,
    onFinishToHome: () -> Unit,
    onBalanceRefresh: () -> Unit,
) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Manual payment", title = "Review transfer", onBack = onEdit)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            if (ui.done) {
                VpRiskBanner(VpTone.SAFE, "Transfer confirmed", "Signed on this device and broadcast to the network.")
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    VpFactRow("Asset", "${ui.symbol} on ${ui.network}")
                    VpFactRow("Amount", "${ui.amount} ${ui.symbol}")
                    val tx = ui.txHash
                    if (!tx.isNullOrBlank()) VpFactRow("Tx hash", shortAddress(tx))
                }
                VpPrimaryButton("Done", onClick = onFinishToHome, modifier = Modifier.fillMaxWidth())
            } else {
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Text("You will send", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
                    Spacer(Modifier.height(Spacing.s1))
                    Text("${ui.amount} ${ui.symbol}", style = MaterialTheme.typography.displaySmall, color = VelarumTheme.colors.textStrong)
                    Text("≈ $${formatUsd(fiatUsd(ui.symbol, ui.amount))}", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
                }
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    VpFactRow("Token", "${ui.symbol} on ${ui.network}")
                    VpFactRow("Recipient", shortAddress(ui.recipient))
                    if (ui.symbol == "XLM" && ui.memo.isNotBlank()) VpFactRow("Stellar memo", ui.memo)
                    VpFactRow("Network fee", "Calculated & paid at broadcast")
                    VpFactRow("Source", "Manual transfer · no agent")
                }
                VpRiskBanner(
                    VpTone.SAFE,
                    "Ready for local approval",
                    "Confirm the token, recipient and amount. You'll authenticate, then it's signed locally and broadcast to mainnet. This cannot be undone.",
                )
                val err = ui.error
                if (err != null) VpRiskBanner(VpTone.DANGER, "Can't send", err)
                VpPrimaryButton(
                    text = if (ui.submitting) "Working…" else "Sign & Broadcast",
                    onClick = { vm.submit(context as FragmentActivity, onSent = onBalanceRefresh) },
                    enabled = !ui.submitting,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (ui.submitting) {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                }
            }
        }
    }
}
