package ai.agentwallet.hd.ui.wallet

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.agentwallet.hd.ui.components.VpBadge
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpOutlineButton
import ai.agentwallet.hd.ui.components.VpPrimaryButton
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.VpTone
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumTheme

/** 已连接代理列表（原生）。对照 web 的 renderAgents。 */
@Composable
fun AgentsScreen(vm: AgentsViewModel, onBack: () -> Unit, onOpen: (String) -> Unit, onCreateConnectKey: () -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = Spacing.s8),
        verticalArrangement = Arrangement.spacedBy(Spacing.s4),
    ) {
        item {
            VpSubheader(eyebrow = "Agents", title = "Connected agents", onBack = onBack)
        }
        item {
            VpPrimaryButton(
                text = "Create one-time Connect Key",
                onClick = onCreateConnectKey,
                modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5),
            )
        }
        if (ui.agents.isEmpty()) {
            item {
                VpCard(modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5)) {
                    Text("No connected agents", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                    Text(
                        "Pair an agent to let it request payments that you review and approve here.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = VelarumTheme.colors.textMuted,
                    )
                }
            }
        } else {
            items(ui.agents) { agent ->
                VpCard(modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).clickable { onOpen(agent.id) }) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(agent.name, style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                        VpBadge(agent.status.ifBlank { "active" }, if (agent.revoked) VpTone.DANGER else VpTone.SAFE)
                    }
                    Text(
                        listOf(agent.runtime, agent.deviceLabel).filter { it.isNotBlank() }.joinToString(" · "),
                        style = MaterialTheme.typography.bodyMedium,
                        color = VelarumTheme.colors.textMuted,
                    )
                }
            }
        }
    }
}

/** 代理详情 + 撤销（原生）。对照 web 的 renderAgentDetail。 */
@Composable
fun AgentDetailScreen(vm: AgentDetailViewModel, connectionId: String, onBack: () -> Unit, onRevoked: () -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    LaunchedEffect(connectionId) { vm.load(connectionId) }
    LaunchedEffect(ui.revoked) { if (ui.revoked) onRevoked() }
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Agent", title = "Connection detail", onBack = onBack)
        val agent = ui.agent
        if (agent == null) {
            Box(Modifier.fillMaxWidth().padding(Spacing.s8), contentAlignment = Alignment.Center) {
                if (ui.loading) CircularProgressIndicator() else Text("Connection not found.", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
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
                        Text(agent.name, style = MaterialTheme.typography.titleLarge, color = VelarumTheme.colors.textStrong)
                        VpBadge(agent.status.ifBlank { "active" }, if (agent.revoked) VpTone.DANGER else VpTone.SAFE)
                    }
                    Text(
                        listOf(agent.runtime, agent.deviceLabel).filter { it.isNotBlank() }.joinToString(" · "),
                        style = MaterialTheme.typography.bodyMedium,
                        color = VelarumTheme.colors.textMuted,
                    )
                }
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Text("Granted scopes", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                    if (agent.scopes.isEmpty()) {
                        Text("No scopes recorded.", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
                    } else {
                        agent.scopes.forEach { scope ->
                            Text("· $scope", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textBody)
                        }
                    }
                }
                if (!agent.revoked) {
                    VpOutlineButton(
                        text = if (ui.working) "Working…" else "Revoke connection",
                        onClick = { vm.revoke() },
                        enabled = !ui.working,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}
