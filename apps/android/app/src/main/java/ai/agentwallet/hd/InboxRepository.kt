package ai.agentwallet.hd

import android.content.Context

/**
 * 收件箱读取门面：把包内私有的 PaymentInboxStore / PaymentIntent / TransactionDossier /
 * PaymentInboxFilter 映射为 public Kotlin 模型，供 UI 使用（支付/拒绝在 WalletRepository）。
 * 对照 web 的 renderInbox / renderDetail / renderDossier。
 */
object InboxRepository {

    /** 列表（按 filter：pending / all / final）。读取失败返回空。 */
    fun load(context: Context, filter: String): List<InboxItem> {
        val intents = try { PaymentInboxStore.list(context) } catch (e: Exception) { emptyList<PaymentIntent>() }
        val out = ArrayList<InboxItem>()
        for (intent in intents) {
            val req = intent.request
            val state = PaymentInboxFilter.effectiveState(intent.status, req.reviewState, req.riskReviewStatus, req.riskLevel, intent.isExpired)
            if (!PaymentInboxFilter.matches(filter, state)) continue
            out.add(
                InboxItem(
                    id = intent.id,
                    title = intent.title(),
                    payee = payeeOf(intent),
                    amount = intent.amount,
                    asset = intent.asset,
                    network = intent.network,
                    stateLabel = PaymentInboxFilter.label(state),
                    // 状态药丸的语气来自「生命周期/有效状态」（expired→灰+时钟，terminal/failed→红等），
                    // 终态须压过纯 riskLevel；仅签名前的活跃态回落到 riskLevel 的语气。
                    tone = toneForBadge(state, req.riskLevel),
                    signable = signable(intent, state),
                    expired = intent.isExpired,
                ),
            )
        }
        return out
    }

    fun detail(context: Context, intentId: String): InboxDetail? {
        val intent = try { PaymentInboxStore.find(context, intentId) } catch (e: Exception) { null } ?: return null
        val req = intent.request
        val dossier = TransactionDossier.from(intent)
        val state = PaymentInboxFilter.effectiveState(intent.status, req.reviewState, req.riskReviewStatus, req.riskLevel, intent.isExpired)
        return InboxDetail(
            id = intent.id,
            payee = payeeOf(intent),
            recipient = intent.to,
            network = intent.network,
            amount = intent.amount,
            asset = intent.asset,
            total = req.total.ifBlank { intent.amount },
            fee = intent.estimatedFee.ifBlank { "—" },
            riskTitle = dossier.riskTitle,
            riskBody = dossier.riskBody,
            riskTone = dossier.tone,
            stateLabel = PaymentInboxFilter.label(state),
            stateTone = PaymentInboxFilter.toneForState(state),
            signable = signable(intent, state),
            dossier = mapDossier(dossier),
        )
    }

    /** 通知打开的请求可能尚未落地本地收件箱：缺失则从 relay 拉取并 upsert（对照旧 openPaymentIntentFromNotification）。 */
    fun ensure(context: Context, intentId: String) {
        try {
            if (PaymentInboxStore.find(context, intentId) == null) {
                val remote = RelayClient.fetchIntent(context, intentId)
                if (remote != null) PaymentInboxStore.upsert(context, remote)
            }
        } catch (e: Exception) {
        }
    }

    private fun signable(intent: PaymentIntent, state: String): Boolean =
        !PaymentInboxFilter.isFinalState(state) && intent.status == PaymentIntent.STATUS_PENDING

    private fun payeeOf(intent: PaymentIntent): String {
        val req = intent.request
        return firstNonEmpty(intent.merchantName, req.payeeName, intent.recipientName, intent.sourceLabel(), "Unknown payee")
    }

    /**
     * 状态药丸的最终语气：
     * - 签名前的活跃关注态（pending/needs_review/...）→ 沿用风险等级 riskLevel 的语气（保持旧观感：caution=琥珀、danger=红）。
     * - 已签名/广播中/终态/过期 → 由生命周期「有效状态」决定，使 expired 呈独立的灰+时钟（EXPIRED），
     *   confirmed=绿、failed/rejected/cancelled=红等，终态压过纯风险等级。
     */
    private fun toneForBadge(state: String, riskLevel: String?): String =
        if (PaymentInboxFilter.isActiveAttentionState(state)) toneOf(riskLevel)
        else PaymentInboxFilter.toneForState(state)

    private fun toneOf(value: String?): String = when (value?.lowercase()) {
        "safe", "success" -> "safe"
        "caution", "warning", "pending" -> "caution"
        "danger", "error", "failed" -> "danger"
        else -> "info"
    }

    private fun firstNonEmpty(vararg values: String?): String {
        for (v in values) if (!v.isNullOrBlank() && !v.equals("null", true)) return v.trim()
        return ""
    }

    private fun mapDossier(d: TransactionDossier): DossierUi = DossierUi(
        title = d.title,
        status = d.status,
        tone = d.tone,
        agentName = d.agentName,
        source = d.source,
        riskTitle = d.riskTitle,
        riskBody = d.riskBody,
        evidence = d.evidenceItems.map { EvidenceUi(it.title, it.meta, it.tone) },
        decisionRows = d.decisionRows.map { DossierRowUi(it.label, it.value, it.detail, it.tone) },
        itemRows = d.itemRows.map { DossierRowUi(it.label, it.value, it.detail, it.tone) },
        agentSteps = d.agentSteps.map { TraceStepUi(it.title, it.body, it.tone) },
        permissionRiskRows = d.permissionRiskRows.map { DossierRowUi(it.label, it.value, it.detail, it.tone) },
        paymentMappingRows = d.paymentMappingRows.map { DossierRowUi(it.label, it.value, it.detail, it.tone) },
        truthSections = d.truthSections.map { s ->
            TruthSectionUi(
                title = s.title,
                note = s.note,
                tone = s.tone,
                rows = s.rows.map { r -> TruthRowUi(r.field, r.value, r.source, r.status, r.evidence, r.tone) },
            )
        },
    )
}

// ---------------- public UI 模型 ----------------

data class InboxItem(
    val id: String,
    val title: String,
    val payee: String,
    val amount: String,
    val asset: String,
    val network: String,
    val stateLabel: String,
    val tone: String,
    val signable: Boolean,
    val expired: Boolean,
)

data class InboxDetail(
    val id: String,
    val payee: String,
    val recipient: String,
    val network: String,
    val amount: String,
    val asset: String,
    val total: String,
    val fee: String,
    val riskTitle: String,
    val riskBody: String,
    val riskTone: String,
    val stateLabel: String,
    val stateTone: String,
    val signable: Boolean,
    val dossier: DossierUi,
)

data class DossierUi(
    val title: String,
    val status: String,
    val tone: String,
    val agentName: String,
    val source: String,
    val riskTitle: String,
    val riskBody: String,
    val evidence: List<EvidenceUi>,
    val decisionRows: List<DossierRowUi>,
    val itemRows: List<DossierRowUi>,
    val agentSteps: List<TraceStepUi>,
    val permissionRiskRows: List<DossierRowUi>,
    val paymentMappingRows: List<DossierRowUi>,
    val truthSections: List<TruthSectionUi>,
)

data class DossierRowUi(val label: String, val value: String, val detail: String, val tone: String)
data class EvidenceUi(val title: String, val meta: String, val tone: String)
data class TraceStepUi(val title: String, val body: String, val tone: String)
data class TruthRowUi(val field: String, val value: String, val source: String, val status: String, val evidence: String, val tone: String)
data class TruthSectionUi(val title: String, val note: String, val tone: String, val rows: List<TruthRowUi>)
