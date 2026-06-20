package ai.agentwallet.hd.ui.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import ai.agentwallet.hd.ui.theme.VelarumRadii
import ai.agentwallet.hd.ui.theme.VelarumTheme

/**
 * 主题化输入框。后续发送页的金额/备注输入会复用它；键盘让位由所在屏的 imePadding 处理，
 * 输入框本身保持标准 Material3 行为，聚焦即弹键盘（原生天然没有旧 WebView 的抢焦点问题）。
 */
@Composable
fun VpTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    singleLine: Boolean = true,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        placeholder = placeholder?.let { p -> @Composable { Text(p) } },
        singleLine = singleLine,
        keyboardOptions = keyboardOptions,
        shape = VelarumRadii.md,
        modifier = modifier.fillMaxWidth(),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = VelarumTheme.colors.primary,
            focusedLabelColor = VelarumTheme.colors.primary,
            cursorColor = VelarumTheme.colors.primary,
        ),
    )
}
