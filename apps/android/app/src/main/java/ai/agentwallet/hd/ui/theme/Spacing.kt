package ai.agentwallet.hd.ui.theme

import androidx.compose.ui.unit.dp

/**
 * 间距与尺寸令牌（4px 基准网格），来自 tokens/spacing.css。
 * 用法：Modifier.padding(Spacing.s6) 等。
 */
object Spacing {
    val s0 = 0.dp
    val s1 = 4.dp
    val s2 = 8.dp
    val s3 = 12.dp
    val s4 = 16.dp
    val s5 = 20.dp
    val s6 = 24.dp
    val s8 = 32.dp
    val s10 = 40.dp
    val s12 = 48.dp
    val s16 = 64.dp
    val s20 = 80.dp
    val s24 = 96.dp
    val s32 = 128.dp

    // 控件高度（触控最小命中区 44dp）
    val controlSm = 36.dp
    val controlMd = 44.dp
    val controlLg = 52.dp

    // 专属高度
    val navHeight = 78.dp        // --nav-h 底部导航
    val actionBarHeight = 92.dp  // --action-h 底部主操作栏
}
