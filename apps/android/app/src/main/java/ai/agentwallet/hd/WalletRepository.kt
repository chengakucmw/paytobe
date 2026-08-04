package ai.agentwallet.hd

import android.content.Context
import org.json.JSONObject
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * 原生 UI 唯一的「门面 / Repository」：把界面需要的钱包操作集中在此，内部调用
 * ai.agentwallet.hd 包内的成熟逻辑（HDWallet / SecureWalletStore / BalanceFetcher /
 * BalanceStore ...）。
 *
 * 关键约束：这些 Java 逻辑类是「包内私有（package-private）」的，本文件**必须**声明
 * package ai.agentwallet.hd 才能访问它们——从而做到「复用而不修改」业务逻辑（铁律 1）。
 * ViewModel / 界面只依赖本门面暴露的 public Kotlin 类型，不直接接触包内私有 Java 类型。
 *
 * 对照旧的 WalletWebActivity.NativeBridge（那就是 UI↔逻辑 的契约）。
 * 本阶段（Phase 0）只搬「读」与「钱包生命周期」方法；发送管线在发送流程阶段加入。
 */
object WalletRepository {

    // App-lifetime scope for best-effort, fire-and-forget relay status reports. These must
    // outlive a screen's viewModelScope (which is cancelled when the user navigates away
    // right after a successful pay/reject), so they run here. The on-chain tx and the local
    // store are already updated before any report is launched, so a dropped report never
    // affects local correctness — it only delays the relay/agent's view of the status.
    private val reportScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** 对应 NativeBridge.hasWallet() */
    fun hasWallet(context: Context): Boolean = SecureWalletStore.hasWallet(context)

    /** 是否已确认备份助记词（发送的前置条件之一）。 */
    fun isBackupVerified(context: Context): Boolean = SecureWalletStore.isBackupVerified(context)

    /** relay 是否已配置（启动常驻推送服务 RelayPushService 的前置条件之一）。 */
    fun isRelayConfigured(context: Context): Boolean =
        PlatformServiceConfig.supportsWebSocket() &&
            !PaymentInboxStore.relayUrl(context).isNullOrBlank()

    /**
     * 对应 NativeBridge.walletData()：地址 / 身份 / 缓存余额。
     * 任何读取异常都退回安全默认值（与旧 ensureWalletLoaded 的「吞掉异常」行为一致）。
     */
    fun loadWalletState(context: Context): WalletState {
        val hasWallet = runCatching { SecureWalletStore.hasWallet(context) }.getOrDefault(false)
        val backupVerified = runCatching { SecureWalletStore.isBackupVerified(context) }.getOrDefault(false)
        val wallet = loadWallet(context)
        val balances = runCatching { parseBalances(BalanceStore.cached(context)) }.getOrDefault(emptyMap())
        return WalletState(
            hasWallet = hasWallet,
            backupVerified = backupVerified,
            evmAddress = wallet?.evm?.address,
            solanaAddress = wallet?.solana?.address,
            stellarAddress = wallet?.stellar?.address,
            walletId = wallet?.let { shorten(it.evm.address) },
            walletName = IdentityStore.nickname(context),
            avatar = IdentityStore.avatar(context),
            balances = balances,
        )
    }

    /**
     * 对应 NativeBridge.refreshBalances()：联网拉取余额并写入缓存。
     * 含网络 IO，请在后台线程（如 Dispatchers.IO）调用。
     */
    fun refreshBalances(context: Context) {
        val wallet = loadWallet(context) ?: return
        val balances = BalanceFetcher.fetch(wallet)
        BalanceStore.save(context, balances)
    }

    /** 对应 NativeBridge.createWallet()：新建并保存（未标记已备份）。可能抛异常，调用方负责捕获。 */
    fun createWallet(context: Context) {
        val created = HDWallet.create()
        SecureWalletStore.save(context, created.serialize(), false)
    }

