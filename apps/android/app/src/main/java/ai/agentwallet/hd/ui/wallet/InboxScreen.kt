package ai.agentwallet.hd.ui.wallet

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import ai.agentwallet.hd.InboxItem
import ai.agentwallet.hd.ui.components.VpBadge
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpChip
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.vpToneOf
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumTheme

/** 收件箱列表（原生）。对照 web 的 renderInbox：Pending/All/Final 分段 + 请求卡片/空态。 */
@Composable
fun InboxScreen(vm: InboxViewModel, onOpen: (String) -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Inbox", title = "Requests to review")
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s2)) {
                VpChip("Pending", ui.filter == "pending") { vm.setFilter("pending") }
                VpChip("All", ui.filter == "all") { vm.setFilter("all") }
                VpChip("Final", ui.filter == "final") { vm.setFilter("final") }
            }
            if (ui.items.isEmpty()) {
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Text("No payment requests", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                    Text(
                        "When a connected agent or app requests a payment, it appears here for you to review and sign.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = VelarumTheme.colors.textMuted,
                    )
                }
            } else {
                ui.items.forEach { item -> InboxCard(item = item, onClick = { onOpen(item.id) }) }
            }
        }
    }
}

@Composable
private fun InboxCard(item: InboxItem, onClick: () -> Unit) {
    VpCard(modifier = Modifier.fillMaxWidth().clickable { onClick() }) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(item.payee, style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
            VpBadge(item.stateLabel, vpToneOf(item.tone))
        }
        Text(item.title, style = MaterialTheme.typography.bodyLarge, color = VelarumTheme.colors.textBody, modifier = Modifier.padding(top = Spacing.s1))
        Text(
            "${item.amount} ${item.asset} · ${item.network}",
            style = MaterialTheme.typography.bodyMedium,
            color = VelarumTheme.colors.textMuted,
        )
    }
}
