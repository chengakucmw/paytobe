package ai.agentwallet.hd.ui.wallet

import android.app.Application
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import ai.agentwallet.hd.InboxDetail
import ai.agentwallet.hd.InboxItem
import ai.agentwallet.hd.InboxRepository
import ai.agentwallet.hd.WalletRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class InboxListUiState(
    val loading: Boolean = true,
    val items: List<InboxItem> = emptyList(),
    val filter: String = "pending",
)

/** 收件箱列表：读取 PaymentInboxStore（经 InboxRepository 映射），支持 pending/all/final 过滤。 */
class InboxViewModel(app: Application) : AndroidViewModel(app) {
    private val _ui = MutableStateFlow(InboxListUiState())
    val ui: StateFlow<InboxListUiState> = _ui.asStateFlow()

    init { reload() }

    fun setFilter(filter: String) {
        _ui.update { it.copy(filter = filter) }
        reload()
    }

    fun reload() {
        _ui.update { it.copy(loading = true) }
        viewModelScope.launch {
            val items = withContext(Dispatchers.IO) { InboxRepository.load(getApplication(), _ui.value.filter) }
            _ui.update { it.copy(loading = false, items = items) }
        }
    }
}

data class DetailUiState(
    val loading: Boolean = true,
    val detail: InboxDetail? = null,
    val submitting: Boolean = false,
    val error: String? = null,
    val done: Boolean = false,
    val rejected: Boolean = false,
    val txHash: String? = null,
)

/**
 * 详情 + 支付/拒绝。pay() 复用与 Send 完全相同的管线：
 * prepareInboxPay(RiskPolicy) → 不通过即报错（不弹生物） → 生物识别 → confirmInboxPay。
 */
class DetailViewModel(app: Application) : AndroidViewModel(app) {
    private var intentId: String = ""
    private val _ui = MutableStateFlow(DetailUiState())
    val ui: StateFlow<DetailUiState> = _ui.asStateFlow()

    fun load(id: String) {
        intentId = id
        _ui.update { it.copy(loading = true, error = null, done = false, rejected = false) }
        viewModelScope.launch {
            val detail = withContext(Dispatchers.IO) { InboxRepository.detail(getApplication(), id) }
            _ui.update { it.copy(loading = false, detail = detail) }
        }
    }

    fun pay(activity: FragmentActivity) {
        if (_ui.value.submitting) return
        _ui.update { it.copy(submitting = true, error = null) }
        viewModelScope.launch {
            val prep = withContext(Dispatchers.IO) { WalletRepository.prepareInboxPay(getApplication(), intentId) }
            if (!prep.allowed) {
                _ui.update { it.copy(submitting = false, error = prep.errorText) }
                return@launch
            }
            BiometricAuth.authenticate(
                activity = activity,
                title = "Pay ${prep.symbol}",
                onSuccess = {
                    viewModelScope.launch {
                        val result = withContext(Dispatchers.IO) { runCatching { WalletRepository.confirmInboxPay(getApplication(), prep) } }
                        result.onSuccess { tx -> _ui.update { it.copy(submitting = false, done = true, txHash = tx) } }
                            .onFailure { e -> _ui.update { it.copy(submitting = false, error = e.message ?: "The network did not accept the transaction.") } }
                    }
                },
                onFailure = { _ui.update { it.copy(submitting = false, error = "Authentication was cancelled.") } },
            )
        }
    }

    fun reject() {
        if (_ui.value.submitting) return
        viewModelScope.launch {
            withContext(Dispatchers.IO) { runCatching { WalletRepository.rejectInbox(getApplication(), intentId) } }
            _ui.update { it.copy(rejected = true) }
        }
    }
}