    /** 对应 NativeBridge.importWallet(phrase)：导入助记词并保存（标记已备份）。 */
    fun importWallet(context: Context, phrase: String) {
        val restored = HDWallet.restore(phrase.trim())
        SecureWalletStore.save(context, restored.serialize(), true)
    }

    /** 对应 NativeBridge.mnemonicWords()：返回助记词单词列表（无钱包时空列表）。 */
    fun mnemonicWords(context: Context): List<String> {
        val wallet = loadWallet(context) ?: return emptyList()
        return runCatching { HDWallet.mnemonicWords(wallet.mnemonic) }.getOrDefault(emptyList())
    }

    /** 对应 NativeBridge.confirmBackup()：标记助记词已备份。 */
    fun confirmBackup(context: Context) {
        SecureWalletStore.markBackupVerified(context)
    }

    // ---------------- 发送（最关键管线，逐字照搬 WalletWebActivity.send / buildLocalSendIntent）----------------

    private val STELLAR_HORIZON = if (BuildConfig.TESTNET_ONLY) {
        BuildNetworkPolicy.STELLAR_TESTNET_HORIZON
    } else {
        BuildConfig.STELLAR_MAINNET_HORIZON_URL
    }
    private const val SOLANA_RPC = "https://api.mainnet-beta.solana.com"

    /**
     * 第一段（生物识别之前）：前置校验 → 组装 PaymentIntent → RiskPolicy 评估。
     * 顺序与 WalletWebActivity.send() 完全一致：钱包 → 备份 → 收款人/金额非空 → 组装 → 风控。
     * 返回 [SendPreparation]；调用方在 allowed 时弹生物识别，再调 [confirmSend]。
     */
    fun prepareSend(context: Context, form: SendForm): SendPreparation {
        val to = form.recipient.trim()
        val amount = form.amount.trim()
        if (loadWallet(context) == null) return SendPreparation.blocked(form, listOf("No wallet loaded."))
        if (!SecureWalletStore.isBackupVerified(context)) {
            return SendPreparation.blocked(form, listOf("Back up your recovery phrase first."), backupRequired = true)
        }
        if (to.isEmpty() || amount.isEmpty()) return SendPreparation.blocked(form, listOf("Enter a recipient and amount."))
        val root = try {
            buildSendPaymentRoot(form, to, amount, form.memo)
        } catch (e: Exception) {
            return SendPreparation.blocked(form, listOf(e.message ?: "Unsupported transfer."))
        }
        val intent = PaymentIntent.parse(root)
        val risk = RiskPolicy.evaluate(context, intent)
        return SendPreparation(
            allowed = risk.allowed,
            errors = risk.errors.toList(),
            warnings = risk.warnings.toList(),
            symbol = form.symbol,
            network = form.network,
            recipient = to,
            amount = amount,
            memo = form.memo.trim(),
            intentJson = root.toString(),
        )
    }

    /**
     * 第二段（生物识别成功后）：重解析同一份 intent JSON → PaymentExecutor.execute（内部再跑一次
     * RiskPolicy，纵深防御）→ recordSuccessfulPayment（记当日额度）→ TransactionHistoryStore.record。
     * 返回交易哈希。逐字对应 WalletWebActivity.send() 认证成功后的线程体。请在 IO 线程调用。
     */
    fun confirmSend(context: Context, prep: SendPreparation): String {
        val intent = PaymentIntent.parse(prep.intentJson)
        val wallet = loadWallet(context) ?: throw IllegalStateException("No wallet loaded.")
        val tx = PaymentExecutor.execute(context, wallet, intent)
        RiskPolicy.recordSuccessfulPayment(context, intent)
        try {
            TransactionHistoryStore.record(
                context,
                if (!tx.isNullOrEmpty()) "tx:$tx" else "local:" + System.currentTimeMillis(),
                "Send " + prep.symbol,
                prep.symbol,
                prep.amount,
                prep.network,
                prep.recipient,
                "broadcasted",
                tx,
            )
        } catch (ignored: Exception) {
            VpLog.w("WalletRepository", "history record write failed after broadcast", ignored)
        }
        return tx
    }

