package ai.agentwallet.hd;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

final class PaymentRequest {
    static final String PROTOCOL_PAYMENT_REQUEST = "velarum.payment_request.v1";
    static final String PROTOCOL_LEGACY_INTENT = "agentwallet.payment_intent.v1";

    static final String STATUS_PENDING = "pending";
    static final String STATUS_SIGNED = "signed";
    static final String STATUS_BROADCASTED = "broadcasted";
    static final String STATUS_CONFIRMED = "confirmed";
    static final String STATUS_FAILED = "failed";
    static final String STATUS_EXPIRED = "expired";
    static final String STATUS_REJECTED = "rejected";

    final JSONObject raw;
    final String protocol;
    final boolean standard;
    final String id;
    final String requestId;
    final String legacyIntentId;
    final String connectionId;
    final String transactionId;
    final String status;
    final String reviewState;
    final String statusLabel;
    final String inboxGroup;
    final long createdAt;
    final long expiresAt;
    final String sourceType;
    final String sourceAgentId;
    final String sourceAgentName;
    final String sourceRuntime;
    final String sourceChannel;
    final String sourceDeviceId;
    final String sourceDeviceLabel;
    final String payeeName;
    final String payeeDomain;
    final boolean payeeVerified;
    final String rail;
    final String network;
    final long chainId;
    final String asset;
    final String assetIssuer;
    final String tokenContract;
    final int decimals;
    final String amount;
    final String recipient;
    final String memo;
    final String rpcUrl;
    final String horizonUrl;
    final boolean stellarTestnet;
    final String estimatedFee;
    final String total;
    final String idempotencyKey;
    final String txHash;
    final String error;
    final String displayTitle;
    final String displaySummary;
    final String displayButton;
    final String riskLevel;
    final String riskLabel;
    final String riskReviewStatus;
    final boolean signingAllowed;
    final String contextStatus;
    final String contextTransactionId;
    final String contextSnapshotHash;
    final boolean contextHasSnapshot;
    final boolean contextMissing;
    final JSONObject source;
    final JSONObject payee;
    final JSONObject payment;
    final JSONObject paymentFacts;
    final JSONObject display;
    final JSONObject metadata;
    final JSONObject risk;
    final JSONObject statusProjection;
    final JSONObject transactionContextRef;
    final JSONObject transactionContextSnapshot;
    final JSONObject context;
    final JSONArray truthFields;
    final JSONArray evidence;
    final JSONArray missingContext;
    final JSONArray riskFindings;
    final List<String> warnings;

