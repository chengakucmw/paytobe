package ai.agentwallet.hd;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

final class PaymentIntent {
    static final String STATUS_PENDING = "pending";
    static final String STATUS_SIGNED = "signed";
    static final String STATUS_BROADCASTED = "broadcasted";
    static final String STATUS_CONFIRMED = "confirmed";
    static final String STATUS_FAILED = "failed";
    static final String STATUS_EXPIRED = "expired";
    static final String STATUS_REJECTED = "rejected";

    final String id;
    final String status;
    final long createdAt;
    final long expiresAt;
    final String sourceType;
    final String sourceChannel;
    final String sourceDeviceId;
    final String velarumRequestId;
    final String velarumPayloadHash;
    final String rail;
    final String network;
    final long chainId;
    final String asset;
    final String assetIssuer;
    final String tokenContract;
    final int decimals;
    final String amount;
    final String to;
    final String memo;
    final String memoType;
    final String rpcUrl;
    final String horizonUrl;
    final boolean stellarTestnet;
    final String estimatedFee;
    final String signingPayload;
    final String signingPayloadEncoding;
    final boolean signingPayloadDigest;
    final String broadcastUrl;
    final String idempotencyKey;
    final String txHash;
    final String error;
    final String displayTitle;
    final String displaySummary;
    final String displayButton;
    final PaymentRequest request;
    final String merchantName;
    final String merchantWebsite;
    final String merchantCategory;
    final String recipientName;
    final DemoOrderMetadata demo;
    final List<String> warnings;
    final JSONObject raw;

    private PaymentIntent(JSONObject raw) {
        request = PaymentRequest.parse(raw);
        this.raw = request.toJson();
        raw = this.raw;
        JSONObject payment = raw.optJSONObject("payment");
        if (payment == null) payment = new JSONObject();
        JSONObject source = raw.optJSONObject("source");
        if (source == null) source = new JSONObject();
        JSONObject velarum = raw.optJSONObject("velarum");
        if (velarum == null) velarum = new JSONObject();
        JSONObject risk = raw.optJSONObject("risk");
        if (risk == null) risk = new JSONObject();
        JSONObject display = raw.optJSONObject("display");
        if (display == null) display = new JSONObject();
        JSONObject merchant = firstObject(raw.optJSONObject("merchant"), velarum.optJSONObject("payload") == null ? null : velarum.optJSONObject("payload").optJSONObject("merchant"));
        if (merchant == null) merchant = new JSONObject();
        JSONObject recipient = firstObject(raw.optJSONObject("recipient"), velarum.optJSONObject("payload") == null ? null : velarum.optJSONObject("payload").optJSONObject("recipient"));
        if (recipient == null) recipient = new JSONObject();

        id = request.id;
        status = request.status;
        createdAt = request.createdAt;
        expiresAt = request.expiresAt;
        sourceType = request.sourceType;
        sourceChannel = request.sourceChannel;
        sourceDeviceId = firstNonEmpty(request.sourceDeviceLabel, request.sourceDeviceId);
        velarumRequestId = request.requestId;
        velarumPayloadHash = velarum.optString("payload_hash", "");
        rail = request.rail;
        network = request.network;
        chainId = request.chainId;
        asset = request.asset;
        tokenContract = request.tokenContract;
        assetIssuer = request.assetIssuer;
        decimals = request.decimals;
        amount = request.amount;
        to = request.recipient;
        memo = request.memo;
        memoType = request.memoType;
        rpcUrl = request.rpcUrl;
        stellarTestnet = request.stellarTestnet;
        horizonUrl = request.horizonUrl;
        estimatedFee = request.estimatedFee;
        signingPayload = firstNonEmpty(
                payment.optString("signing_payload", ""),
                payment.optString("unsigned_payload", ""),
                payment.optString("payload", "")
        );
        signingPayloadEncoding = normalizePayloadEncoding(firstNonEmpty(
                payment.optString("signing_payload_encoding", ""),
                payment.optString("payload_encoding", ""),
                "hex"
        ));
        signingPayloadDigest = payment.optBoolean(
                "signing_payload_is_digest",
                payment.optBoolean("payload_is_digest", false)
        );
        broadcastUrl = firstNonEmpty(
                payment.optString("broadcast_url", ""),
                payment.optString("submit_url", "")
        );
        idempotencyKey = request.idempotencyKey;
        txHash = request.txHash;
        error = request.error;
        displayTitle = request.displayTitle;
        displaySummary = request.displaySummary;
        displayButton = request.displayButton;
        merchantName = firstNonEmpty(merchant.optString("name", ""), request.payeeName);
        merchantWebsite = normalizePublicUrl(firstNonEmpty(merchant.optString("website", ""), request.payeeDomain));
        merchantCategory = merchant.optString("category", "");
        recipientName = firstNonEmpty(recipient.optString("name", ""), request.payeeName);
        // L3: demo-only food_order / restaurant fields are parsed by a dedicated
        // adapter so this core protocol model stays free of demo coupling
        // (see DemoOrderMetadata; AGENTS.md item 9). Mirrors iOS.
        demo = DemoOrderMetadata.parse(this.raw);
        warnings = request.warnings;
    }

