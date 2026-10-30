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
import ai.agentwallet.hd.ui.theme.PaytobeFonts
import ai.agentwallet.hd.ui.theme.PaytobeTheme

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
        SendStep.ENTRY -> "Manual payment" to "Send ${ui.symbol} · ${ui.network}"
        SendStep.RISK -> "Step 2 of 4" to "Review risk notice"
        SendStep.CONFIRM -> "Step 3 of 4" to "Confirm transfer"
        SendStep.PROGRESS -> "Step 4 of 4" to "Sending ${ui.symbol} · ${ui.network}"
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
                fontFamily = PaytobeFonts.display,
                fontWeight = FontWeight.SemiBold,
                fontSize = 48.sp,
                textAlign = TextAlign.Center,
                color = PaytobeTheme.colors.textStrong,
            ),
            cursorBrush = SolidColor(PaytobeTheme.colors.primary),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
        )
        Text(symbol, style = MaterialTheme.typography.titleMedium, color = PaytobeTheme.colors.textMuted)
    }
}

@Composable
private fun EntryStep(vm: SendViewModel, ui: SendUiState) {
    // 选资产浮层（展开时占据整个 ENTRY 区域，避免与表单互相干扰）。
    if (ui.showChainPicker) {
        AssetPicker(vm, ui)
        return
    }

    // 已选资产：可点击切换（取代旧的 4 个固定 chip，改为驱动自全 30 条链注册表）。
    AssetSelectorRow(symbol = ui.symbol, chain = ui.network, sendable = ui.sendable, onClick = { vm.openChainPicker() })

    // 扫码/地址探测给出的“请确认链”提示。
    if (ui.chainHint.isNotBlank()) VpRiskBanner(VpTone.CAUTION, "Confirm the network", ui.chainHint)

    // 尚无设备端签名器的链：明确告知“开发中”，并禁用继续。
    if (!ui.sendable) {
        VpRiskBanner(
            VpTone.INFO,
            "Feature is under development",
            "Sending on ${ui.network} isn't available on this device yet. Pick a supported asset to continue, or use Receive.",
        )
    }

    VpTextField(
        value = ui.recipient,
        onValueChange = vm::setRecipient,
        label = "Recipient on ${ui.network}",
        placeholder = "Recipient address",
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None),
    )
    // 提前校验地址类型：地址与所选链不符时即时报错（避免发错链）。
    val addrErr = vm.recipientError()
    if (addrErr != null) VpRiskBanner(VpTone.DANGER, "Check the address", addrErr)

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

/** 当前所选资产的展示行，点击进入选资产浮层。 */
@Composable
private fun AssetSelectorRow(symbol: String, chain: String, sendable: Boolean, onClick: () -> Unit) {
    VpCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().clickable { onClick() },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.s3),
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Asset", style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textMuted)
                Text(
                    "$symbol · $chain",
                    style = MaterialTheme.typography.titleMedium,
                    color = PaytobeTheme.colors.textStrong,
                )
                if (!sendable) {
                    Text(
                        "Under development",
                        style = MaterialTheme.typography.bodySmall,
                        color = PaytobeTheme.colors.textMuted,
                    )
                }
            }
            Text("Change", style = MaterialTheme.typography.titleMedium, color = PaytobeTheme.colors.primary)
        }
    }
}

/** 选资产浮层：全部资产按「可发送 / 开发中」分组展示（注册表驱动）。 */
@Composable
private fun AssetPicker(vm: SendViewModel, ui: SendUiState) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text("Select asset", style = MaterialTheme.typography.titleLarge, color = PaytobeTheme.colors.textStrong)
        Text(
            "Close",
            style = MaterialTheme.typography.titleMedium,
            color = PaytobeTheme.colors.primary,
            modifier = Modifier.clickable { vm.closeChainPicker() },
        )
    }
    Text(
        "Available · ${vm.sendableAssets.size}",
        style = MaterialTheme.typography.labelMedium,
        color = PaytobeTheme.colors.textMuted,
    )
    VpCard(modifier = Modifier.fillMaxWidth()) {
        vm.sendableAssets.forEach { asset ->
            AssetPickerRow(asset = asset, selected = asset.rail == ui.rail, enabled = true) { vm.selectAsset(asset) }
        }
    }
    Text(
        "Feature under development · ${vm.comingSoonAssets.size}",
        style = MaterialTheme.typography.labelMedium,
        color = PaytobeTheme.colors.textMuted,
    )
    VpCard(modifier = Modifier.fillMaxWidth()) {
        vm.comingSoonAssets.forEach { asset ->
            AssetPickerRow(asset = asset, selected = asset.rail == ui.rail, enabled = false) { vm.selectAsset(asset) }
        }
    }
}