    private PaymentRequest(JSONObject input) {
        raw = unwrap(input);
        protocol = firstNonEmpty(raw.optString("protocol", ""), looksStandard(raw) ? PROTOCOL_PAYMENT_REQUEST : PROTOCOL_LEGACY_INTENT);
        standard = PROTOCOL_PAYMENT_REQUEST.equals(protocol) || looksStandard(raw);

        source = object(raw, "source");
        payee = object(raw, "payee");
        payment = object(raw, "payment");
        paymentFacts = object(raw, "payment_facts");
        display = object(raw, "display");
        metadata = object(raw, "metadata");
        risk = object(raw, "risk");
        statusProjection = object(raw, "status_projection");
        transactionContextRef = object(raw, "transaction_context_ref");
        transactionContextSnapshot = object(raw, "transaction_context_snapshot");
        context = object(raw, "context");

        JSONObject velarum = object(raw, "velarum");
        JSONObject legacyMerchant = firstObject(raw.optJSONObject("merchant"), object(velarum.optJSONObject("payload"), "merchant"));
        JSONObject legacyRecipient = firstObject(raw.optJSONObject("recipient"), object(velarum.optJSONObject("payload"), "recipient"));

        legacyIntentId = firstNonEmpty(raw.optString("intent_id", ""), raw.optString("id", ""));
        requestId = firstNonEmpty(raw.optString("request_id", ""), velarum.optString("request_id", ""), legacyIntentId);
        id = firstNonEmpty(requestId, legacyIntentId, raw.optString("id", ""));
        connectionId = raw.optString("connection_id", "");
        transactionId = raw.optString("transaction_id", "");
        status = normalizeLifecycleStatus(firstNonEmpty(
                raw.optString("status", ""),
                statusProjection.optString("lifecycle_status", ""),
                STATUS_PENDING
        ));
        createdAt = parseTime(raw.optString("created_at", ""), raw.optLong("created_at_ms", System.currentTimeMillis()));
        expiresAt = parseTime(raw.optString("expires_at", ""), raw.optLong("expires_at_ms", System.currentTimeMillis() + 300_000L));

        sourceType = firstNonEmpty(source.optString("type", ""), source.optString("runtime", ""), standard ? "agent" : "openclaw");
        sourceAgentId = source.optString("agent_id", "");
        sourceAgentName = firstNonEmpty(source.optString("agent_name", ""), source.optString("name", ""));
        sourceRuntime = firstNonEmpty(source.optString("runtime", ""), sourceType);
        sourceChannel = firstNonEmpty(source.optString("channel", ""), source.optString("source", ""), standard ? "" : "telegram");
        sourceDeviceId = firstNonEmpty(source.optString("device_id", ""), sourceAgentId);
        sourceDeviceLabel = firstNonEmpty(source.optString("device_label", ""), source.optString("label", ""));

        Object factsPayeeValue = paymentFacts.opt("payee");
        JSONObject factsPayee = factsPayeeValue instanceof JSONObject ? (JSONObject) factsPayeeValue : new JSONObject();
        payeeName = firstNonEmpty(
                payee.optString("name", ""),
                factsPayee.optString("name", ""),
                legacyMerchant.optString("name", ""),
                legacyRecipient.optString("name", ""),
                payment.optString("payee_name", "")
        );
        payeeDomain = firstNonEmpty(payee.optString("domain", ""), legacyMerchant.optString("website", ""));
        payeeVerified = payee.optBoolean("verified", false);

        network = firstNonEmpty(payment.optString("network", ""), paymentFacts.optString("network", ""));
        asset = firstNonEmpty(payment.optString("asset", ""), paymentFacts.optString("token", ""));
        tokenContract = firstNonEmpty(
                payment.optString("token_contract", ""),
                payment.optString("contract", ""),
                payment.optString("contract_address", "")
        );
        rail = normalizeRail(firstNonEmpty(payment.optString("rail", ""), inferRail(network, asset, tokenContract)));
        chainId = payment.optLong("chain_id", "base_mainnet".equals(network) ? 8453L : 0L);
        assetIssuer = firstNonEmpty(
                payment.optString("asset_issuer", ""),
                payment.optString("issuer", ""),
                payment.optString("token_issuer", ""),
                tokenContract.startsWith("G") ? tokenContract : ""
        );
        decimals = payment.has("decimals") ? payment.optInt("decimals") : (asset.equalsIgnoreCase("USDC") ? 6 : 7);
        amount = firstNonEmpty(payment.optString("amount", ""), paymentFacts.optString("amount", ""));
        recipient = firstNonEmpty(payment.optString("to", ""), payment.optString("recipient", ""), paymentFacts.optString("recipient", ""));
        memo = payment.optString("memo", "");
        rpcUrl = payment.optString("rpc_url", "");
        stellarTestnet = payment.optBoolean("stellar_testnet", network.toLowerCase().contains("test"));
        horizonUrl = stellarHorizonUrl(payment.optString("horizon_url", ""), stellarTestnet);
        estimatedFee = firstNonEmpty(
                payment.optString("estimated_fee", ""),
                payment.optString("fee", ""),
                paymentFacts.optString("fee", ""),
                risk.optString("estimated_fee", ""),
                risk.optString("estimated_gas", "")
        );
        total = firstNonEmpty(
                payment.optString("total", ""),
                paymentFacts.optString("total", ""),
                addDecimalStringsIfPossible(amount, estimatedFee),
                amount
        );
        idempotencyKey = raw.optString("idempotency_key", "");
        txHash = raw.optString("tx_hash", "");
        error = raw.optString("error", "");

        displayTitle = display.optString("title", "");
        displaySummary = display.optString("summary", "");
        displayButton = firstNonEmpty(display.optString("primary_action", ""), display.optString("button", ""));

        contextTransactionId = firstNonEmpty(
                context.optString("transaction_id", ""),
                transactionContextRef.optString("transaction_id", ""),
                transactionContextSnapshot.optString("transaction_id", ""),
                transactionId
        );
        contextSnapshotHash = firstNonEmpty(
                context.optString("snapshot_hash", ""),
                transactionContextRef.optString("snapshot_hash", ""),
                transactionContextSnapshot.optString("snapshot_hash", "")
        );
        contextHasSnapshot = context.optBoolean("has_snapshot", transactionContextSnapshot.length() > 0);
        contextStatus = firstNonEmpty(
                context.optString("status", ""),
                transactionContextRef.optString("status", ""),
                contextHasSnapshot ? "ready" : "",
                contextTransactionId.length() > 0 ? "missing" : "missing"
        );

        truthFields = firstArray(transactionContextSnapshot.optJSONArray("truth_fields"), context.optJSONArray("truth_fields"));
        evidence = firstArray(transactionContextSnapshot.optJSONArray("evidence"), context.optJSONArray("evidence"));
        missingContext = firstArray(transactionContextSnapshot.optJSONArray("missing_context"), context.optJSONArray("missing_context"));
        riskFindings = firstArray(transactionContextSnapshot.optJSONArray("risk_findings"), context.optJSONArray("risk_findings"));

        JSONArray errors = optArray(risk, "errors");
        JSONArray warningItems = optArray(risk, "warnings");
        contextMissing = "missing".equals(contextStatus) || hasCode(warningItems, "context_missing");
        riskLevel = firstNonEmpty(risk.optString("level", ""), errors.length() > 0 ? "danger" : warningItems.length() > 0 || contextMissing ? "caution" : "safe");
        riskReviewStatus = firstNonEmpty(
                risk.optString("review_status", ""),
                contextMissing ? "missing_context" : errors.length() > 0 ? "blocked" : warningItems.length() > 0 ? "needs_review" : "ready"
        );
        reviewState = firstNonEmpty(statusProjection.optString("review_state", ""), deriveReviewState(status, riskReviewStatus, errors.length(), contextMissing));
        statusLabel = firstNonEmpty(statusProjection.optString("label", ""), labelForReviewState(reviewState));
        inboxGroup = firstNonEmpty(statusProjection.optString("inbox_group", ""), isFinalReviewState(reviewState) ? "final" : "pending");
        signingAllowed = risk.has("signing_allowed")
                ? risk.optBoolean("signing_allowed")
                : STATUS_PENDING.equals(status) && errors.length() == 0 && !contextMissing;
        riskLabel = firstNonEmpty(risk.optString("label", ""), risk.optString("summary", ""), labelForRisk(riskLevel, riskReviewStatus));
        warnings = readWarnings(warningItems);
    }

