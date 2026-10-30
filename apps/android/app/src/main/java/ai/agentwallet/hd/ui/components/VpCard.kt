package ai.agentwallet.hd.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.PaytobeRadii
import ai.agentwallet.hd.ui.theme.PaytobeTheme

/** 白底卡片：20dp 圆角 + 柔和阴影 + 20dp 内边距（对照原型的 .card）。 */
@Composable
fun VpCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(
        shape = PaytobeRadii.lg,
        color = PaytobeTheme.colors.surfaceCard,
        shadowElevation = 1.dp,
        modifier = modifier,
    ) {
        Column(modifier = Modifier.padding(Spacing.s5), content = content)
    }
}
