package ai.agentwallet.hd

import android.content.Context
import android.content.Intent
import java.util.Locale

/** 扫码结果的分类。 */
sealed class ScanOutcome {
    /** 配对链接/码 → 去配对页。 */
    data class Pairing(val code: String) : ScanOutcome()

    /** 可发送的转账（地址 + 可选金额/备注）→ 预填 Send。symbol 为空表示未能识别资产，让用户在 Send 选。 */
    data class Transfer(val symbol: String, val network: String, val recipient: String, val amount: String, val memo: String) : ScanOutcome()

    /** 无法识别。 */
    data object Unknown : ScanOutcome()
}

/**
 * Compose 与现有 QrScannerActivity（CameraX + MLKit）之间的契约：构造启动 Intent、读取返回的
 * payload，并用现有的 ScannedPaymentRequestParser 分类（逻辑复用，不改）。本文件须在
 * package ai.agentwallet.hd，才能访问 QrScannerActivity.EXTRA_PAYLOAD 与解析器。
 */
object ScanContract {

    fun intent(context: Context): Intent = Intent(context, QrScannerActivity::class.java)

    fun payloadOf(data: Intent?): String? = data?.getStringExtra(QrScannerActivity.EXTRA_PAYLOAD)

    fun classify(raw: String?): ScanOutcome {
        val s = raw?.trim().orEmpty()
        if (s.isEmpty()) return ScanOutcome.Unknown
        val lower = s.lowercase(Locale.US)
        if (lower.startsWith("velarumpay://pair") || lower.startsWith("velarumpay:pair")) {
            return ScanOutcome.Pairing(extractPairingCode(s))
        }
        val draft = try { ScannedPaymentRequestParser.parseDraft(s) } catch (e: Exception) { VpLog.d("ScanContract", "parse draft failed; not a payment request: $e"); null }
        if (draft != null && !draft.to.isNullOrBlank()) {
            // Pass the asset symbol straight through (all 30 chains are now valid). The Send
            // ViewModel resolves the exact chain + runs the authoritative address-type check.
            return ScanOutcome.Transfer(
                symbol = (draft.asset ?: "").trim().uppercase(Locale.US),
                network = "",
                recipient = draft.to.trim(),
                amount = (draft.amount ?: "").trim(),
                memo = (draft.memo ?: "").trim(),
            )
        }
        // Raw address: accept it as a transfer iff it matches a supported chain's address format
        // (the "validate address type up front" requirement). The Send screen then detects the
        // candidate chain(s) and asks the user to confirm when an address fits several chains.
        if (WalletRepository.chainsForAddress(s).isNotEmpty()) return ScanOutcome.Transfer("", "", s, "", "")
        return ScanOutcome.Unknown
    }

    private fun extractPairingCode(raw: String): String {
        val afterScheme = raw.substringAfter("pair", "")
        val q = raw.substringAfter("code=", "")
        if (q.isNotBlank()) return q.substringBefore('&').trim()
        return afterScheme.trim('/', ':', '?').trim()
    }
}