    static PaymentRequest parse(JSONObject raw) {
        return new PaymentRequest(raw);
    }

    static PaymentRequest parse(String raw) throws Exception {
        return parse(new JSONObject(raw));
    }

    JSONObject toJson() {
        return raw;
    }

    boolean isExpired() {
        return System.currentTimeMillis() > expiresAt;
    }

    boolean isBaseUsdc() {
        return ("base_usdc".equals(rail) || "evm_erc20".equals(rail))
                && "base_mainnet".equals(network)
                && chainId == 8453L
                && asset.equalsIgnoreCase("USDC");
    }

    boolean isStellarXlm() {
        return "stellar_xlm".equals(rail) && asset.equalsIgnoreCase("XLM");
    }

    boolean isStellarAsset() {
        return ("stellar_asset".equals(rail) || network.toLowerCase().contains("stellar"))
                && !asset.equalsIgnoreCase("XLM");
    }

    String title() {
        if (displayTitle.length() > 0) return displayTitle;
        if (isBaseUsdc()) return "Send " + amount + " USDC";
        if (isStellarXlm()) return "Send " + amount + " XLM";
        if (isStellarAsset()) return "Send " + amount + " " + asset;
        return "Payment Request";
    }

    String summary() {
        if (displaySummary.length() > 0) return displaySummary;
        if (payeeName.length() > 0) return "Requested payment to " + payeeName;
        return sourceLabel();
    }

