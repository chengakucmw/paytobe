package ai.agentwallet.hd.ui.wallet

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.agentwallet.hd.ui.components.VpChip
import ai.agentwallet.hd.ui.components.VpPrimaryButton
import ai.agentwallet.hd.ui.components.VpRiskBanner
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.VpTextField
import ai.agentwallet.hd.ui.components.VpTone
import ai.agentwallet.hd.ui.theme.Spacing

/**
 * 发送草稿页（原生）。键盘是当初 WebView 的核心痛点：这里用 imePadding() 让内容随软键盘让位，
 * 原生 TextField 聚焦即弹键盘、不被遮、页面不跳。XLM 的 Stellar memo 为必填（对照 web 草稿校验）。
 */
@Composable
fun SendScreen(vm: SendViewModel, onReview: () -> Unit, onBack: () -> Unit) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Manual payment", title = "Send ${ui.symbol}", onBack = onBack)
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = Spacing.s5)
                .padding(bottom = Spacing.s8)
                .imePadding(),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
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
            VpTextField(
                value = ui.amount,
                onValueChange = vm::setAmount,
                label = "Amount (${ui.symbol})",
                placeholder = "0.00",
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            )
            VpRiskBanner(
                VpTone.INFO,
                "Local approval required",
                "You'll review the recipient and amount, then confirm with biometrics. Signing happens on this device and can't be undone.",
            )
            VpPrimaryButton(
                text = "Review transfer",
                onClick = onReview,
                enabled = vm.canReview(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
