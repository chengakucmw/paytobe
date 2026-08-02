package ai.agentwallet.hd

import android.content.Context

/**
 * 代理连接读取门面：包裹包内私有的 AgentConnectionStore + RelayClient，映射为 public 模型。
 * 对照 web 的 renderAgents / renderAgentDetail。
 */
object AgentsRepository {

    fun list(context: Context): List<AgentUi> = try {
        AgentConnectionStore.list(context).map { it.toUi() }
    } catch (e: Exception) {
        VpLog.w("AgentsRepository", "list agents failed", e)
        emptyList()
    }

    fun detail(context: Context, connectionId: String): AgentUi? = try {
        AgentConnectionStore.find(context, connectionId)?.toUi()
    } catch (e: Exception) {
        VpLog.w("AgentsRepository", "agent detail lookup failed", e)
        null
    }

    /** 撤销连接：尽力同步 relay，并把本地状态置 revoked。 */
    fun revoke(context: Context, connectionId: String) {
        val connection = try { AgentConnectionStore.find(context, connectionId) } catch (e: Exception) { VpLog.w("AgentsRepository", "revoke: connection lookup failed", e); null } ?: return
        try { RelayClient.revokeConnection(context, connection) } catch (e: Exception) { VpLog.w("AgentsRepository", "revoke: relay sync failed", e) }
        try { AgentConnectionStore.updateStatus(context, connectionId, "revoked") } catch (e: Exception) { VpLog.w("AgentsRepository", "revoke: local status write failed", e) }
    }

    private fun AgentConnection.toUi() = AgentUi(
        id = connectionId,
        name = displayName(),
        runtime = runtime ?: "",
        deviceLabel = deviceLabel ?: "",
        status = status ?: "",
        scopes = scopes ?: emptyList(),
        revoked = isRevoked(),
    )
}

/**
 * 配对门面：通过码取配对会话，展示请求的权限，批准/拒绝（RelayClient，需配置 relay）。
 * 不持有包内私有的 PairingSession——每个动作按码重新取一次会话。
 */
object PairingRepository {

    fun fetch(context: Context, codeOrUri: String): PairingUi {
        val code = codeOrUri.trim()
        val session = RelayClient.fetchPairingSession(context, code, "") ?: error("Pairing session not found.")
        return PairingUi(
            name = session.displayName(),
            runtime = session.runtime ?: "",
            deviceLabel = session.deviceLabel ?: "",
            requestedScopes = session.requestedScopes ?: emptyList(),
            pending = session.isPending(),
            code = code,
        )
    }

    fun approve(context: Context, code: String, scopes: List<String>) {
        val session = RelayClient.fetchPairingSession(context, code.trim(), "") ?: error("Pairing session not found.")
        RelayClient.approvePairing(context, session, scopes)
    }

    fun reject(context: Context, code: String) {
        val session = RelayClient.fetchPairingSession(context, code.trim(), "") ?: error("Pairing session not found.")
        RelayClient.rejectPairing(context, session)
    }
}

object ConnectInvitationRepository {
    fun create(context: Context): ConnectInvitationUi = RelayClient.createConnectInvitation(context).toUi()

    fun refresh(context: Context, invitationId: String, connectKey: String): ConnectInvitationUi =
        RelayClient.fetchConnectInvitation(context, invitationId, connectKey).toUi()

    fun cancel(context: Context, invitationId: String, connectKey: String): ConnectInvitationUi =
        RelayClient.cancelConnectInvitation(context, invitationId, connectKey).toUi()

    private fun ConnectInvitation.toUi() = ConnectInvitationUi(
        id = connectInvitationId,
        connectKey = connectKey,
        status = status,
        pairingSessionId = pairingSessionId,
        connectionId = connectionId,
        agentName = agentName,
        runtime = runtime,
        source = source,
        identityAssurance = identityAssurance,
        requestedScopes = requestedScopes,
        expiresAt = expiresAt,
        terminal = isTerminal(),
        claimed = hasClaimedAgent(),
    )
}

data class AgentUi(
    val id: String,
    val name: String,
    val runtime: String,
    val deviceLabel: String,
    val status: String,
    val scopes: List<String>,
    val revoked: Boolean,
)

data class PairingUi(
    val name: String,
    val runtime: String,
    val deviceLabel: String,
    val requestedScopes: List<String>,
    val pending: Boolean,
    val code: String,
)

data class ConnectInvitationUi(
    val id: String,
    val connectKey: String,
    val status: String,
    val pairingSessionId: String,
    val connectionId: String,
    val agentName: String,
    val runtime: String,
    val source: String,
    val identityAssurance: String,
    val requestedScopes: List<String>,
    val expiresAt: String,
    val terminal: Boolean,
    val claimed: Boolean,
)
