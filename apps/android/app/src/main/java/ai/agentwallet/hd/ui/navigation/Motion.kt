package ai.agentwallet.hd.ui.navigation

import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable

/**
 * 全局页面切换动效 —— 对标世界级产品（iOS 导航推/退 + Material 3 Motion）。
 *
 * 两类切换刻意做成两种手感（顶级 App 的关键细节）：
 *
 *  1) 层级前进/后退（如 首页→资产详情、设置→网络、收件箱→请求详情）：
 *     iOS 式「推入」——新页（不透明）从右整页滑入、干净盖住旧页；旧页以约 1/4 幅度向左
 *     视差让位。返回时镜像。注意：层级切换**不做淡入淡出**——淡入会让新页半透明、透出
 *     底下的旧页，正是之前「视觉错乱」的根因；纯滑动 + 不透明背景才干净利落。
 *
 *  2) 底部 Tab 之间（首页 / 收件箱 / 我的，三个平级页）：
 *     Material「shared-axis Z」纵深缩放——新页从略小处放大浮现、旧页缩远淡出（旧页先淡出、
 *     新页再淡入，二者几乎不交叠，所以不会糊在一起）。并且按底部导航顺序带方向：往右的
 *     tab = 往里钻（放大进入），往左的 tab = 退出来（缩小返回）。平级页不做左右滑。
 *
 * 缓动用 Material 3「强调」曲线：进入 decelerate、退出 accelerate，层级切换约 300ms。
 *
 * 另见本文件底部的 [screen]：它给**每个页面包一层不透明背景**，是消除「切换时两页透叠」
 * 视觉错乱的关键——动画期间进入的页面必须不透明，才能干净盖住正在退出的页面。
 */

// Material 3 强调缓动（贴近官方 path 的三次贝塞尔近似）
private val EmphasizedDecelerate: Easing = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1.0f)
private val EmphasizedAccelerate: Easing = CubicBezierEasing(0.3f, 0.0f, 0.8f, 0.15f)

private const val PUSH_MS = 300       // 层级推/退时长
private const val Z_IN_MS = 220       // 纵深 · 新页淡入+放大时长
private const val Z_OUT_MS = 90       // 纵深 · 旧页淡出时长（先快速淡出，避免与新页交叠）
private const val PARALLAX_DIVISOR = 4 // 层级旧页视差让位幅度 = 屏宽的 1/4

// 纵深缩放尺度：往里钻时新页从 0.88 放大到 1，旧页放大到 1.10 退场；返回时镜像。
private const val Z_SMALL = 0.88f
private const val Z_LARGE = 1.10f

// 底部导航的左→右顺序，决定纵深方向（靠右=更深）。需与 VpBottomNav 的 items 顺序一致。
private val tabOrder = listOf(Routes.HOME, Routes.INBOX, Routes.PROFILE)

/** 两个目的地是否都是底部导航的平级顶层页 → 用纵深缩放而非左右滑。 */
private fun AnimatedContentTransitionScope<NavBackStackEntry>.isTopLevelSwitch(): Boolean {
    val from = initialState.destination.route
    val to = targetState.destination.route
    return from in Routes.topLevel && to in Routes.topLevel
}

/** 是否「往更深处」切换（目标 tab 在当前 tab 右侧）→ 放大进入；否则缩小返回。 */
private fun AnimatedContentTransitionScope<NavBackStackEntry>.isTabForward(): Boolean {
    val from = tabOrder.indexOf(initialState.destination.route)
    val to = tabOrder.indexOf(targetState.destination.route)
    return to >= from
}

// --- 平级 Tab：shared-axis Z 纵深缩放（带方向）-------------------------------
private fun zEnter(forward: Boolean): EnterTransition =
    fadeIn(tween(Z_IN_MS, delayMillis = Z_OUT_MS, easing = EmphasizedDecelerate)) +
        scaleIn(
            tween(Z_IN_MS, delayMillis = Z_OUT_MS, easing = EmphasizedDecelerate),
            initialScale = if (forward) Z_SMALL else Z_LARGE,
        )

private fun zExit(forward: Boolean): ExitTransition =
    fadeOut(tween(Z_OUT_MS, easing = EmphasizedAccelerate)) +
        scaleOut(
            tween(PUSH_MS, easing = EmphasizedAccelerate),
            targetScale = if (forward) Z_LARGE else Z_SMALL,
        )

/** 前进 · 进入：平级→纵深放大浮现；层级→从右整页滑入（不透明，不淡入）。 */
fun AnimatedContentTransitionScope<NavBackStackEntry>.appEnter(): EnterTransition =
    if (isTopLevelSwitch()) {
        zEnter(isTabForward())
    } else {
        slideInHorizontally(tween(PUSH_MS, easing = EmphasizedDecelerate)) { fullWidth -> fullWidth }
    }

/** 前进 · 退出（被覆盖的旧页）：平级→缩远淡出；层级→向左视差让位（不淡出，避免透叠）。 */
fun AnimatedContentTransitionScope<NavBackStackEntry>.appExit(): ExitTransition =
    if (isTopLevelSwitch()) {
        zExit(isTabForward())
    } else {
        slideOutHorizontally(tween(PUSH_MS, easing = EmphasizedAccelerate)) { fullWidth -> -fullWidth / PARALLAX_DIVISOR }
    }

/** 返回 · 进入（重新露出的上一页）：平级→纵深浮现；层级→从左视差滑回（不淡入）。 */
fun AnimatedContentTransitionScope<NavBackStackEntry>.appPopEnter(): EnterTransition =
    if (isTopLevelSwitch()) {
        zEnter(isTabForward())
    } else {
        slideInHorizontally(tween(PUSH_MS, easing = EmphasizedDecelerate)) { fullWidth -> -fullWidth / PARALLAX_DIVISOR }
    }

/** 返回 · 退出（被弹出的当前页）：平级→缩远淡出；层级→向右整页滑出（不淡出）。 */
fun AnimatedContentTransitionScope<NavBackStackEntry>.appPopExit(): ExitTransition =
    if (isTopLevelSwitch()) {
        zExit(isTabForward())
    } else {
        slideOutHorizontally(tween(PUSH_MS, easing = EmphasizedAccelerate)) { fullWidth -> fullWidth }
    }

/**
 * 注册一个**带不透明背景**的导航目的地（替代直接用 composable）。
 *
 * 为什么需要它：各业务页自身没有铺背景（原来靠 Scaffold 的底色透出）。一旦做滑动/缩放
 * 这类位移动画，进入页与退出页会在动画期间同时绘制——若两页都透明，就会「透叠」在一起
 * （= 你录屏里看到的视觉错乱）。这里给每个页面套一层与主题同色的不透明背景，进入页便能
 * 干净地盖住退出页。toast/modal 宿主在 NavHost 之外，不受影响。
 */
fun NavGraphBuilder.screen(
    route: String,
    content: @Composable (NavBackStackEntry) -> Unit,
) {
    composable(route) { entry ->
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            content(entry)
        }
    }
}
