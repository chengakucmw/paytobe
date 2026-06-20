package ai.agentwallet.hd.ui.onboarding

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import ai.agentwallet.hd.WalletRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 开通流程的 UI 状态。 */
data class OnboardingUiState(
    val busy: Boolean = false,
    val error: String? = null,
    val mnemonic: List<String> = emptyList(),
    val created: Boolean = false,
    val imported: Boolean = false,
    val backupConfirmed: Boolean = false,
)

/**
 * 开通流程 ViewModel：把门面层（WalletRepository）的钱包生命周期方法用协程包起来，
 * 重活（密钥派生、Keystore 加密）放 Dispatchers.IO，状态用 StateFlow 暴露给 Compose。
 * 调用的逻辑全部不变（对照 app-bridge 的 createWallet/importWallet/mnemonicWords/confirmBackup）。
 */
class OnboardingViewModel(app: Application) : AndroidViewModel(app) {

    private val _ui = MutableStateFlow(OnboardingUiState())
    val ui: StateFlow<OnboardingUiState> = _ui.asStateFlow()

    fun createWallet() {
        if (_ui.value.busy) return
        _ui.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    WalletRepository.createWallet(getApplication())
                    WalletRepository.mnemonicWords(getApplication())
                }
            }
            result.onSuccess { words ->
                _ui.update { it.copy(busy = false, mnemonic = words, created = true) }
            }.onFailure { e ->
                _ui.update { it.copy(busy = false, error = e.message ?: "Could not create wallet.") }
            }
        }
    }

    fun importWallet(phrase: String) {
        if (_ui.value.busy) return
        _ui.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { WalletRepository.importWallet(getApplication(), phrase) }
            }
            result.onSuccess {
                _ui.update { it.copy(busy = false, imported = true) }
            }.onFailure { e ->
                _ui.update { it.copy(busy = false, error = "Invalid recovery phrase. " + (e.message ?: "")) }
            }
        }
    }

    /** 备份页进入时若还没加载助记词，则加载（覆盖「重启后停在备份页」的情况）。 */
    fun ensureMnemonicLoaded() {
        if (_ui.value.mnemonic.isNotEmpty()) return
        viewModelScope.launch {
            val words = withContext(Dispatchers.IO) {
                runCatching { WalletRepository.mnemonicWords(getApplication()) }.getOrDefault(emptyList())
            }
            _ui.update { it.copy(mnemonic = words) }
        }
    }

    fun confirmBackup() {
        viewModelScope.launch {
            withContext(Dispatchers.IO) { runCatching { WalletRepository.confirmBackup(getApplication()) } }
            _ui.update { it.copy(backupConfirmed = true) }
        }
    }
}
