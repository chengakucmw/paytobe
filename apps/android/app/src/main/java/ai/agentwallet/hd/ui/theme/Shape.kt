package ai.agentwallet.hd.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

/**
 * 圆角令牌，来自 tokens/radii.css。pill 用百分比 50 自动得到半圆端，
 * circle 用 CircleShape（在用到的地方直接引 androidx.compose.foundation.shape.CircleShape）。
 */
object VelarumRadii {
    val xs = RoundedCornerShape(6.dp)
    val sm = RoundedCornerShape(10.dp)
    val md = RoundedCornerShape(14.dp)
    val lg = RoundedCornerShape(20.dp)
    val xl = RoundedCornerShape(28.dp)   // 主卡片圆角
    val xxl = RoundedCornerShape(36.dp)
    val pill = RoundedCornerShape(percent = 50)
}

/** 映射到 Material3 的 Shapes 槽位，供组件默认形状使用。 */
val VelarumShapes = Shapes(
    extraSmall = VelarumRadii.xs,
    small = VelarumRadii.sm,
    medium = VelarumRadii.md,
    large = VelarumRadii.lg,
    extraLarge = VelarumRadii.xl,
)
