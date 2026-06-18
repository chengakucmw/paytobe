package ai.agentwallet.hd;

import org.json.JSONArray;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

final class ScannedPaymentRequestParser {
    private static final String DEFAULT_ETHEREUM_RPC = "https://cloudflare-eth.com";
    private static final String DEFAULT_BASE_RPC = "https://mainnet.base.org";
    private static final String DEFAULT_POLYGON_RPC = "https://polygon-rpc.com";
    private static final String DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";
    private static final String DEFAULT_STELLAR_PUBLIC_HORIZON = "https://horizon.stellar.org";
    private static final String DEFAULT_STELLAR_TESTNET_HORIZON = "https://horizon-testnet.stellar.org";

    private ScannedPaymentRequestParser() {}

    static PaymentIntent parseIntent(String raw) throws Exception {
        JSONObject embedded = parseEmbeddedPaymentRequest(raw);
        if (embedded != null) return PaymentIntent.parse(embedded);

        Draft draft = parseDraft(raw);
        if (draft == null || !draft.isCompleteTransfer()) return null;
        return PaymentIntent.parse(buildPaymentRequest(raw, draft));
    }

    static Draft parseDraft(String raw) {
        String clean = clean(raw);
        if (clean.length() == 0) return null;
        String lower = clean.toLowerCase(Locale.US);
        Map<String, String> params = queryParams(clean);

        Draft draft = null;
        if (lower.startsWith("velarumpay://pay")
                || lower.startsWith("velarumpay:pay")
                || lower.startsWith("velarumpay://payment")
                || lower.startsWith("velarumpay:payment")) {
            draft = fromGenericPayParams(params);
            draft.source = "VelarumPay QR";
        } else if (lower.startsWith("web+stellar:pay") || lower.startsWith("stellar:pay")) {
            draft = fromStellarPay(clean, params);
        } else if (lower.startsWith("ethereum:")) {
            draft = fromEthereumUri(clean, params);
        } else if (lower.startsWith("solana:")) {
            draft = fromSolanaUri(clean, params);
        }

        if (draft == null) return null;
        normalize(draft);
        return draft;
    }

    private static JSONObject parseEmbeddedPaymentRequest(String raw) throws Exception {
        String clean = clean(raw);
        if (clean.length() == 0) return null;
        JSONObject direct = parsePaymentRequestJson(clean);
        if (direct != null) return direct;

        Map<String, String> params = queryParams(clean);
        for (String key : new String[]{"payment_request", "request", "payload", "data"}) {
            String value = params.get(key);
            if (value == null || value.trim().length() == 0) continue;
            JSONObject parsed = parseJsonOrBase64Json(value);
            if (parsed != null) return parsed;
        }
        return null;
    }

