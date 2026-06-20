package ai.agentwallet.hd.ui.wallet

import android.app.Application
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import ai.agentwallet.hd.SendForm
import ai.agentwallet.hd.SendPreparation
import ai.agentwallet.hd.WalletRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 发送流程的四个显式步骤（对照交付计划）：
 *   ENTRY    金额/收款人录入
 *   RISK     风险确认（仅当 prepareSend 返回风险提示时出现；无提示则直接跳过到 CONFIRM）
 *   CONFIRM  最终复核（金额/收款人/备注/费用）+「Sign & send」（生物识别 → confirmSend）
 *   PROGRESS 提交进度 → 成功(txHash) / 失败
 */
enum class SendStep { ENTRY, RISK, CONFIRM, PROGRESS }

data class SendUiState(
    val step: SendStep = SendStep.ENTRY,
    val symbol: String = "XLM",
    val network: String = "Stellar",
    val recipient: String = "",
    val amount: String = "",
    val memo: String = "",
    /** prepareSend 返回的风险提示（warnings）；非空时 RISK 步骤呈现并要求显式确认。 */
    val riskWarnings: List<String> = emptyList(),
    val riskAccepted: Boolean = false,
    val preparing: Boolean = false,
    val submitting: Boolean = false,
    val error: String? = null,
    val txHash: String? = null,
    val done: Boolean = false,
)

/**
 * 发送编排 ViewModel。链路与 WalletWebActivity.send() 同序，且**硬约束全部保留**：
 *   proceedFromEntry(): prepareSend（钱包 → 备份门禁 → 收款人/金额 → 组装 → RiskPolicy 评估）
 *     - 不通过(!allowed) → 停在 ENTRY 报错，**绝不进入后续步骤/生物识别**。
 *     - 通过且有 warnings → 进入 RISK（需显式 accept）。
 *     - 通过且无 warnings → 直接进入 CONFIRM（不强塞空风险页）。
 *   confirm(): 生物识别 → confirmSend（PaymentExecutor 内部再跑一次 RiskPolicy + 记账）→ PROGRESS。
 *
 * 金额始终为 String；备份门禁与风控均在门面层（WalletRepository）执行，逻辑不变。
 * 已通过校验的 [SendPreparation] 被缓存（[prepared]），CONFIRM 直接复用同一份，避免二次 prepare。
 */
class SendViewModel(app: Application) : AndroidViewModel(app) {

    private val _ui = MutableStateFlow(SendUiState())
    val ui: StateFlow<SendUiState> = _ui.asStateFlow()

    /** 上一次 prepareSend 通过(allowed)的结果，供 CONFIRM 的 confirmSend 复用（同一份 intent）。 */
    private var prepared: SendPreparation? = null

    fun reset() {
        prepared = null
        _ui.value = SendUiState()
    }

    /** 由扫码结果预填（symbol/network 为空则保留默认 XLM/Stellar，让用户在 Send 选）。 */
    fun prefill(symbol: String, network: String, recipient: String, amount: String, memo: String) {
        prepared = null
        val base = SendUiState()
        _ui.value = base.copy(
            symbol = symbol.ifBlank { base.symbol },
            network = network.ifBlank { base.network },
            recipient = recipient,
            amount = amount,
            memo = memo,
        )
    }

    fun selectAsset(symbol: String, network: String) = _ui.update { it.copy(symbol = symbol, network = network, error = null) }
    fun setRecipient(value: String) = _ui.update { it.copy(recipient = value, error = null) }
    fun setAmount(value: String) = _ui.update { it.copy(amount = value, error = null) }
    fun setMemo(value: String) = _ui.update { it.copy(memo = value, error = null) }

    /** 客户端最小校验（仅用于启用「Continue」按钮）；权威校验在 prepareSend/RiskPolicy。 */
    fun canReview(): Boolean {
        val s = _ui.value
        // 仅用于显示态的展示估值会用 Double，但这里只判断「是否为正数」，金额本身仍以 String 传递给 prepareSend。
        val amount = s.amount.trim().toDoubleOrNull()
        val memoOk = s.symbol != "XLM" || s.memo.trim().isNotEmpty()
        return s.recipient.trim().isNotEmpty() && amount != null && amount > 0.0 && memoOk
    }

    /** 用户在 RISK 步骤勾选「我已理解并接受」。 */
    fun acceptRisk(accepted: Boolean) = _ui.update { it.copy(riskAccepted = accepted, error = null) }

