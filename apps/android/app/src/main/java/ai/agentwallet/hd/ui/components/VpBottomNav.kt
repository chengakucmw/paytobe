package ai.agentwallet.hd.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import ai.agentwallet.hd.ui.navigation.Routes
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.PaytobeTheme

private data class VpNavItem(val route: String, val label: String, val icon: ImageVector, val badge: Int = 0)

/**
 * 底部导航：3 个 tab（Home / Inbox / Profile），对照 web 的 renderNav。
 * 高 78dp（--nav-h），白底；inbox 带待处理角标；Surface 延伸到系统导航栏下并用
 * navigationBarsPadding 把内容抬到手势条之上。
 */
@Composable
fun VpBottomNav(currentRoute: String?, onSelect: (String) -> Unit, pendingCount: Int = 0) {
    val items = listOf(
        VpNavItem(Routes.HOME, "Home", Icons.Filled.AccountBalanceWallet),
        VpNavItem(Routes.INBOX, "Inbox", Icons.Filled.Bolt, badge = pendingCount),
        VpNavItem(Routes.PROFILE, "Profile", Icons.Filled.Person),
    )
    Surface(color = PaytobeTheme.colors.surfaceCard, shadowElevation = 0.dp) {
        Column(modifier = Modifier.navigationBarsPadding()) {
            Row(
                modifier = Modifier.fillMaxWidth().height(Spacing.navHeight),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                items.forEach { item ->
                    val active = currentRoute == item.route
                    val tint = if (active) PaytobeTheme.colors.primary else PaytobeTheme.colors.textMuted
                    val interactionSource = remember { MutableInteractionSource() }
                    Column(
                        modifier = Modifier
                            .selectable(
                                selected = active,
                                onClick = { onSelect(item.route) },
                                indication = null,
                                interactionSource = interactionSource,
                            ),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(Spacing.s1),
                    ) {
                        if (item.badge > 0) {
                            BadgedBox(badge = { Badge { Text(item.badge.toString()) } }) {
                                Icon(item.icon, contentDescription = item.label, tint = tint, modifier = Modifier.size(24.dp))
                            }
                        } else {
                            Icon(item.icon, contentDescription = item.label, tint = tint, modifier = Modifier.size(24.dp))
                        }
                        Text(item.label, style = MaterialTheme.typography.labelMedium, color = tint)
                    }
                }
            }
        }
    }
}
