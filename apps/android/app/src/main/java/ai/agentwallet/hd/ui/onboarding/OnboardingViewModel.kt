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
    /** 验证页点错后回到备份页时，用它在备份页上提示「刚才没对上」。 */
    val verifyMismatch: Boolean = false,
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

    /**
     * 仅在用户「按顺序点选」验证通过后调用：持久化「已备份」标记并触发进入主界面。
     * 验证逻辑在 UI 层用纯函数 SeedVerification.isCorrect 完成，这里不改动任何业务/密钥逻辑。
     */
    fun confirmBackup() {
        viewModelScope.launch {
            withContext(Dispatchers.IO) { runCatching { WalletRepository.confirmBackup(getApplication()) } }
            _ui.update { it.copy(backupConfirmed = true, verifyMismatch = false) }
        }
    }

    /** 验证点错：打个标记，让备份页提示用户重新核对后再试。 */
    fun flagVerifyMismatch() {
        _ui.update { it.copy(verifyMismatch = true) }
    }

    /** 重新进入验证页前清除上一次的「没对上」提示。 */
    fun clearVerifyMismatch() {
        if (_ui.value.verifyMismatch) _ui.update { it.copy(verifyMismatch = false) }
    }
}
