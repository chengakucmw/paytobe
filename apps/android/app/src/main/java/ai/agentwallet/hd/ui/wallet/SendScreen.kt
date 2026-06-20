package ai.agentwallet.hd.ui.wallet

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpChip
import ai.agentwallet.hd.ui.components.VpFactRow
import ai.agentwallet.hd.ui.components.VpOutlineButton
import ai.agentwallet.hd.ui.components.VpPrimaryButton
import ai.agentwallet.hd.ui.components.VpRiskBanner
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.VpTextField
import ai.agentwallet.hd.ui.components.VpTone
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.sp
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumFonts
import ai.agentwallet.hd.ui.theme.VelarumTheme

/**
 * 发送页（原生），按四步显式状态机渲染（由 [SendViewModel] 的 step 驱动）：
 *   ENTRY → RISK（仅当有风险提示）→ CONFIRM → PROGRESS。
 * 顶栏返回箭头按步骤回退（CONFIRM→RISK/ENTRY，RISK→ENTRY，ENTRY→上层）。
 * 所有签名相关硬约束都在 ViewModel/WalletRepository 内保留（备份门禁、RiskPolicy、生物识别）。
 *
 * 键盘是当初 WebView 的核心痛点：ENTRY 用 imePadding() 让内容随软键盘让位。XLM 的 Stellar memo 必填。
 */
@Composable
fun SendScreen(
    vm: SendViewModel,
    onExit: () -> Unit,
    onFinishToHome: () -> Unit,
    onBalanceRefresh: () -> Unit,
) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current

    val (eyebrow, title) = when (ui.step) {
        SendStep.ENTRY -> "Manual payment" to "Send ${ui.symbol}"
        SendStep.RISK -> "Step 2 of 4" to "Review risk notice"
        SendStep.CONFIRM -> "Step 3 of 4" to "Confirm transfer"
        SendStep.PROGRESS -> "Step 4 of 4" to "Sending ${ui.symbol}"
    }
    // 返回：先让 ViewModel 在步骤内回退；若已在 ENTRY（无内部回退）则交给上层导航。
    val onBack: () -> Unit = { if (!vm.goBackStep()) onExit() }

    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        // PROGRESS 提交中不提供返回（避免中断签名/广播）。
        val showBack = ui.step != SendStep.PROGRESS || !ui.submitting
        VpSubheader(eyebrow = eyebrow, title = title, onBack = if (showBack) onBack else null)
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = Spacing.s5)
                .padding(bottom = Spacing.s8)
                .imePadding(),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            when (ui.step) {
                SendStep.ENTRY -> EntryStep(vm, ui)
                SendStep.RISK -> RiskStep(vm, ui)
                SendStep.CONFIRM -> ConfirmStep(
                    vm = vm,
                    ui = ui,
                    onSign = { vm.confirm(context as FragmentActivity, onSent = onBalanceRefresh) },
                )
                SendStep.PROGRESS -> ProgressStep(vm, ui, onFinishToHome = onFinishToHome)
            }
        }
    }
}

/** 大号居中金额输入（对照原型 07 的 amount-entry）。金额仍以 String 流转，绝不用浮点。 */
@Composable
private fun BigAmountField(value: String, symbol: String, onValueChange: (String) -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = Spacing.s4),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Spacing.s1),
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            textStyle = TextStyle(
                fontFamily = VelarumFonts.display,
                fontWeight = FontWeight.SemiBold,
                fontSize = 48.sp,
                textAlign = TextAlign.Center,
                color = VelarumTheme.colors.textStrong,
            ),
            cursorBrush = SolidColor(VelarumTheme.colors.primary),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
        )
        Text(symbol, style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textMuted)
    }
}