    static PaymentIntent parse(JSONObject raw) {
        return new PaymentIntent(raw);
    }

    static PaymentIntent parse(String raw) throws Exception {
        return parse(new JSONObject(raw));
    }

    JSONObject toJson() {
        return raw;
    }

    boolean isExpired() {
        // expiresAt == NO_EXPIRY (0) means the server gave no expiry -> never expires (M12).
        return expiresAt > 0L && System.currentTimeMillis() > expiresAt;
    }

    boolean hasExpiry() {
        return expiresAt > 0L;
    }

    boolean isBaseUsdc() {
        return (rail.equals("evm_erc20") || rail.equals("base_usdc"))
                && network.equals("base_mainnet")
                && chainId == 8453L
                && asset.equalsIgnoreCase("USDC");
    }

    boolean isStellarXlm() {
        return rail.equals("stellar_xlm") && asset.equalsIgnoreCase("XLM");
    }

    boolean isStellarAsset() {
        return (rail.equals("stellar_asset") || network.toLowerCase().contains("stellar"))
                && !asset.equalsIgnoreCase("XLM");
    }

    boolean isRegisteredEvmNative() {
        TransferAssetRegistry.Asset registered = TransferAssetRegistry.find(this);
        return registered != null
                && registered.signerImplemented
                && !registered.requiresPreparedPayload()
                && "evm".equals(registered.family)
                && registered.tokenContract.length() == 0
                && tokenContract.length() == 0
                && !isBaseUsdc();
    }

    boolean isSolanaSol() {
        return rail.equals("solana_sol") && asset.equalsIgnoreCase("SOL");
    }

    boolean requiresSignerAdapter() {
        TransferAssetRegistry.Asset registered = TransferAssetRegistry.find(this);
        return registered != null && !registered.signerImplemented;
    }

    boolean requiresPreparedPayloadSigner() {
        TransferAssetRegistry.Asset registered = TransferAssetRegistry.find(this);
        return registered != null && registered.requiresPreparedPayload();
    }

    String title() {
        if (displayTitle.length() > 0) return displayTitle;
        if (isBaseUsdc()) return "Send " + amount + " USDC";
        if (isStellarXlm()) return "Send " + amount + " XLM";
        if (isStellarAsset()) return "Send " + amount + " " + asset;
        if (isSolanaSol()) return "Send " + amount + " SOL";
        if (isRegisteredEvmNative()) return "Send " + amount + " " + asset;
        return "Payment Request";
    }

    String summary() {
        if (displaySummary.length() > 0) return displaySummary;
        if (demo.itemSummary.length() > 0) return demo.itemSummary;
        if (request.summary().length() > 0) return request.summary();
        return sourceLabel();
    }

    String payButtonLabel() {
        if (displayButton.length() > 0) return displayButton;
        return request.payButtonLabel();
    }

    String sourceLabel() {
        return request.sourceLabel();
    }

    private static JSONObject firstObject(JSONObject... values) {
        if (values == null) return null;
        for (JSONObject value : values) {
            if (value != null) return value;
        }
        return null;
    }

    private static String firstNonEmpty(String... values) {
        if (values == null) return "";
        for (String value : values) {
            if (value != null && value.trim().length() > 0 && !"null".equalsIgnoreCase(value.trim())) {
                return value.trim();
            }
        }
        return "";
    }

    private static String normalizePayloadEncoding(String value) {
        String clean = value == null ? "" : value.trim().toLowerCase();
        if (clean.equals("base64") || clean.equals("utf8") || clean.equals("text")) return clean;
        return "hex";
    }

    private static List<String> readWarnings(JSONArray array) {
        List<String> out = new ArrayList<>();
        if (array == null) return out;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item != null) {
                out.add(firstNonEmpty(item.optString("message", ""), item.optString("code", ""), item.toString()));
            } else {
                out.add(array.optString(i));
            }
        }
        return out;
    }

    private static long parseTime(String value, long fallback) {
        if (value == null || value.length() == 0) return fallback;
        try {
            return java.time.Instant.parse(value).toEpochMilli();
        } catch (Exception ignored) {
            VpLog.d("PaymentIntent", "parse time failed; using fallback: " + ignored);
            return fallback;
        }
    }

    private static String normalizeStatus(String value) {
        if ("pending_user_approval".equals(value)) return STATUS_PENDING;
        return value == null || value.length() == 0 ? STATUS_PENDING : value;
    }

    private static String normalizePublicUrl(String value) {
        if (value == null) return "";
        return value.trim();
    }

    private static String stellarHorizonUrl(String value, boolean testnet) {
        String trimmed = value == null ? "" : value.trim();
        if (trimmed.length() > 0) return trimmed;
        return testnet ? "https://horizon-testnet.stellar.org" : "https://horizon.stellar.org";
    }
}
