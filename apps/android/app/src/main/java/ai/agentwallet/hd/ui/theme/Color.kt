package ai.agentwallet.hd.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

/**
 * 原始色板，逐值来自 design-system/VelarumPay-DS-Core/tokens/colors.css。
 * 注意：组件里不要直接引用这些「色阶」，应使用下面 [VelarumColors] 的「语义角色」，
 * 这样以后调色只改一处。
 */
internal object VelarumPalette {
    // 品牌绿
    val green50 = Color(0xFFECF5EE)
    val green600 = Color(0xFF2E7D43) // PRIMARY 主色
    val green700 = Color(0xFF246337) // 按下 / hover
    val green800 = Color(0xFF1C4E2C) // active

    // 鼠尾草绿（页面柔和底色）
    val sage100 = Color(0xFFE7F0DD) // surface-page
    val sage400 = Color(0xFF9CBE82)

    // 石灰中性色
    val stone0 = Color(0xFFFFFFFF)
    val stone100 = Color(0xFFEFF2EC)
    val stone200 = Color(0xFFE0E5DC)
    val stone300 = Color(0xFFC8CFC3)
    val stone400 = Color(0xFFA6AEA1)
    val stone500 = Color(0xFF7E867A)
    val stone700 = Color(0xFF424840)
    val stone900 = Color(0xFF1A1E1A) // ink 墨色 / 黑胶囊

    // 功能性强调色
    val amber100 = Color(0xFFFBF1D8)
    val amber500 = Color(0xFFDDA52B)
    val red100 = Color(0xFFFAE3E0)
    val red500 = Color(0xFFCD4A3E)
    val blue100 = Color(0xFFE1ECF4)
    val blue500 = Color(0xFF3E78A6)
}

/**
 * 语义色角色（对应 colors.css 的 SEMANTIC ALIASES）。风控 risk-safe/caution/danger
 * 与 success/pending/failed 同值，直接复用即可，未重复列出。
 */
@Immutable
class VelarumColors(
    val primary: Color,
    val primaryHover: Color,
    val primaryActive: Color,
    val primarySoft: Color,
    val onPrimary: Color,
    val emphasis: Color,
    val onEmphasis: Color,
    val textStrong: Color,
    val textBody: Color,
    val textMuted: Color,
    val textFaint: Color,
    val surfacePage: Color,
    val surfaceCard: Color,
    val surfaceSunken: Color,
    val surfaceInverse: Color,
    val borderSubtle: Color,
    val borderDefault: Color,
    val borderStrong: Color,
    val success: Color,
    val successBg: Color,
    val pending: Color,
    val pendingBg: Color,
    val failed: Color,
    val failedBg: Color,
    val info: Color,
    val infoBg: Color,
)

/** 浅色（也是目前唯一）主题的语义色映射。 */
fun velarumLightColors(): VelarumColors = VelarumColors(
    primary = VelarumPalette.green600,
    primaryHover = VelarumPalette.green700,
    primaryActive = VelarumPalette.green800,
    primarySoft = VelarumPalette.green50,
    onPrimary = Color.White,
    emphasis = VelarumPalette.stone900,
    onEmphasis = Color.White,
    textStrong = VelarumPalette.stone900,
    textBody = VelarumPalette.stone700,
    textMuted = VelarumPalette.stone500,
    textFaint = VelarumPalette.stone400,
    surfacePage = VelarumPalette.sage100,
    surfaceCard = VelarumPalette.stone0,
    surfaceSunken = VelarumPalette.stone100,
    surfaceInverse = VelarumPalette.stone900,
    borderSubtle = VelarumPalette.stone200,
    borderDefault = VelarumPalette.stone300,
    borderStrong = VelarumPalette.stone400,
    success = VelarumPalette.green600,
    successBg = VelarumPalette.green50,
    pending = VelarumPalette.amber500,
    pendingBg = VelarumPalette.amber100,
    failed = VelarumPalette.red500,
    failedBg = VelarumPalette.red100,
    info = VelarumPalette.blue500,
    infoBg = VelarumPalette.blue100,
)
