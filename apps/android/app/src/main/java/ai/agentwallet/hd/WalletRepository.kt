package ai.agentwallet.hd

import android.content.Context
import org.json.JSONObject
import java.util.Locale

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

    /** 对应 NativeBridge.hasWallet() */
    fun hasWallet(context: Context): Boolean = SecureWalletStore.hasWallet(context)

    /** 是否已确认备份助记词（发送的前置条件之一）。 */
    fun isBackupVerified(context: Context): Boolean = SecureWalletStore.isBackupVerified(context)

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

    private const val STELLAR_HORIZON = "https://horizon.stellar.org"
    private const val SOLANA_RPC = "https://api.mainnet-beta.solana.com"
    private const val BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

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
            buildSendPaymentRoot(form.symbol, form.network, to, amount, form.memo)
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
        }
        return tx
    }

    /** 逐字照搬 buildLocalSendIntent：严格 (symbol, network) 白名单，未知组合抛错。 */
    @Throws(Exception::class)
    private fun buildSendPaymentRoot(symbol: String, network: String, to: String, amount: String, memo: String): JSONObject {
        val sym = symbol.trim().uppercase(Locale.US)
        val net = network.trim().lowercase(Locale.US)
        val payment = JSONObject()
        payment.put("amount", amount)
        payment.put("to", to)
        if (memo.trim().isNotEmpty()) payment.put("memo", memo.trim())
        if (sym == "XLM" && net.contains("stellar")) {
            payment.put("rail", "stellar_xlm"); payment.put("network", "stellar"); payment.put("asset", "XLM"); payment.put("horizon_url", STELLAR_HORIZON)
        } else if (sym == "SOL" && net.contains("solana")) {
            payment.put("rail", "solana_sol"); payment.put("network", "solana_mainnet"); payment.put("asset", "SOL"); payment.put("decimals", 9); payment.put("rpc_url", SOLANA_RPC)
        } else if (sym == "USDC" && net == "base") {
            payment.put("rail", "base_usdc"); payment.put("network", "base_mainnet"); payment.put("asset", "USDC"); payment.put("chain_id", 8453L); payment.put("token_contract", BASE_USDC); payment.put("decimals", 6)
        } else if (sym == "ETH" && net == "base") {
            evmNativePayment(payment, "base_mainnet", "ETH", 8453L)
        } else if (sym == "ETH" && net == "ethereum") {
            evmNativePayment(payment, "ethereum", "ETH", 1L)
        } else if ((sym == "POL" || sym == "MATIC") && (net == "polygon" || net.contains("polygon pos"))) {
            evmNativePayment(payment, "polygon", sym, 137L)
        } else {
            throw IllegalStateException(
                symbol + " on " + network +
                    " is not supported for sending in this build. Supported: XLM on Stellar, " +
                    "SOL on Solana, ETH on Ethereum or Base, USDC on Base, POL on Polygon.",
            )
        }
        val root = JSONObject()
        root.put("request_id", "local-send-" + System.currentTimeMillis())
        root.put("status", PaymentIntent.STATUS_PENDING)
        root.put("payment", payment)
        return root
    }

    private fun evmNativePayment(payment: JSONObject, network: String, asset: String, chainId: Long) {
        payment.put("rail", "evm_native")
        payment.put("network", network)
        payment.put("asset", asset)
        payment.put("chain_id", chainId)
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
        val tx = PaymentExecutor.execute(context, wallet, intent)
        RiskPolicy.recordSuccessfulPayment(context, intent)
        try { PaymentInboxStore.updateStatus(context, intent.id, "broadcasted", tx, null) } catch (ignored: Exception) {}
        try { RelayClient.updateStatus(context, intent, "broadcasted", tx, null) } catch (ignored: Exception) {}
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
        } catch (ignored: Exception) {}
        return tx
    }

    /** 拒绝收件箱请求：本地状态置 rejected，并尽力同步到 relay。 */
    fun rejectInbox(context: Context, intentId: String) {
        try { PaymentInboxStore.updateStatus(context, intentId, "rejected", null, null) } catch (ignored: Exception) {}
        try {
            val intent = PaymentInboxStore.find(context, intentId)
            if (intent != null) RelayClient.updateStatus(context, intent, "rejected", null, null)
        } catch (ignored: Exception) {}
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
            )
        }
        return out
    }

    private fun shorten(address: String?): String {
        if (address == null) return ""
        if (address.length <= 12) return address
        return address.substring(0, 6) + "..." + address.substring(address.length - 4)
    }
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
)

/** 发送表单输入。 */
data class SendForm(
    val symbol: String,
    val network: String,
    val recipient: String,
    val amount: String,
    val memo: String,
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