    String payButtonLabel() {
        if (displayButton.length() > 0) return displayButton;
        return "Pay";
    }

    String sourceLabel() {
        String actor = firstNonEmpty(sourceAgentName, sourceDeviceLabel, sourceDeviceId, "Agent");
        String channel = firstNonEmpty(sourceChannel, sourceRuntime, "unknown");
        return "Requested by " + actor + " via " + channel;
    }

    private static JSONObject unwrap(JSONObject input) {
        if (input == null) return new JSONObject();
        JSONObject paymentRequest = input.optJSONObject("payment_request");
        if (paymentRequest != null) return paymentRequest;
        JSONObject intent = input.optJSONObject("intent");
        if (intent != null) return intent;
        return input;
    }

    private static boolean looksStandard(JSONObject value) {
        return value != null && (value.has("request_id") || value.has("payment_facts") || value.has("status_projection"));
    }

    private static JSONObject object(JSONObject parent, String key) {
        if (parent == null) return new JSONObject();
        JSONObject value = parent.optJSONObject(key);
        return value == null ? new JSONObject() : value;
    }

    private static JSONObject firstObject(JSONObject a, JSONObject b) {
        if (a != null) return a;
        return b == null ? new JSONObject() : b;
    }

    private static JSONArray optArray(JSONObject parent, String key) {
        if (parent == null) return new JSONArray();
        JSONArray value = parent.optJSONArray(key);
        return value == null ? new JSONArray() : value;
    }

