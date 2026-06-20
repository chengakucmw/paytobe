package ai.agentwallet.hd.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumTheme

/** 首页顶部栏：品牌名 + 副标题 + 搜索/扫码（对照 web 的 .topbar，仅首页显示）。 */
@Composable
fun VpHomeTopBar(onSearch: () -> Unit, onScan: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(horizontal = Spacing.s5, vertical = Spacing.s3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text("VelarumPay", style = MaterialTheme.typography.titleLarge, color = VelarumTheme.colors.textStrong)
            Text("Personal wallet", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
        }
        IconButton(onClick = onSearch) {
            Icon(Icons.Filled.Search, contentDescription = "Search", tint = VelarumTheme.colors.textStrong)
        }
        IconButton(onClick = onScan) {
            Icon(Icons.Filled.QrCodeScanner, contentDescription = "Scan", tint = VelarumTheme.colors.textStrong)
        }
    }
}
