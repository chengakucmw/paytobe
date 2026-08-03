package ai.agentwallet.hd;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.Map;

public final class VelarumFirebaseMessagingService extends FirebaseMessagingService {
    private static final String SECURITY_METRICS_PREFS = "velarumpay_security_metrics";
    private static final Object SECURITY_METRIC_LOCK = new Object();

    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        FirebaseBootstrap.registerTokenWithRelay(getApplicationContext(), token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        super.onMessageReceived(message);
        PushHintDecision decision = evaluateData(message.getData());
        if (decision.ignoredFields) recordSecurityMetric("fcm_non_hint_fields_ignored_total");
        if (decision.malformedCoordinates) recordSecurityMetric("fcm_malformed_coordinates_ignored_total");
        if (!decision.syncRequired) return;
        // Coordinates are deliberately not used to build a Payment Request or status.
        // They can only wake the authenticated REST compensation path.
        synchronizeAndNotify();
    }

    @Override
    public void onDeletedMessages() {
        super.onDeletedMessages();
        synchronizeAndNotify();
    }

    private void synchronizeAndNotify() {
        PaymentSyncWorker.enqueue(getApplicationContext());
    }

    static PushHintDecision evaluateData(Map<String, String> data) {
        boolean ignoredFields = false;
        if (data != null) {
            for (String key : data.keySet()) {
                if (!isHintField(key)) ignoredFields = true;
            }
        }
        String type = data == null ? "" : clean(data.get("type"));
        String syncRequired = data == null ? "" : clean(data.get("sync_required"));
        boolean wake = "velarumpay.sync".equals(type) && "true".equals(syncRequired);

        String eventId = coordinate(data == null ? null : data.get("event_id"));
        String requestId = coordinate(data == null ? null : data.get("request_id"));
        String eventSeq = coordinate(data == null ? null : data.get("event_seq"));
        boolean malformed = hasValue(data, "event_id") && eventId.isEmpty()
                || hasValue(data, "request_id") && requestId.isEmpty()
                || hasValue(data, "event_seq") && !isPositiveInteger(eventSeq);
        if (!isPositiveInteger(eventSeq)) eventSeq = "";
        return new PushHintDecision(wake, ignoredFields, malformed, eventId, requestId, eventSeq);
    }

    static final class PushHintDecision {
        final boolean syncRequired;
        final boolean ignoredFields;
        final boolean malformedCoordinates;
        final String eventId;
        final String requestId;
        final String eventSeq;

        PushHintDecision(boolean syncRequired, boolean ignoredFields, boolean malformedCoordinates,
                         String eventId, String requestId, String eventSeq) {
            this.syncRequired = syncRequired;
            this.ignoredFields = ignoredFields;
            this.malformedCoordinates = malformedCoordinates;
            this.eventId = eventId;
            this.requestId = requestId;
            this.eventSeq = eventSeq;
        }
    }

    private void recordSecurityMetric(String metric) {
        synchronized (SECURITY_METRIC_LOCK) {
            SharedPreferences preferences = getApplicationContext()
                    .getSharedPreferences(SECURITY_METRICS_PREFS, Context.MODE_PRIVATE);
            long current = Math.max(0L, preferences.getLong(metric, 0L));
            preferences.edit().putLong(metric, current == Long.MAX_VALUE ? current : current + 1L).apply();
        }
        VpLog.w("VelarumFcm", "FCM payload contract violation recorded; non-hint data was ignored");
    }

    private static boolean isHintField(String key) {
        return "type".equals(key) || "sync_required".equals(key) || "event_id".equals(key)
                || "request_id".equals(key) || "event_seq".equals(key);
    }

    private static boolean hasValue(Map<String, String> data, String key) {
        return data != null && data.containsKey(key) && !clean(data.get(key)).isEmpty();
    }

    private static String coordinate(String value) {
        String clean = clean(value);
        if (clean.length() < 1 || clean.length() > 200) return "";
        for (int i = 0; i < clean.length(); i++) {
            char c = clean.charAt(i);
            if (!(c >= 'a' && c <= 'z') && !(c >= 'A' && c <= 'Z')
                    && !(c >= '0' && c <= '9') && c != '_' && c != '-' && c != '.' && c != ':') return "";
        }
        return clean;
    }

    private static boolean isPositiveInteger(String value) {
        if (value == null || value.isEmpty()) return true; // optional coordinate
        try { return Long.parseLong(value) > 0L; }
        catch (NumberFormatException ignored) { return false; }
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