@Composable
private fun EntryStep(vm: SendViewModel, ui: SendUiState) {
    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s2)) {
        HOME_ASSETS.forEach { asset ->
            VpChip(
                label = asset.symbol,
                active = asset.symbol == ui.symbol,
                onClick = { vm.selectAsset(asset.symbol, asset.chain) },
            )
        }
    }
    VpTextField(
        value = ui.recipient,
        onValueChange = vm::setRecipient,
        label = "Recipient on ${ui.network}",
        placeholder = "Recipient address",
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None),
    )
    if (ui.symbol == "XLM") {
        VpTextField(
            value = ui.memo,
            onValueChange = vm::setMemo,
            label = "Stellar memo · required",
            placeholder = "Memo / destination tag",
        )
    }
    BigAmountField(value = ui.amount, symbol = ui.symbol, onValueChange = vm::setAmount)
    VpRiskBanner(
        VpTone.INFO,
        "Local approval required",
        "You'll review the recipient and amount, then confirm with biometrics. Signing happens on this device and can't be undone.",
    )
    val err = ui.error
    if (err != null) VpRiskBanner(VpTone.DANGER, "Can't continue", err)
    VpPrimaryButton(
        text = if (ui.preparing) "Checking…" else "Continue",
        onClick = { vm.proceedFromEntry() },
        enabled = vm.canReview() && !ui.preparing,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun RiskStep(vm: SendViewModel, ui: SendUiState) {
    VpRiskBanner(
        VpTone.CAUTION,
        "Review before you continue",
        "This transfer triggered the following checks. Read them carefully — once signed, the transaction can't be undone.",
    )
    VpCard(modifier = Modifier.fillMaxWidth()) {
        ui.riskWarnings.forEach { warning ->
            Text("• $warning", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textBody, modifier = Modifier.padding(vertical = Spacing.s1))
        }
    }
    Row(
        modifier = Modifier.fillMaxWidth().clickable { vm.acceptRisk(!ui.riskAccepted) },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s2),
    ) {
        Checkbox(checked = ui.riskAccepted, onCheckedChange = { vm.acceptRisk(it) })
        Text(
            "I understand and accept these risks.",
            style = MaterialTheme.typography.bodyMedium,
            color = VelarumTheme.colors.textStrong,
        )
    }
    val err = ui.error
    if (err != null) VpRiskBanner(VpTone.DANGER, "Can't continue", err)
    VpPrimaryButton(
        text = "Continue",
        onClick = { vm.confirmRisk() },
        enabled = ui.riskAccepted,
        modifier = Modifier.fillMaxWidth(),
    )
    VpOutlineButton(text = "Back", onClick = { vm.goBackStep() }, modifier = Modifier.fillMaxWidth())
}

@Composable
private fun ConfirmStep(vm: SendViewModel, ui: SendUiState, onSign: () -> Unit) {
    VpCard(modifier = Modifier.fillMaxWidth()) {
        Text("You will send", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
        Spacer(Modifier.height(Spacing.s1))
        Text("${ui.amount} ${ui.symbol}", style = MaterialTheme.typography.displaySmall, color = VelarumTheme.colors.textStrong)
        // 仅展示用估值（Double）；交易金额始终用 String（ui.amount）。
        Text("≈ $${formatUsd(fiatUsd(ui.symbol, ui.amount))}", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
    }
    VpCard(modifier = Modifier.fillMaxWidth()) {
        VpFactRow("Token", "${ui.symbol} on ${ui.network}")
        VpFactRow("Recipient", shortAddress(ui.recipient))
        if (ui.symbol == "XLM" && ui.memo.isNotBlank()) VpFactRow("Stellar memo", ui.memo)
        VpFactRow("Network fee", "Calculated & paid at broadcast")
        VpFactRow("Source", "Manual transfer · no agent")
    }
    VpRiskBanner(
        VpTone.SAFE,
        "Ready for local approval",
        "Confirm the token, recipient and amount. You'll authenticate, then it's signed locally and broadcast to mainnet. This cannot be undone.",
    )
    val err = ui.error
    if (err != null) VpRiskBanner(VpTone.DANGER, "Can't send", err)
    VpPrimaryButton(
        text = "Sign & send",
        onClick = onSign,
        enabled = !ui.submitting,
        modifier = Modifier.fillMaxWidth(),
    )
    VpOutlineButton(text = "Back", onClick = { vm.goBackStep() }, modifier = Modifier.fillMaxWidth())
}

@Composable
private fun ProgressStep(vm: SendViewModel, ui: SendUiState, onFinishToHome: () -> Unit) {
    when {
        ui.done -> {
            VpRiskBanner(VpTone.SAFE, "Transfer confirmed", "Signed on this device and broadcast to the network.")
            VpCard(modifier = Modifier.fillMaxWidth()) {
                VpFactRow("Asset", "${ui.symbol} on ${ui.network}")
                VpFactRow("Amount", "${ui.amount} ${ui.symbol}")
                val tx = ui.txHash
                if (!tx.isNullOrBlank()) VpFactRow("Tx hash", shortAddress(tx))
            }
            VpPrimaryButton("Done", onClick = onFinishToHome, modifier = Modifier.fillMaxWidth())
        }
        ui.error != null -> {
            VpRiskBanner(VpTone.DANGER, "Can't send", ui.error!!)
            VpPrimaryButton("Try again", onClick = { vm.retryFromProgress() }, modifier = Modifier.fillMaxWidth())
        }
        else -> {
            VpRiskBanner(VpTone.INFO, "Submitting…", "Authenticate, then your transfer is signed locally and broadcast to the network.")
            Box(Modifier.fillMaxWidth().padding(Spacing.s4), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        }
    }
}