    /**
     * 只读估算当前发送的真实网络费用（供 CONFIRM 展示）。复用 confirmSend 同一份 intentJson，与
     * [PaymentExecutor] 相同的分链路由，但只做只读 RPC（不签名、不广播）。
     * 失败或链不支持时返回 null，UI 回退到「Calculated at broadcast」。请在 IO 线程调用。
     */
    fun estimateNetworkFee(context: Context, prep: SendPreparation): String? {
        if (prep.intentJson.isBlank()) return null
        return try {
            val intent = PaymentIntent.parse(prep.intentJson)
            val wallet = loadWallet(context) ?: return null
            NetworkFeeEstimator.estimateDisplayFee(context, wallet, intent)
        } catch (e: Exception) {
            VpLog.w("WalletRepository", "network fee estimate failed", e)
            null
        }
    }

    // ---------------- 资产目录（驱动 Send 选链 UI + 扫码地址校验）----------------
    //
    // 单一事实来源是包内私有的 TransferAssetRegistry（全 30 条链）。门面把它映射成 UI 可见的
    // public 类型，从而 UI 层不直接接触包内私有 Java 类型（铁律 1）。
    // sendable = 该链已具备设备端直签（direct_broadcast）；其余（prepared_payload）在 UI 上显示
    // “Feature is under development”，并在路由层兜底拒绝（绝不盲签）。

    /** UI 可见的可转账资产（一条链一项）。 */
    fun transferAssets(): List<TransferAssetOption> = if (BuildConfig.TESTNET_ONLY) {
        listOf(
            TransferAssetOption(
                rail = "stellar_xlm",
                symbol = "XLM",
                chain = "Stellar Testnet",
                network = BuildNetworkPolicy.STELLAR_TESTNET_NETWORK,
                family = "stellar",
                chainId = 0,
                sendable = true,
            ),
        )
    } else {
        TransferAssetRegistry.ASSETS.map { it.toOption() }
    }

    /**
     * 扫码/粘贴地址的「提前校验地址类型」：返回该地址在注册表里可能匹配的所有链。
     * 0 个 → 不是受支持的地址；1 个 → 可直接预选；多个（如所有 EVM 链共用 0x…）→ 让用户选链。
     */
    fun chainsForAddress(address: String): List<TransferAssetOption> {
        val a = address.trim()
        if (a.isEmpty()) return emptyList()
        return transferAssets().filter { option ->
            TransferAssetRegistry.ASSETS.firstOrNull { it.rail == option.rail }
                ?.recipient
                ?.matcher(a)
                ?.matches() == true
        }
    }

    /** 给定 rail，判断收款地址是否符合该链的地址格式（用于发送页的实时校验）。 */
    fun addressMatchesChain(address: String, rail: String): Boolean {
        val asset = TransferAssetRegistry.ASSETS.firstOrNull { it.rail == rail } ?: return false
        return asset.recipient.matcher(address.trim()).matches()
    }

    private fun TransferAssetRegistry.Asset.toOption(): TransferAssetOption = TransferAssetOption(
        rail = rail,
        symbol = symbol,
        chain = chain,
        network = network,
        family = family,
        chainId = chainId,
        // direct_broadcast = 设备端可直签直广播；prepared_payload = 尚无链族签名器 → under development
        sendable = !requiresPreparedPayload(),
    )

    /** 把 (rail | symbol+chain) 解析为注册表里的资产；找不到返回 null。 */
    private fun resolveSendAsset(form: SendForm): TransferAssetRegistry.Asset? {
        val rail = form.rail.trim()
        if (rail.isNotEmpty()) {
            TransferAssetRegistry.ASSETS.firstOrNull { it.rail == rail }?.let { return it }
        }
        val sym = form.symbol.trim().uppercase(Locale.US)
        val chain = form.network.trim()
        // 资产的 chain 展示名在注册表里唯一（如 ETH 分别落在 Ethereum / Arbitrum One / …），
        // 因此 symbol + chain 足以唯一确定一条链。
        TransferAssetRegistry.ASSETS.firstOrNull {
            it.symbol.equals(sym, ignoreCase = true) && it.chain.equals(chain, ignoreCase = true)
        }?.let { return it }
        // 兜底：老调用方可能传 network id（如 ethereum_mainnet）。
        return TransferAssetRegistry.find("", chain, sym, 0L)
    }

