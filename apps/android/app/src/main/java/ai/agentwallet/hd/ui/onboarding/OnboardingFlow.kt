package ai.agentwallet.hd.ui.onboarding

import android.app.Activity
import android.view.WindowManager
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import ai.agentwallet.hd.R
import ai.agentwallet.hd.ui.components.VpBadge
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpFactRow
import ai.agentwallet.hd.ui.components.VpOutlineButton
import ai.agentwallet.hd.ui.components.VpPrimaryButton
import ai.agentwallet.hd.ui.components.VpRiskBanner
import ai.agentwallet.hd.ui.components.VpSetupStep
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.VpTextField
import ai.agentwallet.hd.ui.components.VpTone
import ai.agentwallet.hd.ui.navigation.Routes
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumRadii
import ai.agentwallet.hd.ui.theme.VelarumTheme

/**
 * 开通流程（无底部导航）。一个 NavController 串起 4 屏，共享一个 OnboardingViewModel。
 * onFinished 即「hand-off 到 WebView」（由 MainComposeActivity 提供）。
 */
@Composable
fun OnboardingHost(startRoute: String, onFinished: () -> Unit) {
    val navController = rememberNavController()
    val vm: OnboardingViewModel = viewModel()
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets(0.dp, 0.dp, 0.dp, 0.dp),
    ) { inner ->
        NavHost(
            navController = navController,
            startDestination = startRoute,
            modifier = Modifier.padding(inner),
        ) {
            composable(Routes.CREATE_WALLET) {
                CreateWalletScreen(
                    vm = vm,
                    onImport = { navController.navigate(Routes.KEY_IMPORT) },
                    onDeviceRisk = { navController.navigate(Routes.DEVICE_RISK) },
                    onCreated = {
                        navController.navigate(Routes.KEY_BACKUP) {
                            popUpTo(Routes.CREATE_WALLET) { inclusive = true }
                            launchSingleTop = true
                        }
                    },
                )
            }
            composable(Routes.KEY_IMPORT) {
                KeyImportScreen(vm = vm, onBack = { navController.popBackStack() }, onImported = onFinished)
            }
            composable(Routes.KEY_BACKUP) {
                KeyBackupScreen(vm = vm, onConfirmed = onFinished)
            }
            composable(Routes.DEVICE_RISK) {
                DeviceRiskScreen(onBack = { navController.popBackStack() })
            }
        }
    }
}

@Composable
private fun CreateWalletScreen(
    vm: OnboardingViewModel,
    onImport: () -> Unit,
    onDeviceRisk: () -> Unit,
    onCreated: () -> Unit,
) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    LaunchedEffect(ui.created) { if (ui.created) onCreated() }
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Security", title = "Create wallet")
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            WelcomeHero()
            VpCard(modifier = Modifier.fillMaxWidth()) {
                VpBadge("V1 default", VpTone.SAFE)
                Spacer(Modifier.height(Spacing.s2))
                Text("Traditional 24-word self-custody", style = MaterialTheme.typography.titleLarge, color = VelarumTheme.colors.textStrong)
                Spacer(Modifier.height(Spacing.s2))
                Text(
                    "The wallet generates the recovery phrase on this device, encrypts the seed locally, and never asks the backend for a key share.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = VelarumTheme.colors.textBody,
                )
            }
            VpCard(modifier = Modifier.fillMaxWidth()) {
                VpSetupStep("01", "Generate 256-bit entropy", "System randomness creates a 24-word BIP-39 recovery phrase locally.")
                VpSetupStep("02", "Encrypt keyring secret", "The seed is encrypted before storage; the key is protected by Android Keystore / StrongBox.")
                VpSetupStep("03", "Verify backup before high-risk use", "Until the phrase is verified, large mainnet transfers stay limited.")
            }
            val err = ui.error
            if (err != null) VpRiskBanner(VpTone.DANGER, "Could not create wallet", err)
            VpPrimaryButton(
                text = if (ui.busy) "Creating…" else "Create new wallet",
                onClick = { vm.createWallet() },
                enabled = !ui.busy,
                modifier = Modifier.fillMaxWidth(),
            )
            VpOutlineButton(
                text = "Import recovery phrase",
                onClick = onImport,
                enabled = !ui.busy,
                modifier = Modifier.fillMaxWidth(),
            )
            if (ui.busy) {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            }
            Text(
                text = "Device security check",
                style = MaterialTheme.typography.labelLarge,
                color = VelarumTheme.colors.primary,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().clickable { onDeviceRisk() }.padding(vertical = Spacing.s2),
            )
        }
    }
}

/** 品牌欢迎卡（对照原型 01 Welcome 的 "Your keys. Your crypto." 主张）。 */
@Composable
private fun WelcomeHero() {
    Surface(shape = VelarumRadii.xl, color = VelarumTheme.colors.surfaceInverse, modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Spacing.s6), verticalArrangement = Arrangement.spacedBy(Spacing.s2)) {
            Image(
                painter = painterResource(R.drawable.velarum_mark),
                contentDescription = "VelarumPay",
                modifier = Modifier.size(44.dp),
            )
            Text("Your keys. Your crypto.", style = MaterialTheme.typography.headlineSmall, color = Color.White)
            Text(
                "A self-custody wallet for Stellar. Sign every payment yourself — agents can ask, only you approve.",
                style = MaterialTheme.typography.bodyMedium,
                color = Color.White.copy(alpha = 0.82f),
            )
        }
    }
}

