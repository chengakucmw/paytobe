package ai.agentwallet.hd.ui.wallet

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.agentwallet.hd.ui.components.VpBadge
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.vpToneOf
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumTheme

/** 活动历史（原生）。对照 web 的 renderActivity：真实的 TransactionHistoryStore 记录或空态。
 *  列表用 LazyColumn：只渲染可见行并回收复用，记录变多时开屏与滚动都不再卡。 */
@Composable
fun ActivityScreen(vm: ActivityViewModel, onBack: () -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = Spacing.s8),
        verticalArrangement = Arrangement.spacedBy(Spacing.s4),
    ) {
        item {
            VpSubheader(eyebrow = "Personal center", title = "Activity history", onBack = onBack)
        }
        if (ui.items.isEmpty()) {
            item {
                VpCard(modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5)) {
                    Text("No activity yet", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                    Text(
                        "Transfers you sign on this device will appear here. A new wallet starts with an empty history.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = VelarumTheme.colors.textMuted,
                    )
                }
            }
        } else {
            items(ui.items) { item ->
                VpCard(modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Spacing.s3),
                    ) {
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
