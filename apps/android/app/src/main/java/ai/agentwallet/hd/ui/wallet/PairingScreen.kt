package ai.agentwallet.hd.ui.wallet

import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.agentwallet.hd.ui.components.VpBadge
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpOutlineButton
import ai.agentwallet.hd.ui.components.VpPrimaryButton
import ai.agentwallet.hd.ui.components.VpRiskBanner
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.VpTextField
import ai.agentwallet.hd.ui.components.VpTone
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumTheme

/**
 * 配对页（原生）。对照 web 的 renderPairing：输入/扫得配对码 → 取会话 → 展示请求的权限 → 批准/拒绝。
 * 需配置 relay 才能取到会话；无 relay 时显示错误（属正常）。
 */
@Composable
fun PairingScreen(vm: PairingViewModel, presetCode: String, onBack: () -> Unit, onDone: () -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    LaunchedEffect(presetCode) { if (presetCode.isNotBlank()) vm.preset(presetCode) }
    LaunchedEffect(ui.done) { if (ui.done) onDone() }
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Pairing", title = "Connect an agent", onBack = onBack)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8).imePadding(),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            VpTextField(value = ui.code, onValueChange = vm::setCode, label = "Pairing code")
            VpPrimaryButton(
                text = if (ui.loading) "Loading…" else "Load request",
                onClick = { vm.fetch() },
                enabled = !ui.loading && ui.code.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            )
            val err = ui.error
            if (err != null) VpRiskBanner(VpTone.DANGER, "Pairing error", err)
            val session = ui.session
            if (session != null) {
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(session.name, style = MaterialTheme.typography.titleLarge, color = VelarumTheme.colors.textStrong)
                        VpBadge(if (session.pending) "Pending" else "Closed", if (session.pending) VpTone.CAUTION else VpTone.INFO)
                    }
                    Text(
                        listOf(session.runtime, session.deviceLabel).filter { it.isNotBlank() }.joinToString(" · "),
                        style = MaterialTheme.typography.bodyMedium,
                        color = VelarumTheme.colors.textMuted,
                    )
                }
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Text("Requested scopes", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                    if (session.requestedScopes.isEmpty()) {
                        Text("None requested.", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
                    } else {
                        session.requestedScopes.forEach { scope ->
                            Text("· $scope", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textBody)
                        }
                    }
                }
                if (session.pending) {
                    VpPrimaryButton(
                        text = if (ui.working) "Working…" else "Approve & connect",
                        onClick = { vm.approve() },
                        enabled = !ui.working,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    VpOutlineButton(
                        text = "Reject",
                        onClick = { vm.reject() },
                        enabled = !ui.working,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}
