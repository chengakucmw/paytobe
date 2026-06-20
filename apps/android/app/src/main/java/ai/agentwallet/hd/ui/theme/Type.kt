package ai.agentwallet.hd.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * 字体家族。
 *
 * TODO(后续)：换成品牌字体 —— Display: Quicksand，UI/正文: Hanken Grotesk，等宽: JetBrains Mono
 * （把 .ttf 放进 res/font/ 用 Font(R.font.xxx) 组成 FontFamily，或用 Google Fonts 可下载字体）。
 * 当前先用系统默认占位，只保证「字号 / 字重」按设计令牌，方便将来一处替换。
 */
object VelarumFonts {
    val display: FontFamily = FontFamily.Default   // → Quicksand
    val sans: FontFamily = FontFamily.Default      // → Hanken Grotesk
    val mono: FontFamily = FontFamily.Monospace    // → JetBrains Mono（地址/金额）
}

/**
 * 字号来自 tokens/typography.css 的 type scale（16px 为根）：
 * xs12 / sm13 / base15(UI默认) / md17 / lg20 / xl24 / 2xl30 / 3xl38 ...
 */
val VelarumTypography = Typography(
    displaySmall = TextStyle(fontFamily = VelarumFonts.display, fontWeight = FontWeight.SemiBold, fontSize = 38.sp, lineHeight = 44.sp),
    headlineMedium = TextStyle(fontFamily = VelarumFonts.display, fontWeight = FontWeight.SemiBold, fontSize = 30.sp, lineHeight = 36.sp),
    headlineSmall = TextStyle(fontFamily = VelarumFonts.display, fontWeight = FontWeight.SemiBold, fontSize = 24.sp, lineHeight = 30.sp),
    titleLarge = TextStyle(fontFamily = VelarumFonts.sans, fontWeight = FontWeight.SemiBold, fontSize = 20.sp, lineHeight = 26.sp),
    titleMedium = TextStyle(fontFamily = VelarumFonts.sans, fontWeight = FontWeight.Medium, fontSize = 17.sp, lineHeight = 24.sp),
    bodyLarge = TextStyle(fontFamily = VelarumFonts.sans, fontWeight = FontWeight.Normal, fontSize = 15.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontFamily = VelarumFonts.sans, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontFamily = VelarumFonts.sans, fontWeight = FontWeight.Medium, fontSize = 15.sp, lineHeight = 20.sp),
    labelMedium = TextStyle(fontFamily = VelarumFonts.sans, fontWeight = FontWeight.Medium, fontSize = 13.sp, lineHeight = 16.sp),
)