    private static JSONObject parseJsonOrBase64Json(String value) throws Exception {
        String clean = clean(value);
        JSONObject direct = parsePaymentRequestJson(clean);
        if (direct != null) return direct;

        String unwrapped = clean;
        if (unwrapped.startsWith("base64:")) unwrapped = unwrapped.substring("base64:".length());
        if (unwrapped.startsWith("base64url:")) unwrapped = unwrapped.substring("base64url:".length());
        for (boolean urlSafe : new boolean[]{false, true}) {
            try {
                byte[] decoded = urlSafe ? Base64.getUrlDecoder().decode(unwrapped) : Base64.getDecoder().decode(unwrapped);
                JSONObject parsed = parsePaymentRequestJson(new String(decoded, StandardCharsets.UTF_8));
                if (parsed != null) return parsed;
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    private static JSONObject parsePaymentRequestJson(String value) throws Exception {
        JSONObject parsed = parseJson(value);
        if (parsed == null || !looksLikePaymentRequest(parsed)) return null;
        return parsed;
    }

    private static boolean looksLikePaymentRequest(JSONObject parsed) {
        JSONObject payment = parsed.optJSONObject("payment");
        if (payment == null || payment.length() == 0) return false;
        String protocol = parsed.optString("protocol", "");
        if (PaymentRequest.PROTOCOL_PAYMENT_REQUEST.equals(protocol)
                || PaymentRequest.PROTOCOL_LEGACY_INTENT.equals(protocol)) {
            return true;
        }
        JSONObject velarum = parsed.optJSONObject("velarum");
        boolean hasRequestIdentity = parsed.has("request_id")
                || parsed.has("intent_id")
                || parsed.has("status_projection")
                || parsed.has("payment_facts")
                || (velarum != null && velarum.has("request_id"));
        boolean hasPaymentFacts = payment.has("amount")
                && (payment.has("to") || payment.has("recipient"))
                && (payment.has("asset") || payment.has("rail") || payment.has("network"));
        return hasRequestIdentity && hasPaymentFacts;
    }

    private static JSONObject parseJson(String value) throws Exception {
        String clean = clean(value);
        if (!clean.startsWith("{")) return null;
        return new JSONObject(clean);
    }

    private static Draft fromGenericPayParams(Map<String, String> params) {
        Draft draft = new Draft();
        draft.to = first(params, "to", "address", "recipient", "destination");
        draft.amount = first(params, "amount", "value_decimal");
        draft.asset = first(params, "asset", "token", "symbol", "asset_code");
        draft.network = first(params, "network", "chain");
        draft.chainId = parseChainId(first(params, "chain_id", "chainid"));
        draft.rpcUrl = first(params, "rpc_url", "rpc");
        draft.horizonUrl = first(params, "horizon_url", "horizon");
        draft.tokenContract = first(params, "token_contract", "contract", "contract_address", "mint", "spl-token");
        draft.assetIssuer = first(params, "asset_issuer", "issuer", "token_issuer");
        draft.decimals = parseInt(first(params, "decimals"), -1);
        draft.memo = first(params, "memo", "label", "message");
        draft.payee = first(params, "payee", "merchant", "merchant_name", "name");
        return draft;
    }

    private static Draft fromStellarPay(String raw, Map<String, String> params) {
        Draft draft = new Draft();
        draft.network = first(params, "network", "chain");
        draft.asset = first(params, "asset_code", "asset", "token", "symbol");
        draft.to = first(params, "destination", "to", "address", "recipient");
        draft.amount = first(params, "amount", "value_decimal");
        draft.horizonUrl = first(params, "horizon_url", "horizon");
        draft.assetIssuer = first(params, "asset_issuer", "issuer", "token_issuer");
        draft.memo = first(params, "memo", "memo_text", "label", "message");
        draft.payee = first(params, "payee", "merchant", "name");
        draft.source = "Stellar payment QR";
        if (draft.to.length() == 0 && raw.toLowerCase(Locale.US).startsWith("stellar:")) {
            String body = uriBody(raw, "stellar:");
            if (body.matches("^G[A-Z2-7]{55}$")) draft.to = body;
        }
        return draft;
    }

    private static Draft fromEthereumUri(String raw, Map<String, String> params) {
        Draft draft = new Draft();
        String body = uriBody(raw, "ethereum:");
        if (body.startsWith("pay-")) body = body.substring(4);
        String target = body;
        int slash = target.indexOf('/');
        String path = "";
        if (slash >= 0) {
            path = target.substring(slash + 1);
            target = target.substring(0, slash);
        }
        int at = target.indexOf('@');
        if (at >= 0) {
            draft.chainId = parseChainId(target.substring(at + 1));
            target = target.substring(0, at);
        }

        draft.network = first(params, "network", "chain");
        long queryChain = parseChainId(first(params, "chain_id", "chainid"));
        if (queryChain > 0) draft.chainId = queryChain;
        draft.rpcUrl = first(params, "rpc_url", "rpc");
        draft.asset = first(params, "asset", "token", "symbol");
        draft.decimals = parseInt(first(params, "decimals"), -1);
        draft.memo = first(params, "memo", "label", "message");
        draft.payee = first(params, "payee", "merchant", "name");
        draft.source = "Ethereum payment QR";

        String lowerPath = path.toLowerCase(Locale.US);
        if (lowerPath.startsWith("transfer")) {
            draft.tokenContract = first(params, "token_contract", "contract", "contract_address");
            if (draft.tokenContract.length() == 0 && target.matches("^0x[0-9a-fA-F]{40}$")) {
                draft.tokenContract = target;
            }
            draft.to = first(params, "address", "to", "recipient");
            String amount = first(params, "amount", "value_decimal");
            if (amount.length() == 0 && first(params, "uint256", "value").length() > 0) {
                int decimals = draft.decimals >= 0 ? draft.decimals : defaultDecimals(draft);
                amount = unitsToDecimal(first(params, "uint256", "value"), decimals);
            }
            draft.amount = amount;
        } else {
            draft.to = first(params, "to", "address", "recipient");
            if (draft.to.length() == 0 && target.matches("^0x[0-9a-fA-F]{40}$")) draft.to = target;
            draft.tokenContract = first(params, "token_contract", "contract", "contract_address");
            draft.amount = first(params, "amount", "value_decimal");
            if (draft.amount.length() == 0 && first(params, "value").length() > 0) {
                draft.amount = unitsToDecimal(first(params, "value"), 18);
            }
        }
        return draft;
    }

    private static Draft fromSolanaUri(String raw, Map<String, String> params) {
        Draft draft = new Draft();
        draft.network = first(params, "network", "chain");
        draft.asset = first(params, "asset", "token", "symbol");
        draft.to = first(params, "to", "address", "recipient");
        if (draft.to.length() == 0) draft.to = uriBody(raw, "solana:");
        draft.amount = first(params, "amount", "value_decimal");
        draft.rpcUrl = first(params, "rpc_url", "rpc");
        draft.tokenContract = first(params, "token_contract", "contract", "mint", "spl-token");
        draft.decimals = parseInt(first(params, "decimals"), -1);
        draft.memo = first(params, "memo", "label", "message");
        draft.payee = first(params, "payee", "merchant", "name");
        draft.source = "Solana payment QR";
        return draft;
    }

    private static void normalize(Draft draft) {
        if (draft.chainId <= 0) draft.chainId = chainIdFromNetwork(draft.network);
        if (draft.network.length() == 0) draft.network = networkFromChainId(draft.chainId);
        draft.network = normalizeNetwork(draft.network, draft.chainId);
        draft.stellarTestnet = draft.stellarTestnet || "stellar_testnet".equals(draft.network);

        if (draft.isStellar()) {
            if (draft.asset.length() == 0) draft.asset = "XLM";
            if (draft.horizonUrl.length() == 0) {
                draft.horizonUrl = draft.stellarTestnet ? DEFAULT_STELLAR_TESTNET_HORIZON : DEFAULT_STELLAR_PUBLIC_HORIZON;
            }
            draft.decimals = draft.decimals >= 0 ? draft.decimals : 7;
            draft.rail = "XLM".equalsIgnoreCase(draft.asset) ? "stellar_xlm" : "stellar_asset";
            return;
        }

        if (draft.isSolana()) {
            if (draft.asset.length() == 0) draft.asset = draft.tokenContract.length() > 0 ? "SPL" : "SOL";
            if (draft.rpcUrl.length() == 0) draft.rpcUrl = DEFAULT_SOLANA_RPC;
            draft.decimals = draft.decimals >= 0 ? draft.decimals : ("SOL".equalsIgnoreCase(draft.asset) ? 9 : 6);
            draft.rail = "SOL".equalsIgnoreCase(draft.asset) && draft.tokenContract.length() == 0 ? "solana_sol" : "solana_spl";
            return;
        }

        if (draft.to.matches("^0x[0-9a-fA-F]{40}$") || draft.tokenContract.matches("^0x[0-9a-fA-F]{40}$")) {
            if (draft.chainId <= 0) draft.chainId = 1L;
            if (draft.network.length() == 0 || "evm".equals(draft.network)) {
                draft.network = networkFromChainId(draft.chainId);
            }
            if (draft.rpcUrl.length() == 0) draft.rpcUrl = rpcFromChainId(draft.chainId);

            boolean baseUsdc = (draft.chainId == 8453L || "base_mainnet".equals(draft.network))
                    && ("USDC".equalsIgnoreCase(draft.asset) || RiskPolicy.BASE_USDC.equalsIgnoreCase(draft.tokenContract));
            if (baseUsdc && (draft.tokenContract.length() == 0 || RiskPolicy.BASE_USDC.equalsIgnoreCase(draft.tokenContract))) {
                draft.network = "base_mainnet";
                draft.chainId = 8453L;
                draft.asset = "USDC";
                draft.tokenContract = RiskPolicy.BASE_USDC;
                draft.decimals = 6;
                draft.rail = "base_usdc";
                if (draft.rpcUrl.length() == 0) draft.rpcUrl = DEFAULT_BASE_RPC;
                return;
            }

            if (draft.asset.length() == 0) draft.asset = nativeAssetFromChainId(draft.chainId);
            draft.decimals = draft.decimals >= 0 ? draft.decimals : (draft.tokenContract.length() > 0 ? 18 : 18);
            draft.rail = draft.tokenContract.length() > 0
                    ? "evm_erc20"
                    : (draft.chainId == 1L && "ETH".equalsIgnoreCase(draft.asset) ? "ethereum_eth" : "evm_native");
        }
    }

    private static JSONObject buildPaymentRequest(String raw, Draft draft) throws Exception {
        long now = System.currentTimeMillis();
        String hash = sha256Hex(raw == null ? "" : raw.trim());
        String requestId = "scan_" + hash.substring(0, 20);
        String payee = firstNonEmpty(draft.payee, "Scanned QR recipient");

        JSONObject payment = new JSONObject()
                .put("rail", draft.rail)
                .put("network", draft.network)
                .put("asset", draft.asset)
                .put("amount", draft.amount)
                .put("to", draft.to)
                .put("decimals", draft.decimals);
        if (draft.chainId > 0) payment.put("chain_id", draft.chainId);
        if (draft.tokenContract.length() > 0) payment.put("token_contract", draft.tokenContract);
        if (draft.assetIssuer.length() > 0) payment.put("asset_issuer", draft.assetIssuer);
        if (draft.rpcUrl.length() > 0) payment.put("rpc_url", draft.rpcUrl);
        if (draft.horizonUrl.length() > 0) payment.put("horizon_url", draft.horizonUrl);
        if (draft.stellarTestnet) payment.put("stellar_testnet", true);
        if (draft.memo.length() > 0) payment.put("memo", draft.memo);

        JSONObject risk = new JSONObject()
                .put("level", "safe")
                .put("review_status", "ready")
                .put("signing_allowed", true)
                .put("errors", new JSONArray())
                .put("warnings", new JSONArray().put(new JSONObject()
                        .put("code", "scanned_qr_review")
                        .put("message", "Scanned QR payment. Verify recipient, amount, network, and fee before signing.")));

        return new JSONObject()
                .put("protocol", PaymentRequest.PROTOCOL_PAYMENT_REQUEST)
                .put("request_id", requestId)
                .put("transaction_id", "txn_" + requestId)
                .put("status", PaymentRequest.STATUS_PENDING)
                .put("created_at_ms", now)
                .put("expires_at_ms", now + 300_000L)
                .put("idempotency_key", "scan:" + hash)
                .put("source", new JSONObject()
                        .put("type", "qr")
                        .put("agent_id", "scanned_qr")
                        .put("agent_name", "Scanned QR")
                        .put("runtime", "mobile_camera")
                        .put("channel", firstNonEmpty(draft.source, "camera")))
                .put("payee", new JSONObject()
                        .put("name", payee)
                        .put("verified", false))
                .put("payment", payment)
                .put("payment_facts", new JSONObject()
                        .put("amount", draft.amount)
                        .put("token", draft.asset)
                        .put("network", draft.network)
                        .put("recipient", draft.to)
                        .put("payee", new JSONObject().put("name", payee)))
                .put("display", new JSONObject()
                        .put("title", "Scanned QR payment")
                        .put("summary", "Review and sign the scanned " + draft.asset + " transfer.")
                        .put("primary_action", "Sign and Pay"))
                .put("policy", new JSONObject().put("requires_user_approval", true))
                .put("context", new JSONObject()
                        .put("status", "ready")
                        .put("transaction_id", "txn_" + requestId)
                        .put("has_snapshot", true))
                .put("transaction_context_snapshot", new JSONObject()
                        .put("transaction_id", "txn_" + requestId)
                        .put("snapshot_hash", "sha256:" + hash)
                        .put("truth_fields", new JSONArray()
                                .put(truthField("payment.amount", draft.amount, draft.asset))
                                .put(truthField("payment.to", draft.to, "")))
                        .put("evidence", new JSONArray())
                        .put("missing_context", new JSONArray())
                        .put("risk_findings", new JSONArray()))
                .put("risk", risk)
                .put("status_projection", new JSONObject()
                        .put("lifecycle_status", PaymentRequest.STATUS_PENDING)
                        .put("review_state", "pending")
                        .put("label", "Awaiting signature")
                        .put("tone", "safe")
                        .put("inbox_group", "pending")
                        .put("is_final", false)
                        .put("requires_attention", true)
                        .put("signing_allowed", true))
                .put("metadata", new JSONObject()
                        .put("source", "scanned_qr")
                        .put("raw_qr_sha256", "sha256:" + hash)
                        .put("raw_qr", raw == null ? "" : raw.trim()));
    }

    private static JSONObject truthField(String field, String value, String currency) throws Exception {
        JSONObject out = new JSONObject()
                .put("field", field)
                .put("value", value)
                .put("source_type", "payment_request_fact")
                .put("verification_status", "scanned_qr")
                .put("confidence", "user_review_required");
        if (currency.length() > 0) out.put("currency", currency);
        return out;
    }

    private static String normalizeNetwork(String network, long chainId) {
        String clean = clean(network).toLowerCase(Locale.US).replace("-", "_").replace(" ", "_");
        if (clean.equals("base") || clean.equals("base_mainnet") || chainId == 8453L) return "base_mainnet";
        if (clean.equals("ethereum") || clean.equals("eth") || clean.equals("mainnet") || clean.equals("ethereum_mainnet") || chainId == 1L) return "ethereum_mainnet";
        if (clean.equals("polygon") || clean.equals("polygon_mainnet") || clean.equals("polygon_pos") || clean.equals("matic") || chainId == 137L) return "polygon_pos";
        if (clean.equals("stellar") || clean.equals("stellar_public") || clean.equals("public")) return "stellar_public";
        if (clean.equals("stellar_testnet") || clean.equals("testnet")) return "stellar_testnet";
        if (clean.equals("solana") || clean.equals("solana_mainnet") || clean.equals("mainnet_beta")) return "solana_mainnet";
        return clean;
    }

    private static long chainIdFromNetwork(String network) {
        String clean = clean(network).toLowerCase(Locale.US);
        if (clean.contains("8453") || clean.contains("base")) return 8453L;
        if (clean.contains("137") || clean.contains("polygon") || clean.contains("matic")) return 137L;
        if (clean.contains("1") || clean.contains("ethereum") || clean.equals("eth") || clean.equals("mainnet")) return 1L;
        return 0L;
    }

    private static String networkFromChainId(long chainId) {
        if (chainId == 8453L) return "base_mainnet";
        if (chainId == 137L) return "polygon_pos";
        if (chainId == 1L) return "ethereum_mainnet";
        return chainId > 0 ? "eip155_" + chainId : "";
    }

    private static String rpcFromChainId(long chainId) {
        if (chainId == 8453L) return DEFAULT_BASE_RPC;
        if (chainId == 137L) return DEFAULT_POLYGON_RPC;
        if (chainId == 1L) return DEFAULT_ETHEREUM_RPC;
        return "";
    }

    private static String nativeAssetFromChainId(long chainId) {
        if (chainId == 137L) return "MATIC";
        return "ETH";
    }

    private static int defaultDecimals(Draft draft) {
        if (draft.decimals >= 0) return draft.decimals;
        if ("USDC".equalsIgnoreCase(draft.asset)
                || RiskPolicy.BASE_USDC.equalsIgnoreCase(draft.tokenContract)) return 6;
        if (draft.isStellar()) return 7;
        if (draft.isSolana()) return 9;
        return 18;
    }

    private static Map<String, String> queryParams(String raw) {
        LinkedHashMap<String, String> out = new LinkedHashMap<>();
        String query = queryPart(raw);
        if (query.length() == 0) return out;
        for (String part : query.split("&")) {
            if (part.length() == 0) continue;
            int eq = part.indexOf('=');
            String key = eq >= 0 ? part.substring(0, eq) : part;
            String value = eq >= 0 ? part.substring(eq + 1) : "";
            key = urlDecode(key).trim().toLowerCase(Locale.US);
            if (key.length() == 0 || out.containsKey(key)) continue;
            out.put(key, urlDecode(value).trim());
        }
        return out;
    }

    private static String queryPart(String raw) {
        String clean = clean(raw);
        int q = clean.indexOf('?');
        if (q < 0 || q == clean.length() - 1) return "";
        int hash = clean.indexOf('#', q + 1);
        return hash >= 0 ? clean.substring(q + 1, hash) : clean.substring(q + 1);
    }

    private static String uriBody(String raw, String prefix) {
        String clean = clean(raw);
        if (!clean.toLowerCase(Locale.US).startsWith(prefix)) return "";
        String value = clean.substring(prefix.length());
        int q = value.indexOf('?');
        if (q >= 0) value = value.substring(0, q);
        return value;
    }

    private static String first(Map<String, String> values, String... keys) {
        for (String key : keys) {
            String value = values.get(key.toLowerCase(Locale.US));
            if (value != null && value.trim().length() > 0 && !"null".equalsIgnoreCase(value.trim())) {
                return value.trim();
            }
        }
        return "";
    }

    private static String firstNonEmpty(String... values) {
        if (values == null) return "";
        for (String value : values) {
            if (value != null && value.trim().length() > 0 && !"null".equalsIgnoreCase(value.trim())) return value.trim();
        }
        return "";
    }

    private static long parseChainId(String value) {
        String clean = clean(value).toLowerCase(Locale.US).replace("eip155:", "");
        if (clean.length() == 0) return 0L;
        if (clean.equals("base")) return 8453L;
        if (clean.equals("polygon") || clean.equals("matic")) return 137L;
        if (clean.equals("ethereum") || clean.equals("eth") || clean.equals("mainnet")) return 1L;
        try {
            if (clean.startsWith("0x")) return Long.parseLong(clean.substring(2), 16);
            return Long.parseLong(clean);
        } catch (Exception ignored) {
            return 0L;
        }
    }

    private static int parseInt(String value, int fallback) {
        try {
            return Integer.parseInt(clean(value));
        } catch (Exception ignored) {
            return fallback;
        }
    }

    private static String unitsToDecimal(String units, int decimals) {
        try {
            BigInteger raw = parseInteger(units);
            BigDecimal value = new BigDecimal(raw).movePointLeft(decimals).stripTrailingZeros();
            String text = value.toPlainString();
            return text.equals("-0") ? "0" : text;
        } catch (Exception ignored) {
            return "";
        }
    }

    private static BigInteger parseInteger(String value) {
        String clean = clean(value).toLowerCase(Locale.US);
        if (clean.startsWith("0x")) return new BigInteger(clean.substring(2), 16);
        return new BigInteger(clean);
    }

    private static String urlDecode(String value) {
        try {
            return URLDecoder.decode(value == null ? "" : value, "UTF-8");
        } catch (Exception ignored) {
            return value == null ? "" : value;
        }
    }

    private static boolean decimalGreaterThanZero(String value) {
        if (value == null || !value.matches("^(0|[1-9]\\d*)(\\.\\d+)?$")) return false;
        try {
            return new BigDecimal(value).compareTo(BigDecimal.ZERO) > 0;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String sha256Hex(String value) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format(Locale.US, "%02x", b & 0xff));
        return out.toString();
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    static final class Draft {
        String rail = "";
        String network = "";
        String asset = "";
        String to = "";
        String amount = "";
        long chainId;
        String rpcUrl = "";
        String horizonUrl = "";
        String tokenContract = "";
        String assetIssuer = "";
        int decimals = -1;
        String memo = "";
        String payee = "";
        String source = "Scanned QR";
        boolean stellarTestnet;

        boolean isCompleteTransfer() {
            if (to.length() == 0 || !decimalGreaterThanZero(amount)) return false;
            if (isSolana() && tokenContract.length() > 0) return false;
            return rail.length() > 0 && asset.length() > 0 && network.length() > 0;
        }

        boolean isStellar() {
            if (network.toLowerCase(Locale.US).contains("stellar")) return true;
            boolean match = to.matches("^G[A-Z2-7]{55}$");
            if (match) {
                stellarTestnet = "stellar_testnet".equals(network);
            }
            return match;
        }

        boolean isSolana() {
            return network.toLowerCase(Locale.US).contains("solana")
                    || (to.matches("^[1-9A-HJ-NP-Za-km-z]{32,48}$") && !isStellar());
        }
    }
}