    /**
     * 由注册表驱动的发送 intent 组装（取代旧的 5 条硬编码白名单）：
     *  - direct_broadcast：Stellar / Solana / Base USDC（ERC-20）/ 任意已注册 EVM 原生币。
     *  - prepared_payload：抛 “Feature is under development”（UI 也会提前拦下，这里是纵深防御）。
     */
    @Throws(Exception::class)
    private fun buildSendPaymentRoot(form: SendForm, to: String, amount: String, memo: String): JSONObject {
        val asset = resolveSendAsset(form)
            ?: throw IllegalStateException(form.symbol + " on " + form.network + " is not supported for sending.")
        if (asset.requiresPreparedPayload()) {
            throw IllegalStateException(
                asset.symbol + " on " + asset.chain +
                    " — Feature is under development. On-device signing for this chain isn't available yet.",
            )
        }
        val payment = JSONObject()
        payment.put("amount", amount)
        payment.put("to", to)
        if (memo.trim().isNotEmpty()) payment.put("memo", memo.trim())
        when {
            asset.rail == "stellar_xlm" -> {
                payment.put("rail", "stellar_xlm")
                payment.put("network", if (BuildConfig.TESTNET_ONLY) BuildNetworkPolicy.STELLAR_TESTNET_NETWORK else "stellar_public")
                payment.put("asset", "XLM")
                payment.put("horizon_url", STELLAR_HORIZON)
                payment.put("stellar_testnet", BuildConfig.TESTNET_ONLY)
            }
            asset.rail == "solana_sol" -> {
                payment.put("rail", "solana_sol"); payment.put("network", "solana_mainnet"); payment.put("asset", "SOL"); payment.put("decimals", 9); payment.put("rpc_url", SOLANA_RPC)
            }
            asset.family == "evm" && asset.tokenContract.isNotEmpty() -> {
                // ERC-20（当前仅 Base USDC）。token_contract / decimals 取自注册表（权威），不再硬编码。
                payment.put("rail", asset.rail); payment.put("network", asset.network); payment.put("asset", asset.symbol)
                payment.put("chain_id", asset.chainId); payment.put("token_contract", asset.tokenContract); payment.put("decimals", asset.decimals)
            }
            asset.family == "evm" -> {
                // 任意已注册 EVM 链的原生币。chain_id 是 RPC/网络解析的键（WalletNetworkConfig.matches）。
                // decimals 取自注册表（EVM 原生币=18），保持 intent 自洽（原生广播按 ETHER 计，不依赖该值）。
                payment.put("rail", "evm_native"); payment.put("network", asset.network); payment.put("asset", asset.symbol); payment.put("chain_id", asset.chainId); payment.put("decimals", asset.decimals)
            }
            else -> throw IllegalStateException(
                asset.symbol + " on " + asset.chain +
                    " — Feature is under development. On-device signing for this chain isn't available yet.",
            )
        }
        val root = JSONObject()
        root.put("request_id", "local-send-" + System.currentTimeMillis())
        root.put("status", PaymentIntent.STATUS_PENDING)
        root.put("payment", payment)
        return root
    }

    // ---------------- 收件箱支付（复用同一条 RiskPolicy→生物→PaymentExecutor→记账 管线）----------------

