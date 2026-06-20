package ai.agentwallet.hd.ui.wallet

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import ai.agentwallet.hd.AgentUi
import ai.agentwallet.hd.AgentsRepository
import ai.agentwallet.hd.PairingRepository
import ai.agentwallet.hd.PairingUi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class AgentsUiState(val loading: Boolean = true, val agents: List<AgentUi> = emptyList())

class AgentsViewModel(app: Application) : AndroidViewModel(app) {
    private val _ui = MutableStateFlow(AgentsUiState())
    val ui: StateFlow<AgentsUiState> = _ui.asStateFlow()

    init { reload() }

    fun reload() {
        _ui.update { it.copy(loading = true) }
        viewModelScope.launch {
            val agents = withContext(Dispatchers.IO) { AgentsRepository.list(getApplication()) }
            _ui.update { it.copy(loading = false, agents = agents) }
        }
    }
}

data class AgentDetailUiState(
    val loading: Boolean = true,
    val agent: AgentUi? = null,
    val working: Boolean = false,
    val revoked: Boolean = false,
)

class AgentDetailViewModel(app: Application) : AndroidViewModel(app) {
    private var connectionId: String = ""
    private val _ui = MutableStateFlow(AgentDetailUiState())
    val ui: StateFlow<AgentDetailUiState> = _ui.asStateFlow()

    fun load(id: String) {
        connectionId = id
        _ui.update { it.copy(loading = true, revoked = false) }
        viewModelScope.launch {
            val agent = withContext(Dispatchers.IO) { AgentsRepository.detail(getApplication(), id) }
            _ui.update { it.copy(loading = false, agent = agent) }
        }
    }

    fun revoke() {
        if (_ui.value.working) return
        _ui.update { it.copy(working = true) }
        viewModelScope.launch {
            withContext(Dispatchers.IO) { AgentsRepository.revoke(getApplication(), connectionId) }
            _ui.update { it.copy(working = false, revoked = true) }
        }
    }
}

data class PairingUiState(
    val code: String = "",
    val loading: Boolean = false,
    val session: PairingUi? = null,
    val error: String? = null,
    val working: Boolean = false,
    val done: Boolean = false,
)

class PairingViewModel(app: Application) : AndroidViewModel(app) {
    private val _ui = MutableStateFlow(PairingUiState())
    val ui: StateFlow<PairingUiState> = _ui.asStateFlow()

    fun setCode(value: String) = _ui.update { it.copy(code = value, error = null) }

    fun preset(code: String) {
        _ui.update { it.copy(code = code) }
        if (code.isNotBlank()) fetch()
    }

    fun fetch() {
        if (_ui.value.loading || _ui.value.code.isBlank()) return
        _ui.update { it.copy(loading = true, error = null, session = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { PairingRepository.fetch(getApplication(), _ui.value.code) } }
            result.onSuccess { s -> _ui.update { it.copy(loading = false, session = s) } }
                .onFailure { e -> _ui.update { it.copy(loading = false, error = e.message ?: "Could not load pairing session.") } }
        }
    }

    fun approve() {
        val session = _ui.value.session ?: return
        if (_ui.value.working) return
        _ui.update { it.copy(working = true, error = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { PairingRepository.approve(getApplication(), _ui.value.code, session.requestedScopes) } }
            result.onSuccess { _ui.update { it.copy(working = false, done = true) } }
                .onFailure { e -> _ui.update { it.copy(working = false, error = e.message ?: "Approve failed.") } }
        }
    }

    fun reject() {
        if (_ui.value.working) return
        _ui.update { it.copy(working = true, error = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { PairingRepository.reject(getApplication(), _ui.value.code) } }
            result.onSuccess { _ui.update { it.copy(working = false, done = true) } }
                .onFailure { e -> _ui.update { it.copy(working = false, error = e.message ?: "Reject failed.") } }
        }
    }
}
