package ai.agentwallet.hd.ui.wallet

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.agentwallet.hd.TruthSectionUi
import ai.agentwallet.hd.ui.components.VpBadge
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpFactRow
import ai.agentwallet.hd.ui.components.VpOutlineButton
import ai.agentwallet.hd.ui.components.VpPrimaryButton
import ai.agentwallet.hd.ui.components.VpRiskBanner
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.VpTone
import ai.agentwallet.hd.ui.components.vpToneOf
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.PaytobeTheme

/**
 * 付款请求详情（原生）。对照 web 的 renderDetail：付款额 + 事实 + 风险 + Truth Panel + 档案入口，
 * 以及（可签时）Pay / Reject。Pay 走与 Send 相同的 RiskPolicy→生物→PaymentExecutor→记账 管线。
 */
@Composable
fun DetailScreen(
    vm: DetailViewModel,
    intentId: String,
    onBack: () -> Unit,
    onDossier: () -> Unit,
    onResolved: () -> Unit,
) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current
    LaunchedEffect(intentId) { vm.load(intentId) }
    LaunchedEffect(ui.done, ui.rejected) { if (ui.done || ui.rejected) onResolved() }

    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Payment Request", title = "Review payment", onBack = onBack)
        val d = ui.detail
        if (d == null) {
            Box(Modifier.fillMaxWidth().padding(Spacing.s8), contentAlignment = Alignment.Center) {
                if (ui.loading) {
                    CircularProgressIndicator()
                } else {
                    Text("Request not found.", style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textMuted)
                }
            }
        } else {
            Column(
                modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
                verticalArrangement = Arrangement.spacedBy(Spacing.s4),
            ) {
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("You are paying", style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textMuted)
                        Text("${d.amount} ${d.asset}", style = MaterialTheme.typography.displaySmall, color = PaytobeTheme.colors.textStrong)
                        // 生命周期状态药丸：过期→灰+时钟(EXPIRED)、确认→绿、失败/拒绝→红等，独立于风险等级。
                        VpBadge(d.stateLabel, vpToneOf(d.stateTone), modifier = Modifier.padding(top = Spacing.s2))
                    }
                }
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    VpFactRow("Payee", d.payee)
                    VpFactRow("Recipient", shortAddress(d.recipient))
                    VpFactRow("Network", d.network)
                    VpFactRow("Network fee", d.fee)
                    VpFactRow("Total", "${d.total} ${d.asset}")
                }
                if (d.riskBody.isNotBlank() || d.riskTitle.isNotBlank()) {
                    VpRiskBanner(vpToneOf(d.riskTone), d.riskTitle.ifBlank { "Review before signing" }, d.riskBody)
                }
                if (d.dossier.truthSections.isNotEmpty()) {
                    TruthPanel(d.dossier.truthSections)
                }
                VpCard(modifier = Modifier.fillMaxWidth().clickable { onDossier() }) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text("Open transaction dossier", style = MaterialTheme.typography.titleMedium, color = PaytobeTheme.colors.textStrong)
                        VpBadge(d.dossier.status.ifBlank { "Dossier" }, vpToneOf(d.dossier.tone))
                    }
                    Text(
                        "Intent, AI task trace, evidence, permission checks and on-chain mapping.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = PaytobeTheme.colors.textMuted,
                        modifier = Modifier.padding(top = Spacing.s1),
                    )
                }
                val err = ui.error
                if (err != null) VpRiskBanner(VpTone.DANGER, "Can't pay", err)
                if (ui.done) {
                    VpRiskBanner(VpTone.SAFE, "Payment confirmed", "Signed on this device and broadcast to the network.")
                } else if (d.signable) {
                    VpPrimaryButton(
                        text = if (ui.submitting) "Working…" else "Pay ${d.asset}",
                        onClick = { vm.pay(context as FragmentActivity) },
                        enabled = !ui.submitting,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    VpOutlineButton(
                        text = "Reject request",
                        onClick = { vm.reject() },
                        enabled = !ui.submitting,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

@Composable
private fun TruthPanel(sections: List<TruthSectionUi>) {
    VpCard(modifier = Modifier.fillMaxWidth()) {
        Text("Truth Panel", style = MaterialTheme.typography.titleMedium, color = PaytobeTheme.colors.textStrong)
        sections.forEach { section ->
            Text(
                section.title,
                style = MaterialTheme.typography.titleMedium,
                color = PaytobeTheme.colors.textStrong,
                modifier = Modifier.padding(top = Spacing.s3),
            )
            if (section.note.isNotBlank()) {
                Text(section.note, style = MaterialTheme.typography.labelMedium, color = PaytobeTheme.colors.textMuted)
            }
            section.rows.forEach { row ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = Spacing.s2),
                    horizontalArrangement = Arrangement.spacedBy(Spacing.s3),
                ) {
                    Text(row.field, style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textMuted, modifier = Modifier.weight(1f))
                    Text(row.value, style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textStrong, modifier = Modifier.weight(1f))
                }
                if (row.evidence.isNotBlank()) {
                    Text(row.evidence, style = MaterialTheme.typography.labelMedium, color = PaytobeTheme.colors.textFaint)
                }
            }
        }
    }
}
