package ai.agentwallet.hd.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import ai.agentwallet.hd.R
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumRadii
import ai.agentwallet.hd.ui.theme.VelarumTheme

/** 首页顶部栏：Logo + 品牌名 + 副标题 + 搜索/扫码（对照原型 04-home 的品牌头）。 */
@Composable
fun VpHomeTopBar(
    onSearch: () -> Unit,
    onScan: () -> Unit,
    onRefresh: () -> Unit,
    refreshing: Boolean,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(horizontal = Spacing.s5, vertical = Spacing.s3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Image(
            painter = painterResource(R.drawable.velarum_logo_mark),
            contentDescription = "VelarumPay",
            modifier = Modifier
                .size(40.dp)
                .clip(VelarumRadii.sm),
        )
        Column(modifier = Modifier.weight(1f).padding(start = Spacing.s3)) {
            Text("VelarumPay", style = MaterialTheme.typography.titleLarge, color = VelarumTheme.colors.textStrong)
            Text("Self-custody wallet", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
        }
        IconButton(onClick = onRefresh, enabled = !refreshing) {
            Icon(Icons.Filled.Refresh, contentDescription = "Refresh balances", tint = VelarumTheme.colors.textStrong)
        }
        IconButton(onClick = onSearch) {
            Icon(Icons.Filled.Search, contentDescription = "Search", tint = VelarumTheme.colors.textStrong)
        }
        IconButton(onClick = onScan) {
            Icon(Icons.Filled.QrCodeScanner, contentDescription = "Scan", tint = VelarumTheme.colors.textStrong)
        }
    }
}
