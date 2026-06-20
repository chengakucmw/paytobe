package ai.agentwallet.hd.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import ai.agentwallet.hd.R

/**
 * 字体家族（已打包进 res/font/，来自原型 ds/tokens/fonts.css 指定的三款 OFL 开源字体）：
 * Display: Space Grotesk，UI/正文: Manrope，等宽（地址/金额）: JetBrains Mono。
 */
object VelarumFonts {
    val display: FontFamily = FontFamily(
        Font(R.font.space_grotesk_medium, FontWeight.Medium),
        Font(R.font.space_grotesk_semibold, FontWeight.SemiBold),
        Font(R.font.space_grotesk_bold, FontWeight.Bold),
    )
    val sans: FontFamily = FontFamily(
        Font(R.font.manrope_regular, FontWeight.Normal),
        Font(R.font.manrope_medium, FontWeight.Medium),
        Font(R.font.manrope_semibold, FontWeight.SemiBold),
        Font(R.font.manrope_bold, FontWeight.Bold),
    )
    val mono: FontFamily = FontFamily(
        Font(R.font.jetbrains_mono_regular, FontWeight.Normal),
        Font(R.font.jetbrains_mono_medium, FontWeight.Medium),
        Font(R.font.jetbrains_mono_semibold, FontWeight.SemiBold),
    )
}

/**
 * 字号来自 ds/tokens/typography.css 的 type scale（16px 为基准正文）：
 * 2xs11 / xs12 / sm14 / md16(base) / lg18 / xl20 / 2xl24 / 3xl30 / 4xl38 / 5xl48
 */
val VelarumTypography = Typography(
    displaySmall = TextStyle(fontFamily = VelarumFonts.display, fontWeight = FontWeight.SemiBold, fontSize = 38.sp, lineHeight = 42.sp),
    headlineMedium = TextStyle(fontFamily = VelarumFonts.display, fontWeight = FontWeight.SemiBold, fontSize = 30.sp, lineHeight = 36.sp),
    headlineSmall = TextStyle(fontFamily = VelarumFonts.display, fontWeight = FontWeight.SemiBold, fontSize = 24.sp, lineHeight = 30.sp),
    titleLarge = TextStyle(fontFamily = VelarumFonts.display, fontWeight = FontWeight.SemiBold, fontSize = 20.sp, lineHeight = 26.sp),
    titleMedium = TextStyle(fontFamily = VelarumFonts.sans, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 22.sp),
    bodyLarge = TextStyle(fontFamily = VelarumFonts.sans, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontFamily = VelarumFonts.sans, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 20.sp),
    labelLarge = TextStyle(fontFamily = VelarumFonts.sans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 18.sp),
    labelMedium = TextStyle(fontFamily = VelarumFonts.sans, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, lineHeight = 16.sp),
)
