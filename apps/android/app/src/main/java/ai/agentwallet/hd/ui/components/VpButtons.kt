package ai.agentwallet.hd.ui.components

import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.PaytobeRadii
import ai.agentwallet.hd.ui.theme.PaytobeTheme

/** 主操作按钮：品牌绿、胶囊形（对照 web 的 primary）。 */
@Composable
fun VpPrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = PaytobeRadii.pill,
        colors = ButtonDefaults.buttonColors(
            containerColor = PaytobeTheme.colors.primary,
            contentColor = PaytobeTheme.colors.onPrimary,
        ),
        modifier = modifier.heightIn(min = Spacing.controlLg),
    ) { Text(text, style = MaterialTheme.typography.labelLarge) }
}

/** 高强调按钮：黑色胶囊（对照 web 的 .vp-pill / emphasis）。 */
@Composable
fun VpEmphasisButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = PaytobeRadii.pill,
        colors = ButtonDefaults.buttonColors(
            containerColor = PaytobeTheme.colors.emphasis,
            contentColor = PaytobeTheme.colors.onEmphasis,
        ),
        modifier = modifier.heightIn(min = Spacing.controlLg),
    ) { Text(text, style = MaterialTheme.typography.labelLarge) }
}

/** 白色按钮：用于深色余额卡上的 Send / Receive。 */
@Composable
fun VpWhiteButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = PaytobeRadii.pill,
        colors = ButtonDefaults.buttonColors(
            containerColor = Color.White,
            contentColor = PaytobeTheme.colors.textStrong,
        ),
        modifier = modifier.heightIn(min = Spacing.controlMd),
    ) { Text(text, style = MaterialTheme.typography.labelLarge) }
}

/** 次要按钮：描边 + 墨色文字。 */
@Composable
fun VpOutlineButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        shape = PaytobeRadii.pill,
        colors = ButtonDefaults.outlinedButtonColors(contentColor = PaytobeTheme.colors.textStrong),
        modifier = modifier.heightIn(min = Spacing.controlLg),
    ) { Text(text, style = MaterialTheme.typography.labelLarge) }
}
