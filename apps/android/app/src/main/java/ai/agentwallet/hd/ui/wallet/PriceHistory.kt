package ai.agentwallet.hd.ui.wallet

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 真实价格走势数据源（CoinGecko 公共行情 API）。
 * 仅做只读 GET，不发送任何钱包信息；失败一律返回空列表，由 UI 优雅降级。
 * 对照原型 05 资产详情的 sparkline——把装饰占位换成真实行情。
 */

/** symbol → CoinGecko 资产 id。 */
private val COINGECKO_IDS = mapOf(
    "XLM" to "stellar",
    "SOL" to "solana",
    "ETH" to "ethereum",
    "USDC" to "usd-coin",
    "USDT" to "tether",
    "BTC" to "bitcoin",
    "POL" to "polygon-ecosystem-token",
    "MATIC" to "matic-network",
)

/** UI 时间段标签 → CoinGecko 的 days 查询值。 */
fun timeframeDays(tf: String): String = when (tf) {
    "1H", "1D" -> "1"
    "1W" -> "7"
    "1M" -> "30"
    "1Y" -> "365"
    else -> "max"
}

/**
 * 拉取 [symbol] 在 [tf] 时间段内的真实 USD 价格序列（按时间由旧到新）。
 * 出错或不支持的币种返回空列表。下采样到最多 ~48 个点，画出来更干净。
 */
suspend fun fetchPriceSeries(symbol: String, tf: String): List<Float> = withContext(Dispatchers.IO) {
    val id = COINGECKO_IDS[symbol.uppercase()] ?: return@withContext emptyList()
    val days = timeframeDays(tf)
    val endpoint = "https://api.coingecko.com/api/v3/coins/$id/market_chart?vs_currency=usd&days=$days"
    runCatching {
        val conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 8000
            readTimeout = 8000
            setRequestProperty("Accept", "application/json")
        }
        try {
            if (conn.responseCode != HttpURLConnection.HTTP_OK) return@runCatching emptyList<Float>()
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val prices = JSONObject(body).getJSONArray("prices")
            val out = ArrayList<Float>(prices.length())
            for (i in 0 until prices.length()) {
                out.add(prices.getJSONArray(i).getDouble(1).toFloat())
            }
            downsample(out, 48)
        } finally {
            conn.disconnect()
        }
    }.getOrDefault(emptyList())
}

/** 把过密的点等距抽稀到最多 [max] 个。 */
private fun downsample(points: List<Float>, max: Int): List<Float> {
    if (points.size <= max) return points
    val step = points.size.toFloat() / max
    return (0 until max).map { points[(it * step).toInt()] }
}
