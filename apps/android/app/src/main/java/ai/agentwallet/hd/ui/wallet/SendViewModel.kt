package ai.agentwallet.hd.ui.wallet

import android.app.Application
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import ai.agentwallet.hd.SendForm
import ai.agentwallet.hd.WalletRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class SendUiState(
    val symbol: String = "XLM",
    val network: String = "Stellar",
    val recipient: String = "",
    val amount: String = "",
    val memo: String = "",
    val submitting: Boolean = false,
    val error: String? = null,
    val txHash: String? = null,
    val done: Boolean = false,
)

/**
 * 发送编排 ViewModel。submit() 按 WalletWebActivity.send() 同序执行：
 *   prepareSend（前置校验 + 组装 + RiskPolicy）→ 不通过则报错且**不弹生物识别** →
 *   生物识别 → confirmSend（PaymentExecutor 内部再跑 RiskPolicy + 记账）→ 成功/失败。
 * 业务逻辑全部走门面层（WalletRepository），逻辑不变。
 */
class SendViewModel(app: Application) : AndroidViewModel(app) {

    private val _ui = MutableStateFlow(SendUiState())
    val ui: StateFlow<SendUiState> = _ui.asStateFlow()

    fun reset() {
        _ui.value = SendUiState()
    }

    /** 由扫码结果预填（symbol/network 为空则保留默认 XLM/Stellar，让用户在 Send 选）。 */
    fun prefill(symbol: String, network: String, recipient: String, amount: String, memo: String) {
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

    /** 客户端最小校验（仅用于启用「Review」按钮）；权威校验在 prepareSend/RiskPolicy。 */
    fun canReview(): Boolean {
        val s = _ui.value
        val amount = s.amount.trim().toDoubleOrNull()
        val memoOk = s.symbol != "XLM" || s.memo.trim().isNotEmpty()
        return s.recipient.trim().isNotEmpty() && amount != null && amount > 0.0 && memoOk
    }

    fun submit(activity: FragmentActivity, onSent: () -> Unit) {
        val s = _ui.value
        if (s.submitting) return
        _ui.update { it.copy(submitting = true, error = null) }
        viewModelScope.launch {
            val prep = withContext(Dispatchers.IO) {
                WalletRepository.prepareSend(
                    getApplication(),
                    SendForm(s.symbol, s.network, s.recipient.trim(), s.amount.trim(), s.memo.trim()),
                )
            }
            if (!prep.allowed) {
                // 与 send() 一致：风控/校验不通过时直接报错，绝不进入生物识别。
                _ui.update { it.copy(submitting = false, error = prep.errorText) }
                return@launch
            }
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
                            _ui.update { it.copy(submitting = false, error = e.message ?: "The network did not accept the transaction.") }
                        }
                    }
                },
                onFailure = {
                    _ui.update { it.copy(submitting = false, error = "Authentication was cancelled.") }
                },
            )
        }
    }
}
