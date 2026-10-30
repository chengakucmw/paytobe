package ai.agentwallet.hd.ui.onboarding

import android.app.Activity
import android.view.WindowManager
import androidx.compose.foundation.BorderStroke
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
import androidx.navigation.compose.rememberNavController
import ai.agentwallet.hd.ui.navigation.screen
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
import ai.agentwallet.hd.ui.navigation.appEnter
import ai.agentwallet.hd.ui.navigation.appExit
import ai.agentwallet.hd.ui.navigation.appPopEnter
import ai.agentwallet.hd.ui.navigation.appPopExit
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.PaytobeRadii
import ai.agentwallet.hd.ui.theme.PaytobeTheme

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
            enterTransition = { appEnter() },
            exitTransition = { appExit() },
            popEnterTransition = { appPopEnter() },
            popExitTransition = { appPopExit() },
        ) {
            screen(Routes.CREATE_WALLET) {
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
            screen(Routes.KEY_IMPORT) {
                KeyImportScreen(vm = vm, onBack = { navController.popBackStack() }, onImported = onFinished)
            }
            screen(Routes.KEY_BACKUP) {
                KeyBackupScreen(
                    vm = vm,
                    onVerify = { navController.navigate(Routes.KEY_VERIFY) },
                )
            }
            screen(Routes.KEY_VERIFY) {
                KeyVerifyScreen(
                    vm = vm,
                    onVerified = onFinished,
                    // 点错 / 主动复习 → 回到备份页重新核对助记词。
                    onReview = { navController.popBackStack(Routes.KEY_BACKUP, inclusive = false) },
                )
            }
            screen(Routes.DEVICE_RISK) {
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
                Text("Traditional 24-word self-custody", style = MaterialTheme.typography.titleLarge, color = PaytobeTheme.colors.textStrong)
                Spacer(Modifier.height(Spacing.s2))
                Text(
                    "The wallet generates the recovery phrase on this device, encrypts the seed locally, and never asks the backend for a key share.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = PaytobeTheme.colors.textBody,
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
                color = PaytobeTheme.colors.primary,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().clickable { onDeviceRisk() }.padding(vertical = Spacing.s2),
            )
        }
    }
}

