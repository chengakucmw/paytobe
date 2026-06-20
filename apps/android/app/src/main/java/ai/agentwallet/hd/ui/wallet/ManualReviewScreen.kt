package ai.agentwallet.hd.ui.wallet

import androidx.compose.runtime.Composable

/**
 * 兼容性垫片：发送的「复核 → 签名 → 进度」已并入 [SendScreen] 的四步状态机
 * （ENTRY → RISK → CONFIRM → PROGRESS），不再是独立路由。
 * 此函数保留旧签名并直接委托给 [SendScreen]，使任何遗留引用仍可编译且行为一致；
 * 新导航不再使用它（见 VelarumApp 的 Routes.SEND）。
 */
@Composable
fun ManualReviewScreen(
    vm: SendViewModel,
    onEdit: () -> Unit,
    onFinishToHome: () -> Unit,
    onBalanceRefresh: () -> Unit,
) {
    SendScreen(
        vm = vm,
        onExit = onEdit,
        onFinishToHome = onFinishToHome,
        onBalanceRefresh = onBalanceRefresh,
    )
}
