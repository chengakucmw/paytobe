package ai.agentwallet.hd.ui.wallet

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import ai.agentwallet.hd.AgentUi
import ai.agentwallet.hd.AgentsRepository
import ai.agentwallet.hd.ConnectInvitationRepository
import ai.agentwallet.hd.ConnectInvitationUi
import ai.agentwallet.hd.PairingRepository
import ai.agentwallet.hd.PairingUi
import ai.agentwallet.hd.RelayClient
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

data class ConnectKeyUiState(
    val loading: Boolean = false,
    val invitation: ConnectInvitationUi? = null,
    val error: String? = null,
    val cancelling: Boolean = false,
    val review: ConnectIdentityReviewUi? = null,
    val deciding: Boolean = false,
    val decisionComplete: Boolean = false,
)

data class ConnectIdentityReviewUi(
    val state: String,
    val approvalAllowed: Boolean,
    val reasonCode: String,
    val merchantId: String,
    val merchantName: String,
    val merchantStatus: String,
    val merchantVerificationState: String,
    val verifiedDomain: String,
    val agentId: String,
    val agentName: String,
    val agentStatus: String,
    val runtime: String,
    val credentialId: String,
    val credentialStatus: String,
    val credentialExpiresAt: String,
    val expiresAt: String,
    val requestedScopes: List<String>,
    val approvableNow: Boolean,
)

class ConnectKeyViewModel(app: Application) : AndroidViewModel(app) {
    private val _ui = MutableStateFlow(ConnectKeyUiState())
    val ui: StateFlow<ConnectKeyUiState> = _ui.asStateFlow()

    fun reset() = _ui.update { ConnectKeyUiState() }

    fun load(invitationId: String) {
        val normalized = invitationId.trim()
        if (normalized.isEmpty() || _ui.value.loading) return
        _ui.update { ConnectKeyUiState(loading = true) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val invitation = ConnectInvitationRepository.refresh(getApplication(), normalized, "")
                    val review = if (invitation.claimed) {
                        RelayClient.fetchConnectReview(getApplication(), normalized).toUi()
                    } else null
                    invitation to review
                }
            }
            result.onSuccess { (invitation, review) ->
                _ui.update { ConnectKeyUiState(invitation = invitation, review = review) }
            }.onFailure { error ->
                _ui.update { ConnectKeyUiState(error = error.message ?: "Could not load the Agent connection request.") }
            }
        }
    }

    fun create() {
        if (_ui.value.loading) return
        _ui.update { it.copy(loading = true, error = null, review = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { ConnectInvitationRepository.create(getApplication()) } }
            result.onSuccess { invitation -> _ui.update { it.copy(loading = false, invitation = invitation) } }
                .onFailure { error -> _ui.update { it.copy(loading = false, error = error.message ?: "Could not create Connect Key.") } }
        }
    }

    fun refresh() {
        val invitation = _ui.value.invitation ?: return
        if (_ui.value.loading || invitation.terminal) return
        _ui.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val refreshed = ConnectInvitationRepository.refresh(getApplication(), invitation.id, invitation.connectKey)
                    val review = if (refreshed.claimed) RelayClient.fetchConnectReview(getApplication(), refreshed.id).toUi() else null
                    refreshed to review
                }
            }
            result.onSuccess { (refreshed, review) -> _ui.update { it.copy(loading = false, invitation = refreshed, review = review) } }
                .onFailure { _ui.update { it.copy(loading = false, review = null, error = "Live identity review is unavailable. Approval is disabled.") } }
        }
    }

    fun approve() {
        val invitation = _ui.value.invitation ?: return
        val review = _ui.value.review ?: return
        if (_ui.value.deciding || !review.approvableNow || invitation.status != "claimed") return
        _ui.update { it.copy(deciding = true, error = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    RelayClient.approveConnectInvitation(getApplication(), invitation.id)
                    ConnectInvitationRepository.refresh(getApplication(), invitation.id, invitation.connectKey)
                }
            }
            result.onSuccess { refreshed ->
                _ui.update { it.copy(deciding = false, invitation = refreshed, review = null, decisionComplete = true) }
            }.onFailure {
                _ui.update { it.copy(deciding = false, review = null, error = "Identity changed or approval is no longer available. Refresh before trying again.") }
            }
        }
    }

    fun reject() {
        val invitation = _ui.value.invitation ?: return
        if (_ui.value.deciding || invitation.status != "claimed") return
        _ui.update { it.copy(deciding = true, error = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    RelayClient.rejectConnectInvitation(getApplication(), invitation.id)
                    ConnectInvitationRepository.refresh(getApplication(), invitation.id, invitation.connectKey)
                }
            }
            result.onSuccess { refreshed ->
                _ui.update { it.copy(deciding = false, invitation = refreshed, review = null, decisionComplete = true) }
            }.onFailure {
                _ui.update { it.copy(deciding = false, review = null, error = "Rejection could not be confirmed. Refresh the invitation state.") }
            }
        }
    }

    fun cancel() {
        val invitation = _ui.value.invitation ?: return
        if (_ui.value.cancelling || invitation.terminal) return
        _ui.update { it.copy(cancelling = true, error = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { ConnectInvitationRepository.cancel(getApplication(), invitation.id, invitation.connectKey) }
            }
            result.onSuccess { cancelled -> _ui.update { it.copy(cancelling = false, invitation = cancelled) } }
                .onFailure { error -> _ui.update { it.copy(cancelling = false, error = error.message ?: "Could not cancel Connect Key.") } }
        }
    }

    private fun RelayClient.ConnectReview.toUi() = ConnectIdentityReviewUi(
        state = state,
        approvalAllowed = approvalAllowed,
        reasonCode = reasonCode,
        merchantId = merchantId,
        merchantName = merchantName,
        merchantStatus = merchantStatus,
        merchantVerificationState = merchantVerificationState,
        verifiedDomain = verifiedDomain,
        agentId = agentId,
        agentName = agentName,
        agentStatus = agentStatus,
        runtime = runtime,
        credentialId = credentialId,
        credentialStatus = credentialStatus,
        credentialExpiresAt = credentialExpiresAt,
        expiresAt = expiresAt,
        requestedScopes = requestedScopes,
        approvableNow = approvableNow,
    )
}
