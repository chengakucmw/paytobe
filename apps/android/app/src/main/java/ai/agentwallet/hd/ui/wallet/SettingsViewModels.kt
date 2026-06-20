package ai.agentwallet.hd.ui.wallet

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import ai.agentwallet.hd.ActivityUi
import ai.agentwallet.hd.DeviceInfoUi
import ai.agentwallet.hd.IdentityUi
import ai.agentwallet.hd.NetworkUi
import ai.agentwallet.hd.SettingsRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class IdentityEditState(val identity: IdentityUi? = null, val saved: Boolean = false)

class IdentityViewModel(app: Application) : AndroidViewModel(app) {
    private val _ui = MutableStateFlow(IdentityEditState())
    val ui: StateFlow<IdentityEditState> = _ui.asStateFlow()

    init { load() }

    fun load() {
        viewModelScope.launch {
            val identity = withContext(Dispatchers.IO) { SettingsRepository.identity(getApplication()) }
            _ui.update { it.copy(identity = identity, saved = false) }
        }
    }

    fun save(nickname: String, avatar: String) {
        viewModelScope.launch {
            withContext(Dispatchers.IO) {
                SettingsRepository.setNickname(getApplication(), nickname)
                SettingsRepository.setAvatar(getApplication(), avatar)
            }
            _ui.update { it.copy(saved = true) }
        }
    }
}

data class NetworksState(
    val loading: Boolean = true,
    val networks: List<NetworkUi> = emptyList(),
    val adding: Boolean = false,
    val error: String? = null,
)

class NetworksViewModel(app: Application) : AndroidViewModel(app) {
    private val _ui = MutableStateFlow(NetworksState())
    val ui: StateFlow<NetworksState> = _ui.asStateFlow()

    init { reload() }

    fun reload() {
        _ui.update { it.copy(loading = true) }
        viewModelScope.launch {
            val networks = withContext(Dispatchers.IO) { SettingsRepository.networks(getApplication()) }
            _ui.update { it.copy(loading = false, networks = networks) }
        }
    }

    fun addEvm(name: String, rpcUrl: String, chainId: String, symbol: String, explorer: String) {
        if (_ui.value.adding) return
        _ui.update { it.copy(adding = true, error = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { SettingsRepository.addEvmNetwork(getApplication(), name, rpcUrl, chainId, symbol, explorer) }
            }
            result.onSuccess {
                _ui.update { it.copy(adding = false) }
                reload()
            }.onFailure { e ->
                _ui.update { it.copy(adding = false, error = e.message ?: "Could not add network.") }
            }
        }
    }
}

data class ActivityState(val loading: Boolean = true, val items: List<ActivityUi> = emptyList())

class ActivityViewModel(app: Application) : AndroidViewModel(app) {
    private val _ui = MutableStateFlow(ActivityState())
    val ui: StateFlow<ActivityState> = _ui.asStateFlow()

    init { reload() }

    fun reload() {
        _ui.update { it.copy(loading = true) }
        viewModelScope.launch {
            val items = withContext(Dispatchers.IO) { SettingsRepository.activity(getApplication()) }
            _ui.update { it.copy(loading = false, items = items) }
        }
    }
}

data class DeveloperState(val info: DeviceInfoUi? = null)

class DeveloperViewModel(app: Application) : AndroidViewModel(app) {
    private val _ui = MutableStateFlow(DeveloperState())
    val ui: StateFlow<DeveloperState> = _ui.asStateFlow()

    init { load() }

    fun load() {
        viewModelScope.launch {
            val info = withContext(Dispatchers.IO) { SettingsRepository.deviceInfo(getApplication()) }
            _ui.update { it.copy(info = info) }
        }
    }

    fun setRelay(url: String) {
        viewModelScope.launch {
            withContext(Dispatchers.IO) { SettingsRepository.setRelayUrl(getApplication(), url) }
            load()
        }
    }
}