@Composable
private fun KeyImportScreen(vm: OnboardingViewModel, onBack: () -> Unit, onImported: () -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    var phrase by remember { mutableStateOf("") }
    LaunchedEffect(ui.imported) { if (ui.imported) onImported() }
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Security", title = "Import or recover", onBack = onBack)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8).imePadding(),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            VpRiskBanner(VpTone.SAFE, "Local import only", "The secret is never sent to VelarumPay servers, agents, or connected apps.")
            VpTextField(
                value = phrase,
                onValueChange = { phrase = it },
                label = "Recovery phrase (12 / 15 / 18 / 21 / 24 words)",
                placeholder = "word1 word2 word3 …",
                singleLine = false,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None),
                modifier = Modifier.heightIn(min = 120.dp),
            )
            VpRiskBanner(
                VpTone.DANGER,
                "Only enter your phrase on a device you trust",
                "VelarumPay never sends your recovery phrase anywhere.",
            )
            val err = ui.error
            if (err != null) VpRiskBanner(VpTone.DANGER, "Phrase failed local validation", err)
            VpPrimaryButton(
                text = if (ui.busy) "Importing…" else "Import to this device",
                onClick = { vm.importWallet(phrase) },
                enabled = !ui.busy && phrase.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun KeyBackupScreen(vm: OnboardingViewModel, onConfirmed: () -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current
    // 展示助记词时开启 FLAG_SECURE，阻止截屏/录屏与任务切换器预览（UI 层安全，未改业务逻辑）。
    DisposableEffect(Unit) {
        val window = (context as? Activity)?.window
        window?.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    }
    LaunchedEffect(Unit) { vm.ensureMnemonicLoaded() }
    LaunchedEffect(ui.backupConfirmed) { if (ui.backupConfirmed) onConfirmed() }
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Security", title = "Recovery phrase backup")
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            VpRiskBanner(
                VpTone.DANGER,
                "Write these words offline",
                "Anyone with this phrase can control the wallet. Do not screenshot, copy, upload, or send it.",
            )
            WordGrid(words = ui.mnemonic)
            VpCard(modifier = Modifier.fillMaxWidth()) {
                Text("Backup controls", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                Spacer(Modifier.height(Spacing.s2))
                VpFactRow("Screenshot protection", "On", VpTone.SAFE)
                VpFactRow("Clipboard copy", "Disabled", VpTone.SAFE)
                VpFactRow("Stored as", "Encrypted keyring", VpTone.SAFE)
            }
            VpPrimaryButton(
                text = "I have written it down",
                onClick = { vm.confirmBackup() },
                enabled = ui.mnemonic.isNotEmpty(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun WordGrid(words: List<String>) {
    if (words.isEmpty()) {
        Box(Modifier.fillMaxWidth().padding(Spacing.s6), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }
    Surface(shape = VelarumRadii.xl, color = VelarumTheme.colors.surfaceInverse, modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Spacing.s4), verticalArrangement = Arrangement.spacedBy(Spacing.s2)) {
            words.chunked(2).forEachIndexed { rowIndex, pair ->
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s2)) {
                    pair.forEachIndexed { col, word ->
                        WordCell(index = rowIndex * 2 + col + 1, word = word, modifier = Modifier.weight(1f))
                    }
                    if (pair.size == 1) Spacer(Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun WordCell(index: Int, word: String, modifier: Modifier = Modifier) {
    Surface(
        shape = VelarumRadii.sm,
        color = Color.White.copy(alpha = 0.08f),
        modifier = modifier,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = Spacing.s3, vertical = Spacing.s2),
            horizontalArrangement = Arrangement.spacedBy(Spacing.s2),
        ) {
            Text("$index", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textFaint)
            Text(word, style = MaterialTheme.typography.bodyMedium, color = Color.White)
        }
    }
}

@Composable
private fun DeviceRiskScreen(onBack: () -> Unit) {
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Security", title = "Device risk controls", onBack = onBack)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            VpCard(modifier = Modifier.fillMaxWidth()) {
                Text("Runtime protection", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                Spacer(Modifier.height(Spacing.s2))
                VpFactRow("Jailbreak / root", "No signal", VpTone.SAFE)
                VpFactRow("Hook frameworks", "No Frida/Xposed signal", VpTone.SAFE)
                VpFactRow("Repackaging", "Signature valid", VpTone.SAFE)
                VpFactRow("Screenshots on secrets", "Blocked", VpTone.SAFE)
                VpFactRow("App switcher preview", "Hidden on secret pages", VpTone.SAFE)
            }
            VpRiskBanner(
                VpTone.CAUTION,
                "Risk signals reduce capabilities",
                "A risky device can lower limits, block reveal/export, or require extra confirmation. Client checks are signals, not the only boundary.",
            )
            VpPrimaryButton(text = "Done", onClick = onBack, modifier = Modifier.fillMaxWidth())
        }
    }
}
