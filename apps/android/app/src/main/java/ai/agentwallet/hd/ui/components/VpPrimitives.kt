package ai.agentwallet.hd.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumRadii
import ai.agentwallet.hd.ui.theme.VelarumTheme

/**
 * 语气：对照 design tokens 的 status/risk 语义（safe/caution/danger/info）。
 * EXPIRED 是中性「过期/失效」态：哑光石板灰 + 时钟图标，从而与 info(蓝)/failed(红) 区分开。
 */
enum class VpTone { SAFE, CAUTION, DANGER, INFO, EXPIRED }

/** 把后端的 tone/risk 字符串映射为 VpTone。 */
fun vpToneOf(value: String?): VpTone = when (value?.lowercase()) {
    "safe", "success" -> VpTone.SAFE
    "caution", "warning", "pending" -> VpTone.CAUTION
    "danger", "error", "failed" -> VpTone.DANGER
    "expired", "muted" -> VpTone.EXPIRED
    else -> VpTone.INFO
}

@Composable
internal fun toneAccent(tone: VpTone): Color = when (tone) {
    VpTone.SAFE -> VelarumTheme.colors.success
    VpTone.CAUTION -> VelarumTheme.colors.pending
    VpTone.DANGER -> VelarumTheme.colors.failed
    VpTone.INFO -> VelarumTheme.colors.info
    VpTone.EXPIRED -> VelarumTheme.colors.textMuted
}

@Composable
internal fun toneBackground(tone: VpTone): Color = when (tone) {
    VpTone.SAFE -> VelarumTheme.colors.successBg
    VpTone.CAUTION -> VelarumTheme.colors.pendingBg
    VpTone.DANGER -> VelarumTheme.colors.failedBg
    VpTone.INFO -> VelarumTheme.colors.infoBg
    VpTone.EXPIRED -> VelarumTheme.colors.surfaceSunken
}

private fun toneIcon(tone: VpTone): ImageVector = when (tone) {
    VpTone.SAFE -> Icons.Filled.CheckCircle
    VpTone.CAUTION -> Icons.Filled.Warning
    VpTone.DANGER -> Icons.Filled.Warning
    VpTone.INFO -> Icons.Filled.Info
    VpTone.EXPIRED -> Icons.Filled.Schedule
}

/** 大写小标签（对照 web 的 .vp-eyebrow）。 */
@Composable
fun VpEyebrow(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text.uppercase(),
        style = MaterialTheme.typography.labelMedium.copy(letterSpacing = 1.5.sp),
        color = VelarumTheme.colors.primary,
        modifier = modifier,
    )
}

/** 小药丸徽标（对照 web 的 badge）。 */
@Composable
fun VpBadge(text: String, tone: VpTone, modifier: Modifier = Modifier) {
    Surface(shape = VelarumRadii.pill, color = toneBackground(tone), modifier = modifier) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelMedium,
            color = toneAccent(tone),
            modifier = Modifier.padding(horizontal = Spacing.s3, vertical = Spacing.s1),
        )
    }
}

/** 一行「标签 — 值」（对照 web 的 fact()）。 */
@Composable
fun VpFactRow(label: String, value: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier.fillMaxWidth().padding(vertical = Spacing.s2),
        horizontalArrangement = Arrangement.spacedBy(Spacing.s3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textStrong, textAlign = TextAlign.End)
    }
}

/** 一行「标签 — 徽标」。 */
@Composable
fun VpFactRow(label: String, badge: String, tone: VpTone, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier.fillMaxWidth().padding(vertical = Spacing.s2),
        horizontalArrangement = Arrangement.spacedBy(Spacing.s3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted, modifier = Modifier.weight(1f))
        VpBadge(badge, tone)
    }
}

/** 风险/状态横幅（对照 web 的 .risk safe/caution/danger）。 */
@Composable
fun VpRiskBanner(tone: VpTone, title: String, body: String, modifier: Modifier = Modifier) {
    Surface(shape = VelarumRadii.lg, color = toneBackground(tone), modifier = modifier.fillMaxWidth()) {
        Row(modifier = Modifier.padding(Spacing.s4), horizontalArrangement = Arrangement.spacedBy(Spacing.s3)) {
            Icon(toneIcon(tone), contentDescription = null, tint = toneAccent(tone))
            Column {
                Text(title, style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                Text(body, style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textBody)
            }
        }
    }
}

/** 二级页顶部栏：返回箭头 + 小标签 + 标题（对照 web 的 renderSubheader）。 */
@Composable
fun VpSubheader(eyebrow: String, title: String, modifier: Modifier = Modifier, onBack: (() -> Unit)? = null) {
    Row(
        modifier = modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = Spacing.s4, vertical = Spacing.s3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s1),
    ) {
        if (onBack != null) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = VelarumTheme.colors.textStrong)
            }
        }
        Column {
            VpEyebrow(eyebrow)
            Text(title, style = MaterialTheme.typography.titleLarge, color = VelarumTheme.colors.textStrong)
        }
    }
}

/** 可选中的胶囊 chip（资产选择等，Receive/Send 共用）。 */
@Composable
fun VpChip(label: String, active: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Surface(
        shape = VelarumRadii.pill,
        color = if (active) VelarumTheme.colors.primary else VelarumTheme.colors.surfaceCard,
        border = if (active) null else BorderStroke(1.dp, VelarumTheme.colors.borderDefault),
        modifier = modifier.clickable { onClick() },
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            color = if (active) VelarumTheme.colors.onPrimary else VelarumTheme.colors.textStrong,
            modifier = Modifier.padding(horizontal = Spacing.s4, vertical = Spacing.s2),
        )
    }
}

/** 菜单/设置项行：可点的卡片，标题 + 副标题 + 可选徽标（对照 web 的 settingsLink/request-card）。 */
@Composable
fun VpMenuRow(
    title: String,
    subtitle: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    badgeText: String? = null,
    badgeTone: VpTone = VpTone.INFO,
) {
    VpCard(modifier = modifier.fillMaxWidth().clickable { onClick() }) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.s3),
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                if (subtitle.isNotBlank()) {
                    Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
                }
            }
            if (badgeText != null) VpBadge(badgeText, badgeTone)
        }
    }
}

/** 带编号的步骤行（对照 web 的 .setup-step）。 */
@Composable
fun VpSetupStep(number: String, title: String, body: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier.fillMaxWidth().padding(vertical = Spacing.s2),
        horizontalArrangement = Arrangement.spacedBy(Spacing.s3),
    ) {
        Text(number, style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.primary)
        Column {
            Text(title, style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
            Text(body, style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
        }
    }
}
