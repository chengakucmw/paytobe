package ai.agentwallet.hd.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

/**
 * 圆角令牌，来自 tokens/radii.css。pill 用百分比 50 自动得到半圆端，
 * circle 用 CircleShape（在用到的地方直接引 androidx.compose.foundation.shape.CircleShape）。
 */
object PaytobeRadii {
    val xs = RoundedCornerShape(8.dp)
    val sm = RoundedCornerShape(12.dp)
    val md = RoundedCornerShape(16.dp)
    val lg = RoundedCornerShape(20.dp)   // 标准卡片圆角（--radius-lg）
    val xl = RoundedCornerShape(24.dp)   // 主视觉/英雄卡（--radius-xl）
    val xxl = RoundedCornerShape(32.dp)
    val pill = RoundedCornerShape(percent = 50)
}

/** 映射到 Material3 的 Shapes 槽位，供组件默认形状使用。 */
val PaytobeShapes = Shapes(
    extraSmall = PaytobeRadii.xs,
    small = PaytobeRadii.sm,
    medium = PaytobeRadii.md,
    large = PaytobeRadii.lg,
    extraLarge = PaytobeRadii.xl,
)
