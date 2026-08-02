package ai.agentwallet.hd;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

final class PaymentInboxStore {
    private static final String PREFS = "agentwallet_payment_inbox";
    private static final String KEY_INTENTS = "intents";
    private static final String KEY_DEVICE_ID = "device_id";
    private static final String KEY_RELAY_URL = "relay_url";
    private static final String KEY_DEVICE_TOKEN = "device_token";
    private static final String KEY_EVENT_CURSOR = "payment_request_event_cursor";
    private static final String KEY_EVENT_CURSOR_RELAY = "payment_request_event_cursor_relay";

    private PaymentInboxStore() {}

    static synchronized void upsert(Context context, PaymentIntent intent) throws Exception {
        upsert(context, intent.request);
    }

    static synchronized void upsert(Context context, PaymentRequest request) throws Exception {
        JSONArray array = readArray(context);
        JSONArray next = new JSONArray();
        boolean written = false;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.getJSONObject(i);
            if (matchesRequest(item, request)) {
                next.put(reconcile(item, request));
                written = true;
            } else {
                next.put(item);
            }
        }
        if (!written) next.put(request.toJson());
        prefs(context).edit().putString(KEY_INTENTS, next.toString()).apply();
    }

    /**
     * H12 parity with iOS LocalStore.upsertIntent: never let a stale or out-of-order relay
     * snapshot downgrade a locally-advanced status or perform an illegal lifecycle jump
     * (e.g. broadcasted -> pending, or pending -> confirmed skipping the signature step),
     * which could make a paid request look actionable again and risk a duplicate payment, or
     * drop a known tx hash. The richer fields from the incoming snapshot are still taken; only
     * the protected status / tx_hash are preserved when the incoming status is not a legal
     * advance. The allowed transitions live in {@link PaymentRequest#canApplyStatusUpdate}.
     */
    static JSONObject reconcile(JSONObject existingItem, PaymentRequest incoming) throws Exception {
        JSONObject existingPayload = itemPayload(existingItem);
        String existingStatus = existingPayload.optString("status", "");
        if (PaymentRequest.canApplyStatusUpdate(existingStatus, incoming.status)) {
            return incoming.toJson();
        }
        // Rejected status change: keep the fresh incoming snapshot but restore the protected
        // status and a known tx hash from local state. Deep-copy so the request's own raw
        // JSON is not mutated.
        JSONObject merged = new JSONObject(incoming.toJson().toString());
        merged.put("status", PaymentRequest.normalizeLifecycleStatus(existingStatus));
        String existingTxHash = existingPayload.optString("tx_hash", "");
        if (existingTxHash.length() > 0 && merged.optString("tx_hash", "").length() == 0) {
            merged.put("tx_hash", existingTxHash);
        }
        return merged;
    }

    static synchronized void updateStatus(Context context, String intentId, String status, String txHash, String error) throws Exception {
        JSONArray array = readArray(context);
        JSONArray next = new JSONArray();
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.getJSONObject(i);
            if (matchesAnyItemId(item, intentId)) {
                JSONObject payload = itemPayload(item);
                payload.put("status", status);
                payload.put("updated_at_ms", System.currentTimeMillis());
                if (txHash != null) payload.put("tx_hash", txHash);
                if (error != null) payload.put("error", error);
                if (item.optJSONObject("payment_request") != null) {
                    item.put("payment_request", payload);
                } else if (item.optJSONObject("intent") != null) {
                    item.put("intent", payload);
                } else {
                    item = payload;
                }
            }
            next.put(item);
        }
        prefs(context).edit().putString(KEY_INTENTS, next.toString()).apply();
    }

    static synchronized List<PaymentIntent> list(Context context) throws Exception {
        JSONArray array = readArray(context);
        List<PaymentIntent> out = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) out.add(PaymentIntent.parse(itemPayload(array.getJSONObject(i))));
        Collections.sort(out, (a, b) -> Long.compare(b.createdAt, a.createdAt));
        return out;
    }

    static synchronized List<PaymentRequest> listRequests(Context context) throws Exception {
        JSONArray array = readArray(context);
        List<PaymentRequest> out = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) out.add(PaymentRequest.parse(itemPayload(array.getJSONObject(i))));
        Collections.sort(out, (a, b) -> Long.compare(b.createdAt, a.createdAt));
        return out;
    }

    static synchronized PaymentIntent find(Context context, String intentId) throws Exception {
        if (intentId == null || intentId.length() == 0) return null;
        JSONArray array = readArray(context);
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.getJSONObject(i);
            if (matchesAnyItemId(item, intentId)) return PaymentIntent.parse(itemPayload(item));
        }
        return null;
    }

    static synchronized PaymentRequest findRequest(Context context, String requestId) throws Exception {
        if (requestId == null || requestId.length() == 0) return null;
        JSONArray array = readArray(context);
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.getJSONObject(i);
            if (matchesAnyItemId(item, requestId)) return PaymentRequest.parse(itemPayload(item));
        }
        return null;
    }

    static synchronized boolean hasCompletedIntent(Context context, PaymentIntent intent) throws Exception {
        for (PaymentIntent item : list(context)) {
            if (item.id.equals(intent.id) && !item.status.equals(PaymentIntent.STATUS_PENDING)) return true;
            if (intent.idempotencyKey.length() > 0
                    && intent.idempotencyKey.equals(item.idempotencyKey)
                    && !item.status.equals(PaymentIntent.STATUS_PENDING)) {
                return true;
            }
        }
        return false;
    }

    static String deviceId(Context context) {
        SharedPreferences p = prefs(context);
        String existing = p.getString(KEY_DEVICE_ID, "");
        if (existing != null && existing.length() > 0) return existing;
        String generated = "android-" + java.util.UUID.randomUUID().toString();
        p.edit().putString(KEY_DEVICE_ID, generated).apply();
        return generated;
    }

    static String relayUrl(Context context) {
        return PlatformServiceConfig.baseUrl(prefs(context).getString(KEY_RELAY_URL, ""));
    }

    static void setRelayUrl(Context context, String value) {
        if (PlatformServiceConfig.isManaged()) return;
        String normalized = value.replaceAll("/+$", "");
        SharedPreferences preferences = prefs(context);
        String previous = preferences.getString(KEY_RELAY_URL, "");
        SharedPreferences.Editor edit = preferences.edit().putString(KEY_RELAY_URL, normalized);
        if (!normalized.equals(previous)) {
            edit.remove(KEY_EVENT_CURSOR).remove(KEY_EVENT_CURSOR_RELAY);
        }
        edit.apply();
    }

    static String deviceToken(Context context) {
        SharedPreferences p = prefs(context);
        String existing = p.getString(KEY_DEVICE_TOKEN, "");
        if (existing != null && existing.length() > 0) return existing;
        String generated = "awt_" + java.util.UUID.randomUUID().toString().replace("-", "");
        p.edit().putString(KEY_DEVICE_TOKEN, generated).apply();
        return generated;
    }

    static long eventCursor(Context context) {
        SharedPreferences preferences = prefs(context);
        String relay = relayUrl(context);
        if (!relay.equals(preferences.getString(KEY_EVENT_CURSOR_RELAY, ""))) return 0L;
        return Math.max(0L, preferences.getLong(KEY_EVENT_CURSOR, 0L));
    }

    static void setEventCursor(Context context, long cursor) {
        prefs(context).edit()
                .putLong(KEY_EVENT_CURSOR, Math.max(0L, cursor))
                .putString(KEY_EVENT_CURSOR_RELAY, relayUrl(context))
                .apply();
    }

    private static JSONArray readArray(Context context) throws Exception {
        return new JSONArray(prefs(context).getString(KEY_INTENTS, "[]"));
    }

    private static JSONObject itemPayload(JSONObject item) {
        JSONObject paymentRequest = item.optJSONObject("payment_request");
        if (paymentRequest != null) return paymentRequest;
        JSONObject intent = item.optJSONObject("intent");
        if (intent != null) return intent;
        return item;
    }

    private static boolean matchesRequest(JSONObject item, PaymentRequest request) {
        if (request == null) return false;
        return matchesAnyItemId(item, request.id)
                || matchesAnyItemId(item, request.requestId)
                || matchesAnyItemId(item, request.legacyIntentId);
    }

    private static boolean matchesAnyItemId(JSONObject item, String id) {
        String clean = cleanId(id);
        if (clean.length() == 0) return false;
        for (String candidate : itemIds(item)) {
            if (clean.equals(cleanId(candidate))) return true;
        }
        return false;
    }

    private static String[] itemIds(JSONObject item) {
        JSONObject payload = itemPayload(item);
        JSONObject velarum = payload.optJSONObject("velarum");
        return new String[] {
                payload.optString("request_id", ""),
                payload.optString("intent_id", ""),
                payload.optString("id", ""),
                velarum == null ? "" : velarum.optString("request_id", "")
        };
    }

    private static String cleanId(String value) {
        if (value == null) return "";
        String clean = value.trim();
        return "null".equalsIgnoreCase(clean) ? "" : clean;
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

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