/** 选资产浮层里的单条资产。enabled=false → 开发中（仍可点选以展示“开发中”说明并禁用继续）。 */
@Composable
private fun AssetPickerRow(
    asset: ai.agentwallet.hd.TransferAssetOption,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable { onClick() }.padding(vertical = Spacing.s2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s3),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                "${asset.symbol} · ${asset.chain}",
                style = MaterialTheme.typography.titleMedium,
                color = if (enabled) PaytobeTheme.colors.textStrong else PaytobeTheme.colors.textMuted,
            )
            Text(
                if (enabled) "On-device signing" else "Under development",
                style = MaterialTheme.typography.bodySmall,
                color = PaytobeTheme.colors.textMuted,
            )
        }
        if (selected) {
            Text("Selected", style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.primary)
        } else if (!enabled) {
            Text("Soon", style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textMuted)
        }
    }
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
            Text("• $warning", style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textBody, modifier = Modifier.padding(vertical = Spacing.s1))
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
            color = PaytobeTheme.colors.textStrong,
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
        Text("You will send", style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textMuted)
        Spacer(Modifier.height(Spacing.s1))
        Text("${ui.amount} ${ui.symbol}", style = MaterialTheme.typography.displaySmall, color = PaytobeTheme.colors.textStrong)
        // 仅展示用估值（Double）；交易金额始终用 String（ui.amount）。
        Text("≈ $${formatUsd(fiatUsd(ui.symbol, ui.amount))}", style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textMuted)
    }
    VpCard(modifier = Modifier.fillMaxWidth()) {
        VpFactRow("Asset", "${ui.symbol} · ${ui.network}")
        RecipientFactRow(ui.recipient)
        if (ui.symbol == "XLM" && ui.memo.isNotBlank()) VpFactRow("Stellar memo", ui.memo)
        VpFactRow("Network fee", networkFeeText(ui))
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

/**
 * 收款地址整段显示（每个字符都可见）。地址很长，因此把值竖排在标签下方、按整卡宽度换行，
 * 而不是截断成 6…4。对应用户反馈「收款地址必须全部显示完整字符」。
 */
@Composable
private fun RecipientFactRow(address: String) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = Spacing.s2),
        verticalArrangement = Arrangement.spacedBy(Spacing.s1),
    ) {
        Text("Recipient", style = MaterialTheme.typography.bodyMedium, color = PaytobeTheme.colors.textMuted)
        Text(
            address,
            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = PaytobeFonts.mono),
            color = PaytobeTheme.colors.textStrong,
        )
    }
}

/**
 * 网络费用行文案：已取到实时费用时显示费用（如 “≈ 0.000005 SOL”）；拉取中显示加载文案；
 * 取不到（链不支持/超时/出错）时回退到广播时计算的旧文案，保证不阻塞签名。
 */
private fun networkFeeText(ui: SendUiState): String = when {
    ui.feeLoading -> "Fetching network fee…"
    !ui.networkFee.isNullOrBlank() -> ui.networkFee!!
    else -> "Calculated at broadcast"
}

@Composable
private fun ProgressStep(vm: SendViewModel, ui: SendUiState, onFinishToHome: () -> Unit) {
    when {
        ui.done -> {
            VpRiskBanner(VpTone.SAFE, "Transfer confirmed", "Signed on this device and broadcast to the network.")
            VpCard(modifier = Modifier.fillMaxWidth()) {
                VpFactRow("Asset", "${ui.symbol} · ${ui.network}")
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
