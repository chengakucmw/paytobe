package ai.agentwallet.hd.ui.wallet

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.agentwallet.hd.DossierRowUi
import ai.agentwallet.hd.DossierUi
import ai.agentwallet.hd.TraceStepUi
import ai.agentwallet.hd.ui.components.VpBadge
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpFactRow
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.vpToneOf
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.PaytobeTheme

/**
 * 交易档案（原生）。对照 web 的 renderDossier：商家证明、视觉证据、决策快照、AI 任务轨迹、
 * 权限与风险检查、链上映射。数据来自 TransactionDossier.from（经 InboxRepository 映射）。
 */
@Composable
fun DossierScreen(vm: DetailViewModel, onBack: () -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val dossier = ui.detail?.dossier
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Transaction dossier", title = "Context and proof", onBack = onBack)
        if (dossier == null) {
            Box(Modifier.fillMaxWidth().padding(Spacing.s8), contentAlignment = Alignment.Center) {
                Text("No dossier available.", style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textMuted)
            }
        } else {
            Column(
                modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
                verticalArrangement = Arrangement.spacedBy(Spacing.s4),
            ) {
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(dossier.title.ifBlank { "Payment dossier" }, style = MaterialTheme.typography.titleLarge, color = PaytobeTheme.colors.textStrong)
                        VpBadge(dossier.status.ifBlank { "Dossier" }, vpToneOf(dossier.tone))
                    }
                    Text("${dossier.agentName} · ${dossier.source}", style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textMuted)
                }
                if (dossier.evidence.isNotEmpty()) {
                    Section("Visual evidence") { dossier.evidence.forEach { VpFactRow(it.title, it.meta) } }
                }
                if (dossier.itemRows.isNotEmpty()) {
                    Section("Items") { dossier.itemRows.forEach { VpFactRow(it.label, it.value) } }
                }
                if (dossier.decisionRows.isNotEmpty()) {
                    Section("Decision snapshot") { dossier.decisionRows.forEach { DossierRow(it) } }
                }
                if (dossier.agentSteps.isNotEmpty()) {
                    Section("AI task trace") {
                        dossier.agentSteps.forEachIndexed { index, step -> TraceStep(index + 1, step) }
                    }
                }
                if (dossier.permissionRiskRows.isNotEmpty()) {
                    Section("Permission & risk checks") { dossier.permissionRiskRows.forEach { DossierRow(it) } }
                }
                if (dossier.paymentMappingRows.isNotEmpty()) {
                    Section("Payment mapping") { dossier.paymentMappingRows.forEach { DossierRow(it) } }
                }
            }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    VpCard(modifier = Modifier.fillMaxWidth()) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = PaytobeTheme.colors.textStrong, modifier = Modifier.padding(bottom = Spacing.s2))
        content()
    }
}

@Composable
private fun DossierRow(row: DossierRowUi) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = Spacing.s1)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(Spacing.s3),
        ) {
            Text(row.label, style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textMuted, modifier = Modifier.weight(1f))
            Text(row.value, style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textStrong, modifier = Modifier.weight(1f))
        }
        if (row.detail.isNotBlank()) {
            Text(row.detail, style = MaterialTheme.typography.labelMedium, color = PaytobeTheme.colors.textFaint)
        }
    }
}

@Composable
private fun TraceStep(number: Int, step: TraceStepUi) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = Spacing.s1),
        horizontalArrangement = Arrangement.spacedBy(Spacing.s3),
    ) {
        Text("$number", style = MaterialTheme.typography.titleMedium, color = PaytobeTheme.colors.primary)
        Column {
            Text(step.title, style = MaterialTheme.typography.titleMedium, color = PaytobeTheme.colors.textStrong)
            if (step.body.isNotBlank()) {
                Text(step.body, style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textMuted)
            }
        }
    }
}