/** 品牌欢迎卡（对照原型 01 Welcome 的 "Your keys. Your crypto." 主张）。 */
@Composable
private fun WelcomeHero() {
    Surface(shape = PaytobeRadii.xl, color = PaytobeTheme.colors.surfaceInverse, modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Spacing.s6), verticalArrangement = Arrangement.spacedBy(Spacing.s2)) {
            Image(
                painter = painterResource(R.drawable.paytobe_mark),
                contentDescription = "Paytobe",
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
            VpRiskBanner(VpTone.SAFE, "Local import only", "The secret is never sent to Paytobe servers, agents, or connected apps.")
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
                "Paytobe never sends your recovery phrase anywhere.",
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
private fun KeyBackupScreen(vm: OnboardingViewModel, onVerify: () -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current
    // 展示助记词时开启 FLAG_SECURE，阻止截屏/录屏与任务切换器预览（UI 层安全，未改业务逻辑）。
    DisposableEffect(Unit) {
        val window = (context as? Activity)?.window
        window?.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    }
    LaunchedEffect(Unit) { vm.ensureMnemonicLoaded() }
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
            // 从验证页点错回来时提示用户重新核对（决策：点错回到备份页复习）。
            if (ui.verifyMismatch) {
                VpRiskBanner(
                    VpTone.CAUTION,
                    "That didn't match",
                    "Re-read your phrase in order, then tap Verify again.",
                )
            }
            WordGrid(words = ui.mnemonic)
            VpCard(modifier = Modifier.fillMaxWidth()) {
                Text("Backup controls", style = MaterialTheme.typography.titleMedium, color = PaytobeTheme.colors.textStrong)
                Spacer(Modifier.height(Spacing.s2))
                VpFactRow("Screenshot protection", "On", VpTone.SAFE)
                VpFactRow("Clipboard copy", "Disabled", VpTone.SAFE)
                VpFactRow("Stored as", "Encrypted keyring", VpTone.SAFE)
            }
            // 不再「点一下即完成」：必须进入验证页按顺序点选正确单词，对了才放行进入钱包。
            VpPrimaryButton(
                text = "I've written it down — Verify",
                onClick = onVerify,
                enabled = ui.mnemonic.isNotEmpty(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/**
 * 助记词验证页（OKX 风格「按顺序点选」）：给出若干编号空位 + 打乱的候选词池，
 * 用户必须为每个空位按顺序点中正确的词。全部正确 → confirmBackup() 放行进入钱包；
 * 点错 → 标记并回到备份页复习后重试（验证用纯函数 SeedVerification，不碰任何密钥/签名逻辑）。
 */
@Composable
private fun KeyVerifyScreen(
    vm: OnboardingViewModel,
    onVerified: () -> Unit,
    onReview: () -> Unit,
) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current
    DisposableEffect(Unit) {
        val window = (context as? Activity)?.window
        window?.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    }
    LaunchedEffect(Unit) {
        vm.ensureMnemonicLoaded()
        vm.clearVerifyMismatch()
    }
    LaunchedEffect(ui.backupConfirmed) { if (ui.backupConfirmed) onVerified() }

    val words = ui.mnemonic
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Security", title = "Verify recovery phrase", onBack = onReview)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            if (words.isEmpty()) {
                Box(Modifier.fillMaxWidth().padding(Spacing.s6), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            } else {
                // 每次进入该屏生成一次新挑战（位置 + 候选池打乱）。
                val challenge = remember(words) { SeedVerification.create(words) }
                var selectedIds by remember(challenge) { mutableStateOf(emptyList<Int>()) }
                val positions = challenge.positions
                val selectedWords = selectedIds.map { id -> challenge.options.first { it.id == id }.word }
                val complete = selectedWords.size == positions.size

                VpRiskBanner(
                    VpTone.INFO,
                    "Confirm your backup",
                    "Tap the right word for each numbered blank, in order. This proves the phrase was saved correctly.",
                )

                // 编号空位（按升序，用户从上往下依次填）。
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Text(
                        "Fill " + positions.joinToString(", ") { "#${it + 1}" } + " in order",
                        style = MaterialTheme.typography.titleMedium,
                        color = PaytobeTheme.colors.textStrong,
                    )
                    Spacer(Modifier.height(Spacing.s3))
                    positions.forEachIndexed { i, p ->
                        VerifySlot(
                            index = p + 1,
                            word = selectedWords.getOrNull(i),
                            active = i == selectedWords.size,
                            onClick = { if (i < selectedWords.size) selectedIds = selectedIds.take(i) },
                        )
                        if (i != positions.lastIndex) Spacer(Modifier.height(Spacing.s2))
                    }
                }

                // 候选词池（3 列）。已选中的 chip 置灰且不可再点。
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.s2)) {
                    challenge.options.chunked(3).forEach { rowChips ->
                        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s2)) {
                            rowChips.forEach { opt ->
                                val used = opt.id in selectedIds
                                WordOption(
                                    word = opt.word,
                                    used = used,
                                    modifier = Modifier.weight(1f),
                                    onClick = {
                                        if (!used && selectedIds.size < positions.size) {
                                            selectedIds = selectedIds + opt.id
                                        }
                                    },
                                )
                            }
                            repeat(3 - rowChips.size) { Spacer(Modifier.weight(1f)) }
                        }
                    }
                }

                VpPrimaryButton(
                    text = "Confirm",
                    onClick = {
                        if (SeedVerification.isCorrect(words, positions, selectedWords)) {
                            vm.confirmBackup()
                        } else {
                            vm.flagVerifyMismatch()
                            onReview()
                        }
                    },
                    enabled = complete,
                    modifier = Modifier.fillMaxWidth(),
                )
                VpOutlineButton(
                    text = "Review phrase again",
                    onClick = onReview,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

/** 验证页的单个编号空位：未填显示提示，已填显示所选词；点已填的空位可撤销它及其后的选择。 */
@Composable
private fun VerifySlot(index: Int, word: String?, active: Boolean, onClick: () -> Unit) {
    val outline = if (word != null || active) PaytobeTheme.colors.primary else PaytobeTheme.colors.borderDefault
    Surface(
        shape = PaytobeRadii.sm,
        color = if (word != null) PaytobeTheme.colors.primarySoft else PaytobeTheme.colors.surfaceCard,
        border = BorderStroke(1.dp, outline),
        modifier = Modifier.fillMaxWidth().clickable(enabled = word != null) { onClick() },
    ) {
        Row(
            modifier = Modifier.padding(horizontal = Spacing.s3, vertical = Spacing.s3),
            horizontalArrangement = Arrangement.spacedBy(Spacing.s2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("#$index", style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textMuted)
            Text(
                word ?: "Tap a word",
                style = MaterialTheme.typography.titleMedium,
                color = if (word != null) PaytobeTheme.colors.textStrong else PaytobeTheme.colors.textFaint,
            )
        }
    }
}

/** 候选词池里的单枚胶囊 chip。已选则置灰且不可点。 */
@Composable
private fun WordOption(word: String, used: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Surface(
        shape = PaytobeRadii.pill,
        color = if (used) PaytobeTheme.colors.surfaceSunken else PaytobeTheme.colors.surfaceCard,
        border = BorderStroke(1.dp, if (used) PaytobeTheme.colors.borderSubtle else PaytobeTheme.colors.borderDefault),
        modifier = modifier.clickable(enabled = !used) { onClick() },
    ) {
        Text(
            text = word,
            style = MaterialTheme.typography.labelLarge,
            color = if (used) PaytobeTheme.colors.textFaint else PaytobeTheme.colors.textStrong,
            textAlign = TextAlign.Center,
            maxLines = 1,
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s2, vertical = Spacing.s3),
        )
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
    Surface(shape = PaytobeRadii.xl, color = PaytobeTheme.colors.surfaceInverse, modifier = Modifier.fillMaxWidth()) {
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
        shape = PaytobeRadii.sm,
        color = Color.White.copy(alpha = 0.08f),
        modifier = modifier,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = Spacing.s3, vertical = Spacing.s2),
            horizontalArrangement = Arrangement.spacedBy(Spacing.s2),
        ) {
            Text("$index", style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textFaint)
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
                Text("Runtime protection", style = MaterialTheme.typography.titleMedium, color = PaytobeTheme.colors.textStrong)
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