    private static JSONArray firstArray(JSONArray a, JSONArray b) {
        if (a != null) return a;
        return b == null ? new JSONArray() : b;
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

    private static long parseTime(String value, long fallback) {
        if (value == null || value.length() == 0) return fallback;
        try {
            if (value.matches("^\\d+$")) return Long.parseLong(value);
            return java.time.Instant.parse(value).toEpochMilli();
        } catch (Exception ignored) {
            return fallback;
        }
    }

    private static String normalizeLifecycleStatus(String value) {
        if ("pending_user_approval".equals(value) || value == null || value.length() == 0) return STATUS_PENDING;
        if ("broadcasting".equals(value)) return STATUS_BROADCASTED;
        if ("signed_locally".equals(value)) return STATUS_SIGNED;
        return value;
    }

    private static String normalizeRail(String value) {
        if ("evm_erc20".equals(value) && value.length() > 0) return value;
        return value == null ? "" : value;
    }

    private static String inferRail(String network, String asset, String tokenContract) {
        String lowerNetwork = network == null ? "" : network.toLowerCase();
        if (lowerNetwork.contains("stellar") && "XLM".equalsIgnoreCase(asset)) return "stellar_xlm";
        if (lowerNetwork.contains("stellar")) return "stellar_asset";
        if ("base_mainnet".equals(lowerNetwork) && "USDC".equalsIgnoreCase(asset)) return "base_usdc";
        if (tokenContract != null && tokenContract.startsWith("0x")) return "evm_erc20";
        return "";
    }

    private static String stellarHorizonUrl(String value, boolean testnet) {
        String trimmed = value == null ? "" : value.trim();
        if (trimmed.length() > 0) return trimmed;
        return testnet ? "https://horizon-testnet.stellar.org" : "https://horizon.stellar.org";
    }

    private static String addDecimalStringsIfPossible(String left, String right) {
        if (!decimalString(left) || !decimalString(right)) return "";
        String[] leftParts = left.split("\\.", -1);
        String[] rightParts = right.split("\\.", -1);
        String leftFraction = leftParts.length > 1 ? leftParts[1] : "";
        String rightFraction = rightParts.length > 1 ? rightParts[1] : "";
        int scale = Math.max(leftFraction.length(), rightFraction.length());
        try {
            java.math.BigInteger unit = java.math.BigInteger.TEN.pow(scale);
            java.math.BigInteger leftUnits = new java.math.BigInteger(leftParts[0]).multiply(unit)
                    .add(new java.math.BigInteger(padRight(leftFraction, scale)));
            java.math.BigInteger rightUnits = new java.math.BigInteger(rightParts[0]).multiply(unit)
                    .add(new java.math.BigInteger(padRight(rightFraction, scale)));
            java.math.BigInteger sum = leftUnits.add(rightUnits);
            String whole = sum.divide(unit).toString();
            String fraction = sum.mod(unit).toString();
            while (fraction.length() < scale) fraction = "0" + fraction;
            fraction = fraction.replaceFirst("0+$", "");
            return fraction.length() == 0 ? whole : whole + "." + fraction;
        } catch (Exception ignored) {
            return "";
        }
    }

    private static boolean decimalString(String value) {
        return value != null && value.matches("^(0|[1-9]\\d*)(\\.\\d+)?$");
    }

    private static String padRight(String value, int length) {
        StringBuilder builder = new StringBuilder(value == null ? "" : value);
        while (builder.length() < length) builder.append('0');
        if (builder.length() == 0) return "0";
        return builder.toString();
    }

    private static boolean hasCode(JSONArray items, String code) {
        if (items == null) return false;
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item != null && code.equals(item.optString("code", ""))) return true;
        }
        return false;
    }

    private static String deriveReviewState(String status, String reviewStatus, int errorCount, boolean contextMissing) {
        if (STATUS_BROADCASTED.equals(status)) return "broadcasting";
        if (STATUS_SIGNED.equals(status)) return "signed_locally";
        if (STATUS_CONFIRMED.equals(status) || STATUS_FAILED.equals(status) || STATUS_EXPIRED.equals(status) || STATUS_REJECTED.equals(status)) {
            return status;
        }
        if (errorCount > 0 || "blocked".equals(reviewStatus)) return "blocked";
        if (contextMissing || "missing_context".equals(reviewStatus)) return "missing_context";
        if ("source_review_required".equals(reviewStatus)) return "source_review_required";
        if ("needs_review".equals(reviewStatus)) return "needs_review";
        return "pending";
    }

    private static boolean isFinalReviewState(String value) {
        return STATUS_CONFIRMED.equals(value) || STATUS_FAILED.equals(value) || STATUS_EXPIRED.equals(value)
                || STATUS_REJECTED.equals(value) || "cancelled".equals(value);
    }

    private static String labelForReviewState(String value) {
        if ("missing_context".equals(value)) return "Missing context";
        if ("blocked".equals(value)) return "Risk blocked";
        if ("needs_review".equals(value)) return "Needs review";
        if ("source_review_required".equals(value)) return "Source review required";
        if ("network_disabled".equals(value)) return "Network disabled";
        if ("signed_locally".equals(value)) return "Signed locally";
        if ("broadcasting".equals(value)) return "Broadcasting";
        if (STATUS_FAILED.equals(value)) return "Failed";
        if (STATUS_EXPIRED.equals(value)) return "Expired";
        if (STATUS_REJECTED.equals(value)) return "Rejected";
        if (STATUS_CONFIRMED.equals(value)) return "Confirmed";
        return "Awaiting signature";
    }

    private static String labelForRisk(String level, String reviewStatus) {
        if ("danger".equals(level) || "blocked".equals(reviewStatus)) return "Risk blocked";
        if ("missing_context".equals(reviewStatus)) return "Missing context";
        if ("source_review_required".equals(reviewStatus)) return "Source review";
        if ("needs_review".equals(reviewStatus) || "caution".equals(level)) return "Needs review";
        return "Low risk";
    }

    private static List<String> readWarnings(JSONArray array) {
        List<String> out = new ArrayList<>();
        if (array == null) return out;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item != null) {
                out.add(firstNonEmpty(item.optString("message", ""), item.optString("code", ""), item.toString()));
            } else {
                String value = array.optString(i, "");
                if (value.length() > 0) out.add(value);
            }
        }
        return out;
    }
}
