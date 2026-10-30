package ai.agentwallet.hd.ui.wallet

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.agentwallet.hd.BuildConfig
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpPrimaryButton
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.VpTextField
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.PaytobeFonts
import ai.agentwallet.hd.ui.theme.PaytobeTheme

/** 开发者（原生）。对照 web 的 renderDeveloper：设备 ID/token、relay URL、配对入口。 */
@Composable
fun DeveloperScreen(vm: DeveloperViewModel, onBack: () -> Unit, onPair: () -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val info = ui.info
    var relay by remember(info) { mutableStateOf(info?.relayUrl ?: "") }
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Open Platform", title = "Developer", onBack = onBack)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8).imePadding(),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            VpCard(modifier = Modifier.fillMaxWidth()) {
                Text("Device", style = MaterialTheme.typography.titleMedium, color = PaytobeTheme.colors.textStrong)
                LabeledMono("Device ID", info?.deviceId ?: "—")
                LabeledMono("Device token", info?.deviceToken ?: "—")
            }
            if (BuildConfig.MANAGED_PLATFORM_SERVICE) {
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Text("Platform service", style = MaterialTheme.typography.titleMedium, color = PaytobeTheme.colors.textStrong)
                    Text("Managed automatically for this testnet build. Connect Key does not require a Relay URL.", style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textBody)
                }
            } else {
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Text("Platform service", style = MaterialTheme.typography.titleMedium, color = PaytobeTheme.colors.textStrong, modifier = Modifier.padding(bottom = Spacing.s2))
                    VpTextField(value = relay, onValueChange = { relay = it }, label = "Platform API URL")
                    VpPrimaryButton("Save Platform API URL", onClick = { vm.setRelay(relay) }, modifier = Modifier.fillMaxWidth().padding(top = Spacing.s2))
                }
            }
            VpPrimaryButton("Pair a local agent", onClick = onPair, modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun LabeledMono(label: String, value: String) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = Spacing.s1)) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textMuted)
        Text(value, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = PaytobeFonts.mono), color = PaytobeTheme.colors.textBody)
    }
}
