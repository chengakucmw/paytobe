package ai.agentwallet.hd.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumRadii
import ai.agentwallet.hd.ui.theme.VelarumTheme
import kotlinx.coroutines.delay

/** 一条 toast 的数据（对照 web 的 showToast(title, message, isError)）。 */
data class VpToastData(val title: String, val message: String, val isError: Boolean = false)

/** Toast 控制器：界面通过 LocalToastController.current.show(...) 触发。 */
class ToastController {
    var current by mutableStateOf<VpToastData?>(null)
        private set

    fun show(title: String, message: String, isError: Boolean = false) {
        current = VpToastData(title, message, isError)
    }

    fun dismiss() {
        current = null
    }
}

val LocalToastController = staticCompositionLocalOf { ToastController() }

/** Toast 宿主：放在最外层 Box，底部居中显示，约 2.6 秒后自动消失。 */
@Composable
fun VpToastHost(controller: ToastController, modifier: Modifier = Modifier) {
    val data = controller.current ?: return
    LaunchedEffect(data) {
        delay(2600)
        controller.dismiss()
    }
    Box(modifier = modifier.fillMaxSize().padding(Spacing.s5), contentAlignment = Alignment.BottomCenter) {
        Surface(
            shape = VelarumRadii.lg,
            color = if (data.isError) VelarumTheme.colors.failed else VelarumTheme.colors.surfaceInverse,
            shadowElevation = 8.dp,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(modifier = Modifier.padding(Spacing.s4)) {
                Text(data.title, style = MaterialTheme.typography.titleMedium, color = Color.White)
                Text(data.message, style = MaterialTheme.typography.bodyMedium, color = Color.White)
            }
        }
    }
}