    /** 准备支付收件箱中的某个 PaymentIntent（生物识别之前）：前置校验 + RiskPolicy 评估。 */
    fun prepareInboxPay(context: Context, intentId: String): SendPreparation {
        val intent = PaymentInboxStore.find(context, intentId)
            ?: return SendPreparation(false, listOf("Payment request not found."), emptyList(), "", "", "", "", "", "")
        if (loadWallet(context) == null) {
            return SendPreparation(false, listOf("No wallet loaded."), emptyList(), intent.asset, intent.network, intent.to, intent.amount, intent.memo, "")
        }
        if (!SecureWalletStore.isBackupVerified(context)) {
            return SendPreparation(false, listOf("Back up your recovery phrase first."), emptyList(), intent.asset, intent.network, intent.to, intent.amount, intent.memo, "", backupRequired = true)
        }
        val risk = RiskPolicy.evaluate(context, intent)
        return SendPreparation(
            allowed = risk.allowed,
            errors = risk.errors.toList(),
            warnings = risk.warnings.toList(),
            symbol = intent.asset,
            network = intent.network,
            recipient = intent.to,
            amount = intent.amount,
            memo = intent.memo,
            intentJson = intent.toJson().toString(),
        )
    }

    /** 生物识别成功后：执行收件箱支付 + 记账 + 回写收件箱/relay 状态。请在 IO 线程调用。 */
    fun confirmInboxPay(context: Context, prep: SendPreparation): String {
        val intent = PaymentIntent.parse(prep.intentJson)
        val wallet = loadWallet(context) ?: throw IllegalStateException("No wallet loaded.")
        // Close the expiry race before touching signing material. The Platform must accept
        // the authenticated `signed` transition while the request is still valid; otherwise
        // fail closed and never broadcast a transaction that the Platform has already expired.
        // A later signed -> broadcasted report gets a short server-side delivery grace so a
        // Stellar ledger close at the expiry boundary cannot create split-brain state.
        RelayClient.updateStatus(context, intent, "signed", null, null)
        val tx = try {
            PaymentExecutor.execute(context, wallet, intent)
        } catch (error: Exception) {
            try { PaymentInboxStore.updateStatus(context, intent.id, "failed", null, error.message) } catch (ignored: Exception) { VpLog.w("WalletRepository", "inbox status write failed after payment error", ignored) }
            try { RelayClient.updateStatus(context, intent, "failed", null, error.message) } catch (ignored: Exception) { VpLog.w("WalletRepository", "relay status sync failed after payment error", ignored) }
            throw error
        }
        RiskPolicy.recordSuccessfulPayment(context, intent)
        try { PaymentInboxStore.updateStatus(context, intent.id, "broadcasted", tx, null) } catch (ignored: Exception) { VpLog.w("WalletRepository", "inbox status write failed after broadcast", ignored) }
        try {
            TransactionHistoryStore.record(
                context,
                if (!tx.isNullOrEmpty()) "tx:$tx" else "intent:" + intent.id,
                "Pay " + prep.symbol,
                prep.symbol,
                prep.amount,
                prep.network,
                prep.recipient,
                "broadcasted",
                tx,
            )
        } catch (ignored: Exception) { VpLog.w("WalletRepository", "history record write failed after inbox pay", ignored) }
        // Relay status report is best-effort and must NOT gate the success UI: the tx is
        // already on-chain and the local store already reflects "broadcasted". Fire it on the
        // app-lifetime scope so it still completes if the user leaves the detail screen (the
        // caller's viewModelScope is cancelled on navigation). Failure is logged only.
        reportScope.launch {
            try { RelayClient.updateStatus(context, intent, "broadcasted", tx, null) } catch (e: Exception) { VpLog.w("WalletRepository", "relay status sync failed after broadcast", e) }
        }
        return tx
    }

    /** 拒绝收件箱请求：本地状态置 rejected，并尽力同步到 relay。 */
    fun rejectInbox(context: Context, intentId: String) {
        try { PaymentInboxStore.updateStatus(context, intentId, "rejected", null, null) } catch (ignored: Exception) { VpLog.w("WalletRepository", "inbox status write failed on reject", ignored) }
        // Local state is set above; report to the relay off the caller's thread so the reject
        // UI doesn't wait on a network round-trip, on the app-lifetime scope so it survives the
        // screen popping after reject. Best-effort; failure is logged only.
        val intent = try { PaymentInboxStore.find(context, intentId) } catch (e: Exception) { VpLog.w("WalletRepository", "inbox lookup failed on reject", e); null }
        if (intent != null) {
            reportScope.launch {
                try { RelayClient.updateStatus(context, intent, "rejected", null, null) } catch (e: Exception) { VpLog.w("WalletRepository", "relay status sync failed on reject", e) }
            }
        }
    }

