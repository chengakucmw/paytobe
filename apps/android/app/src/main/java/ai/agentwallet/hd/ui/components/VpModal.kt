package ai.agentwallet.hd.ui.components

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.window.Dialog
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumTheme

/** 一个弹窗的数据（对照 web 的 renderModal：标题 + 文案 + 确认/取消）。 */
data class VpModalData(
    val title: String,
    val message: String,
    val confirmLabel: String = "OK",
    val onConfirm: () -> Unit = {},
    val dismissLabel: String? = null,
)

/** 弹窗控制器：界面通过 LocalModalController.current.show(...) 触发。 */
class ModalController {
    var current by mutableStateOf<VpModalData?>(null)
        private set

    fun show(data: VpModalData) {
        current = data
    }

    fun dismiss() {
        current = null
    }
}

val LocalModalController = staticCompositionLocalOf { ModalController() }

/** 弹窗宿主：居中卡片对话框。 */
@Composable
fun VpModalHost(controller: ModalController) {
    val data = controller.current ?: return
    Dialog(onDismissRequest = { controller.dismiss() }) {
        VpCard(modifier = Modifier.fillMaxWidth()) {
            Text(data.title, style = MaterialTheme.typography.headlineSmall, color = VelarumTheme.colors.textStrong)
            Spacer(Modifier.height(Spacing.s2))
            Text(data.message, style = MaterialTheme.typography.bodyLarge, color = VelarumTheme.colors.textBody)
            Spacer(Modifier.height(Spacing.s5))
            VpPrimaryButton(
                text = data.confirmLabel,
                onClick = {
                    data.onConfirm()
                    controller.dismiss()
                },
                modifier = Modifier.fillMaxWidth(),
            )
            val dismissLabel = data.dismissLabel
            if (dismissLabel != null) {
                Spacer(Modifier.height(Spacing.s2))
                VpOutlineButton(
                    text = dismissLabel,
                    onClick = { controller.dismiss() },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}
