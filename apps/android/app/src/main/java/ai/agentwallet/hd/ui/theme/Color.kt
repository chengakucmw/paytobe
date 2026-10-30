package ai.agentwallet.hd.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

/**
 * 原始色板，逐值来自 prototypes/html20260620/ds/tokens/colors.css（Velar Teal 设计系统）。
 * 注意：组件里不要直接引用这些「色阶」，应使用下面 [PaytobeColors] 的「语义角色」，
 * 这样以后调色只改一处。
 */
internal object PaytobePalette {
    // 品牌 · Velar Teal
    val teal50 = Color(0xFFE6F7F4)
    val teal400 = Color(0xFF2BB6A2)
    val teal500 = Color(0xFF0FA48E) // PRIMARY 主色
    val teal600 = Color(0xFF0B8676) // hover
    val teal700 = Color(0xFF0C6B5F) // active / 渐变中段

    // 中性 · 带绿调的墨色
    val ink950 = Color(0xFF07100D)
    val ink900 = Color(0xFF0B1310) // 深色卡 / CTA / 强调
    val ink700 = Color(0xFF28342F)
    val ink600 = Color(0xFF45524C) // 正文
    val ink500 = Color(0xFF64726B)
    val ink400 = Color(0xFF8B978F) // 次要文字
    val ink300 = Color(0xFFB6BFB9)
    val ink200 = Color(0xFFD8DEDA)
    val ink100 = Color(0xFFECF0EE)
    val ink50 = Color(0xFFF6F8F7) // surface-page 近白底
    val white = Color(0xFFFFFFFF)

    // 点缀 · 薄荷亮青（深色卡上的高亮）
    val mint400 = Color(0xFF43E3BD)

    // 语义功能色（涨/成功、跌/危险、警告、信息）
    val green500 = Color(0xFF1FB57A); val green50 = Color(0xFFE4F7EE)
    val red500 = Color(0xFFE5484D); val red50 = Color(0xFFFCEBEC)
    val amber500 = Color(0xFFF5A524); val amber50 = Color(0xFFFDF3E2)
    val blue500 = Color(0xFF2B8AEF); val blue50 = Color(0xFFE7F1FD)
}

/**
 * 语义色角色（对应 colors.css 的 SEMANTIC ALIASES）。风控 risk-safe/caution/danger
 * 与 success/pending/failed 同值，直接复用即可，未重复列出。
 */
@Immutable
class PaytobeColors(
    val primary: Color,
    val primaryHover: Color,
    val primaryActive: Color,
    val primarySoft: Color,
    val onPrimary: Color,
    val brandStrong: Color,
    val mint: Color,
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
fun PaytobeLightColors(): PaytobeColors = PaytobeColors(
    primary = PaytobePalette.teal500,
    primaryHover = PaytobePalette.teal600,
    primaryActive = PaytobePalette.teal700,
    primarySoft = PaytobePalette.teal50,
    onPrimary = PaytobePalette.white,
    brandStrong = PaytobePalette.teal700,
    mint = PaytobePalette.mint400,
    emphasis = PaytobePalette.ink900,
    onEmphasis = PaytobePalette.white,
    textStrong = PaytobePalette.ink900,
    textBody = PaytobePalette.ink600,
    textMuted = PaytobePalette.ink400,
    textFaint = PaytobePalette.ink300,
    surfacePage = PaytobePalette.ink50,
    surfaceCard = PaytobePalette.white,
    surfaceSunken = PaytobePalette.ink100,
    surfaceInverse = PaytobePalette.ink900,
    borderSubtle = PaytobePalette.ink100,
    borderDefault = PaytobePalette.ink200,
    borderStrong = PaytobePalette.ink300,
    success = PaytobePalette.green500,
    successBg = PaytobePalette.green50,
    pending = PaytobePalette.amber500,
    pendingBg = PaytobePalette.amber50,
    failed = PaytobePalette.red500,
    failedBg = PaytobePalette.red50,
    info = PaytobePalette.blue500,
    infoBg = PaytobePalette.blue50,
)