    // ---------------- 内部 ----------------

    /** 从安全存储解密并解析出 HDWallet；无钱包或失败返回 null（不抛）。 */
    private fun loadWallet(context: Context): HDWallet? = runCatching {
        if (!SecureWalletStore.hasWallet(context)) {
            null
        } else {
            val saved = SecureWalletStore.load(context)
            if (saved == null) null else HDWallet.parse(saved)
        }
    }.getOrNull()

    private fun parseBalances(cached: JSONObject): Map<String, AssetBalance> {
        val assets = cached.optJSONObject("assets") ?: return emptyMap()
        val out = LinkedHashMap<String, AssetBalance>()
        val keys = assets.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val obj = assets.optJSONObject(key) ?: continue
            out[key] = AssetBalance(
                balance = obj.optString("balance", ""),
                status = obj.optString("status", ""),
                error = obj.optString("error", ""),
            )
        }
        return out
    }

    // Delegates to the shared AddressFormat (D9/Q5) — unified 6…4 form (was a local
    // copy using the ASCII "..." separator; now standardised on the "…" ellipsis).
    private fun shorten(address: String?): String = AddressFormat.shortAddress(address)
}

/** 钱包对外快照（public，UI 层用）。 */
data class WalletState(
    val hasWallet: Boolean,
    val backupVerified: Boolean,
    val evmAddress: String?,
    val solanaAddress: String?,
    val stellarAddress: String?,
    val walletId: String?,
    val walletName: String,
    val avatar: String,
    val balances: Map<String, AssetBalance>,
)

/** 单个资产的缓存余额（key 形如 eth / base_usdc / sol / xlm / polygon_matic）。 */
data class AssetBalance(
    val balance: String,
    val status: String,
    val error: String = "",
)

/** 发送表单输入。rail 由选链 UI 透传，使路由免于符号歧义（如 ETH 跨多条链）。 */
data class SendForm(
    val symbol: String,
    val network: String,
    val recipient: String,
    val amount: String,
    val memo: String,
    val rail: String = "",
)

/**
 * UI 可见的可转账资产（一条链一项），由 [WalletRepository.transferAssets] 从注册表映射而来。
 * sendable=false 表示该链尚无设备端签名器 → 在选链页显示 “Feature is under development”。
 */
data class TransferAssetOption(
    val rail: String,
    val symbol: String,
    val chain: String,
    val network: String,
    val family: String,
    val chainId: Long,
    val sendable: Boolean,
)

/**
 * 发送准备结果（public，UI 用）。intentJson 为内部字段，供 [WalletRepository.confirmSend] 重解析
 * 同一份 intent，从而不把包内私有的 PaymentIntent 类型暴露到 UI 层。
 */
class SendPreparation(
    val allowed: Boolean,
    val errors: List<String>,
    val warnings: List<String>,
    val symbol: String,
    val network: String,
    val recipient: String,
    val amount: String,
    val memo: String,
    internal val intentJson: String,
    val backupRequired: Boolean = false,
) {
    /** 与 WalletWebActivity.joinMessages 一致：用 "; " 连接错误；为空时给默认文案。 */
    val errorText: String
        get() = if (errors.isEmpty()) "This payment can't be sent right now." else errors.joinToString("; ")

    companion object {
        internal fun blocked(form: SendForm, errors: List<String>, backupRequired: Boolean = false) = SendPreparation(
            allowed = false,
            errors = errors,
            warnings = emptyList(),
            symbol = form.symbol,
            network = form.network,
            recipient = form.recipient.trim(),
            amount = form.amount.trim(),
            memo = form.memo.trim(),
            intentJson = "",
            backupRequired = backupRequired,
        )
    }
}