    /**
     * 步骤一 → 二/三：运行 prepareSend（含备份门禁 + RiskPolicy）。
     * 不通过则停在 ENTRY 报错（不前进、不弹生物）；通过则按是否有 warnings 决定进入 RISK 或 CONFIRM。
     */
    fun proceedFromEntry() {
        val s = _ui.value
        if (s.preparing || s.submitting) return
        _ui.update { it.copy(preparing = true, error = null) }
        viewModelScope.launch {
            val prep = withContext(Dispatchers.IO) {
                WalletRepository.prepareSend(
                    getApplication(),
                    SendForm(s.symbol, s.network, s.recipient.trim(), s.amount.trim(), s.memo.trim()),
                )
            }
            if (!prep.allowed) {
                // 与 send() 一致：风控/校验/备份不通过时直接报错，绝不前进到 RISK/CONFIRM/生物识别。
                prepared = null
                _ui.update { it.copy(preparing = false, error = prep.errorText) }
                return@launch
            }
            prepared = prep
            val warnings = prep.warnings
            _ui.update {
                it.copy(
                    preparing = false,
                    riskWarnings = warnings,
                    riskAccepted = false,
                    // 有风险提示 → 必须经过 RISK；无提示 → 直接 CONFIRM（不强塞空风险页）。
                    step = if (warnings.isNotEmpty()) SendStep.RISK else SendStep.CONFIRM,
                )
            }
        }
    }

    /** RISK → CONFIRM：仅在已接受风险时允许。 */
    fun confirmRisk() {
        val s = _ui.value
        if (s.step != SendStep.RISK || !s.riskAccepted) return
        _ui.update { it.copy(step = SendStep.CONFIRM, error = null) }
    }

    /** 返回上一步（CONFIRM→RISK 或 ENTRY；RISK→ENTRY）。返回 true 表示在内部消费了返回事件。 */
    fun goBackStep(): Boolean {
        val s = _ui.value
        return when (s.step) {
            SendStep.CONFIRM -> {
                // 若本次有风险提示，CONFIRM 必须经由 RISK 才能到达，故返回到 RISK；否则回 ENTRY。
                val target = if (s.riskWarnings.isNotEmpty()) SendStep.RISK else SendStep.ENTRY
                _ui.update { it.copy(step = target, error = null) }
                true
            }
            SendStep.RISK -> {
                _ui.update { it.copy(step = SendStep.ENTRY, riskAccepted = false, error = null) }
                true
            }
            // ENTRY 由调用方处理（popBackStack）；PROGRESS 提交中不允许后退。
            SendStep.ENTRY, SendStep.PROGRESS -> false
        }
    }

    /**
     * 步骤三 → 四：CONFIRM 的「Sign & send」。生物识别 → confirmSend（复用已通过的 prepared）。
     * 硬约束：必须已通过 prepareSend（prepared 非空）；有风险提示时必须先 accept；生物识别在签名之前。
     */
    fun confirm(activity: FragmentActivity, onSent: () -> Unit) {
        val s = _ui.value
        if (s.submitting || s.step != SendStep.CONFIRM) return
        val prep = prepared
        if (prep == null || !prep.allowed) {
            // 防御：没有通过校验的准备结果，绝不签名。退回 ENTRY 重新走流程。
            _ui.update { it.copy(step = SendStep.ENTRY, error = "Please review the transfer again.") }
            return
        }
        if (s.riskWarnings.isNotEmpty() && !s.riskAccepted) {
            // 防御：有风险提示但未确认，不得签名；退回 RISK。
            _ui.update { it.copy(step = SendStep.RISK, error = "Please acknowledge the risk notice first.") }
            return
        }
        _ui.update { it.copy(submitting = true, error = null, step = SendStep.PROGRESS) }
        BiometricAuth.authenticate(
            activity = activity,
            title = "Send ${s.symbol}",
            onSuccess = {
                viewModelScope.launch {
                    val result = withContext(Dispatchers.IO) {
                        runCatching { WalletRepository.confirmSend(getApplication(), prep) }
                    }
                    result.onSuccess { tx ->
                        _ui.update { it.copy(submitting = false, txHash = tx, done = true) }
                        onSent()
                    }.onFailure { e ->
                        // 失败：留在 PROGRESS 展示错误（用户可返回 CONFIRM 重试）。
                        _ui.update { it.copy(submitting = false, error = e.message ?: "The network did not accept the transaction.") }
                    }
                }
            },
            onFailure = {
                // 生物识别取消：退回 CONFIRM，可重试。
                _ui.update { it.copy(submitting = false, step = SendStep.CONFIRM, error = "Authentication was cancelled.") }
            },
        )
    }

    /** PROGRESS（失败后）→ CONFIRM 重试。 */
    fun retryFromProgress() {
        if (_ui.value.submitting) return
        _ui.update { it.copy(step = SendStep.CONFIRM, error = null) }
    }
}
