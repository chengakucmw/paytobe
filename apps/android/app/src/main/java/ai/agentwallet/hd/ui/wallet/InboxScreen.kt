package ai.agentwallet.hd.ui.wallet

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.agentwallet.hd.InboxItem
import ai.agentwallet.hd.ui.components.VpBadge
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpChip
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.vpToneOf
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.PaytobeTheme

/** 收件箱列表（原生）。对照 web 的 renderInbox：Pending/All/Final 分段 + 请求卡片/空态。
 *  列表用 LazyColumn：只渲染可见请求卡片并回收，请求变多时滚动依旧顺滑。 */
@Composable
fun InboxScreen(vm: InboxViewModel, onOpen: (String) -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = Spacing.s8),
        verticalArrangement = Arrangement.spacedBy(Spacing.s4),
    ) {
        item {
            VpSubheader(eyebrow = "Inbox", title = "Requests to review")
        }
        item {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = Spacing.s5),
                horizontalArrangement = Arrangement.spacedBy(Spacing.s2),
            ) {
                VpChip("All", ui.filter == "all") { vm.setFilter("all") }
                VpChip("Pending", ui.filter == "pending") { vm.setFilter("pending") }
                VpChip("Signed", ui.filter == "signed") { vm.setFilter("signed") }
                VpChip("Completed", ui.filter == "completed") { vm.setFilter("completed") }
            }
        }
        if (ui.items.isEmpty()) {
            item {
                VpCard(modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5)) {
                    Text("No payment requests", style = MaterialTheme.typography.titleMedium, color = PaytobeTheme.colors.textStrong)
                    Text(
                        "When a connected agent or app requests a payment, it appears here for you to review and sign.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = PaytobeTheme.colors.textMuted,
                    )
                }
            }
        } else {
            items(ui.items) { item ->
                InboxCard(item = item, onClick = { onOpen(item.id) }, modifier = Modifier.padding(horizontal = Spacing.s5))
            }
        }
    }
}

@Composable
private fun InboxCard(item: InboxItem, onClick: () -> Unit, modifier: Modifier = Modifier) {
    VpCard(modifier = modifier.fillMaxWidth().clickable { onClick() }) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                item.payee,
                style = MaterialTheme.typography.titleMedium,
                color = PaytobeTheme.colors.textStrong,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            VpBadge(item.stateLabel, vpToneOf(item.tone))
        }
        Text(item.title, style = MaterialTheme.typography.bodyLarge, color = PaytobeTheme.colors.textBody, modifier = Modifier.padding(top = Spacing.s1))
        Text(
            "${item.amount} ${item.asset} · ${item.network}",
            style = MaterialTheme.typography.bodyMedium,
            color = PaytobeTheme.colors.textMuted,
        )
    }
}
