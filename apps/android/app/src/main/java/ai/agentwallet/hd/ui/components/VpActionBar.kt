package ai.agentwallet.hd.ui.components

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumTheme

/**
 * 底部主操作栏（对照 web 的 .actionbar，--action-h: 92dp）。用于「发送/确认」等单屏主操作，
 * 固定在屏幕底部、抬到系统导航栏之上。把主按钮作为 content 传入。
 */
@Composable
fun VpActionBar(modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    Surface(
        color = VelarumTheme.colors.surfaceCard,
        shadowElevation = 12.dp,
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .navigationBarsPadding()
                .fillMaxWidth()
                .padding(horizontal = Spacing.s5, vertical = Spacing.s4),
            verticalAlignment = Alignment.CenterVertically,
            content = content,
        )
    }
}
