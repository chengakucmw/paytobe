package ai.agentwallet.hd.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * 通过 CompositionLocal 向下传递自定义语义色。组件用 VelarumTheme.colors.xxx 取色。
 */
val LocalVelarumColors = staticCompositionLocalOf { velarumLightColors() }

/**
 * 把语义色映射到 Material3 的 ColorScheme，确保 Material 组件（按钮/卡片等）默认就是品牌色，
 * 而不是默认的紫色。其余更细的语义角色通过 VelarumTheme.colors 访问。
 */
private fun velarumColorScheme(c: VelarumColors) = lightColorScheme(
    primary = c.primary,
    onPrimary = c.onPrimary,
    primaryContainer = c.primarySoft,
    onPrimaryContainer = c.primaryActive,
    secondary = c.emphasis,
    onSecondary = c.onEmphasis,
    background = c.surfacePage,
    onBackground = c.textStrong,
    surface = c.surfaceCard,
    onSurface = c.textStrong,
    surfaceVariant = c.surfaceSunken,
    onSurfaceVariant = c.textMuted,
    outline = c.borderDefault,
    outlineVariant = c.borderSubtle,
    error = c.failed,
    onError = Color.White,
    errorContainer = c.failedBg,
    onErrorContainer = c.failed,
)

/** 全 App 主题包装。在 Activity 的 setContent { VelarumTheme { ... } } 里使用。 */
@Composable
fun VelarumTheme(content: @Composable () -> Unit) {
    val colors = velarumLightColors()
    CompositionLocalProvider(LocalVelarumColors provides colors) {
        MaterialTheme(
            colorScheme = velarumColorScheme(colors),
            typography = VelarumTypography,
            shapes = VelarumShapes,
            content = content,
        )
    }
}

/** 访问入口：VelarumTheme.colors.primary 等（函数与对象同名，仿 Material 的 MaterialTheme）。 */
object VelarumTheme {
    val colors: VelarumColors
        @Composable
        @ReadOnlyComposable
        get() = LocalVelarumColors.current
}
