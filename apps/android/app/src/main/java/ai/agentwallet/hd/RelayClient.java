package ai.agentwallet.hd;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

public final class RelayClient {
    interface Listener {
        void onConnected();
        void onIntent(PaymentIntent intent);
        void onMessage(String message);
        void onFailure(String message);
    }

    private static final OkHttpClient HTTP = WalletHttp.oneShot();
    private static final OkHttpClient WS_HTTP = WalletHttp.webSocket();
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final Object REST_SYNC_LOCK = new Object();
    private static final String REST_SYNC_PREFS = "velarumpay_rest_sync_state";
    private WebSocket socket;

    void connect(Context context, Listener listener) {
        String base;
        try {
            base = relayBase(context);
        } catch (Exception e) {
            listener.onFailure(e.getMessage());
            return;
        }
        String deviceId = PaymentInboxStore.deviceId(context);
        String token;
        try {
            token = SecureWalletStore.deviceToken(context);
        } catch (Exception e) {
            listener.onFailure("Secure app credentials are unavailable; reconnect required.");
            return;
        }
        String wsBase = base.startsWith("https://")
                ? "wss://" + base.substring("https://".length())
                : "ws://" + base.replaceFirst("^http://", "");
        Request request = new Request.Builder()
                .url(wsBase + "/v1/ws/app?device_id=" + urlEncode(deviceId) + "&token=" + urlEncode(token))
                .build();
        socket = WS_HTTP.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                listener.onConnected();
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                try {
                    JSONObject json = new JSONObject(text);
                    String type = json.optString("type", "");
                    if (isPaymentRequestEvent(type)) {
                        String id = firstNonEmpty(
                                json.optString("request_id", ""),
                                json.optString("intent_id", ""),
                                json.optString("id", "")
                        );
                        if (id.length() == 0) {
                            listener.onMessage(text);
                            return;
                        }
                        PaymentIntent intent = fetchIntent(context, id);
                        PaymentInboxStore.upsert(context, intent);
                        listener.onIntent(intent);
                    } else {
                        listener.onMessage(text);
                    }
                } catch (Exception e) {
                    listener.onFailure("Payment synchronization failed.");
                }
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                // OkHttp transport errors can include the complete request URL, whose
                // legacy websocket query contains the device bearer token.
                listener.onFailure("Platform connection failed.");
            }
        });
    }

    void close() {
        if (socket != null) socket.close(1000, "closed");
    }

    static void register(Context context) throws Exception {
        JSONObject body = new JSONObject()
                .put("device_id", PaymentInboxStore.deviceId(context))
                .put("token", SecureWalletStore.deviceToken(context));
        post(context, "/v1/devices/app", body);
    }

    static void registerPushToken(Context context, String pushToken) throws Exception {
        register(context);
        JSONObject body = new JSONObject()
                .put("device_id", PaymentInboxStore.deviceId(context))
                .put("token", SecureWalletStore.deviceToken(context))
                .put("provider", "fcm")
                .put("push_token", pushToken);
        put(context, "/v1/devices/app/" + urlEncode(PaymentInboxStore.deviceId(context)) + "/push-token", body);
    }

    static ConnectInvitation createConnectInvitation(Context context) throws Exception {
        // Registration is idempotent and ensures a newly installed app can create a key
        // without requiring a separate developer action first.
        register(context);
        JSONObject body = new JSONObject()
                .put("device_id", PaymentInboxStore.deviceId(context))
                .put("token", SecureWalletStore.deviceToken(context))
                .put("expires_in_seconds", 300);
        return ConnectInvitation.parse(post(context, "/v1/connect-invitations", body), "");
    }

    static ConnectInvitation fetchConnectInvitation(Context context, String invitationId, String connectKey) throws Exception {
        JSONObject response = get(context, "/v1/connect-invitations/" + urlEncode(invitationId) + deviceQuery(context));
        return ConnectInvitation.parse(response, connectKey);
    }

    static ConnectInvitation cancelConnectInvitation(Context context, String invitationId, String connectKey) throws Exception {
        JSONObject body = new JSONObject()
                .put("device_id", PaymentInboxStore.deviceId(context))
                .put("token", SecureWalletStore.deviceToken(context));
        return ConnectInvitation.parse(delete(context, "/v1/connect-invitations/" + urlEncode(invitationId), body), connectKey);
    }

    public static ConnectReview fetchConnectReview(Context context, String invitationId) throws Exception {
        JSONObject response = getAuthenticated(context, "/v1/connect-invitations/" + urlEncode(invitationId));
        return new ConnectReview(ConnectInvitation.parse(response, ""));
    }

    public static ConnectReview approveConnectInvitation(Context context, String invitationId) throws Exception {
        JSONObject body = new JSONObject()
                .put("device_id", PaymentInboxStore.deviceId(context))
                .put("token", SecureWalletStore.deviceToken(context));
        return new ConnectReview(ConnectInvitation.parse(
                post(context, "/v1/connect-invitations/" + urlEncode(invitationId) + "/approve", body), ""));
    }

    public static ConnectReview rejectConnectInvitation(Context context, String invitationId) throws Exception {
        JSONObject body = new JSONObject()
                .put("device_id", PaymentInboxStore.deviceId(context))
                .put("token", SecureWalletStore.deviceToken(context));
        return new ConnectReview(ConnectInvitation.parse(
                post(context, "/v1/connect-invitations/" + urlEncode(invitationId) + "/reject", body), ""));
    }

    public static final class ConnectReview {
        public final String status;
        public final String state;
        public final boolean approvalAllowed;
        public final String reasonCode;
        public final String merchantId;
        public final String merchantName;
        public final String merchantStatus;
        public final String merchantVerificationState;
        public final String verifiedDomain;
        public final String agentId;
        public final String agentName;
        public final String agentStatus;
        public final String runtime;
        public final String credentialId;
        public final String credentialStatus;
        public final String credentialExpiresAt;
        public final String expiresAt;
        public final List<String> requestedScopes;
        public final boolean approvableNow;

        private ConnectReview(ConnectInvitation invitation) {
            status = invitation.status;
            state = invitation.reviewState;
            approvalAllowed = invitation.approvalAllowed;
            reasonCode = invitation.reviewReasonCode;
            merchantId = invitation.merchantId;
            merchantName = invitation.merchantName;
            merchantStatus = invitation.merchantStatus;
            merchantVerificationState = invitation.merchantVerificationState;
            verifiedDomain = invitation.verifiedDomain;
            agentId = invitation.agentId;
            agentName = invitation.agentName;
            agentStatus = invitation.agentStatus;
            runtime = invitation.runtime;
            credentialId = invitation.credentialId;
            credentialStatus = invitation.credentialStatus;
            credentialExpiresAt = invitation.credentialExpiresAt;
            expiresAt = invitation.expiresAt;
            requestedScopes = java.util.Collections.unmodifiableList(new ArrayList<>(invitation.requestedScopes));
            approvableNow = invitation.isApprovable(System.currentTimeMillis());
        }
    }

    static List<PaymentIntent> sync(Context context) throws Exception {
        synchronized (REST_SYNC_LOCK) {
            return syncLocked(context);
        }
    }

    private static List<PaymentIntent> syncLocked(Context context) throws Exception {
        try {
            return syncCompensatingLocked(context);
        } catch (Exception eventFailure) {
            if (!shouldFallbackFromStandard(eventFailure)) throw eventFailure;
        }
        Exception standardFailure;
        try {
            return syncPaymentRequests(context);
        } catch (Exception e) {
            standardFailure = e;
            if (!shouldFallbackFromStandard(e)) throw e;
        }
        try {
            return syncPaymentIntents(context);
        } catch (Exception legacyFailure) {
            legacyFailure.addSuppressed(standardFailure);
            throw legacyFailure;
        }
    }

    static List<PaymentIntent> syncCompensating(Context context) throws Exception {
        synchronized (REST_SYNC_LOCK) {
            return syncCompensatingLocked(context);
        }
    }

    private static List<PaymentIntent> syncCompensatingLocked(Context context) throws Exception {
        long cursor = restEventCursor(context);
        JSONObject response = getAuthenticated(
                context,
                "/v1/payment-requests/events?since=" + cursor
        );
        RestSyncPlan plan = planRestSync(response, cursor);
        if (plan.fullRefresh) {
            List<PaymentIntent> items = syncPaymentRequests(context);
            setRestEventCursor(context, plan.latestSeq, true);
            return items;
        }

        for (String requestId : plan.requestIds) {
            PaymentRequest request = fetchRequestAuthenticated(context, requestId);
            PaymentInboxStore.upsert(context, request);
        }
        // Advance only after every authoritative request fetch and local merge has
        // succeeded. A crash or network error causes a safe replay on the next sync.
        setRestEventCursor(context, plan.latestSeq, false);
        return PaymentInboxStore.list(context);
    }

    private static List<PaymentIntent> syncPaymentRequests(Context context) throws Exception {
        // The current Worker/D1 adapter still accepts wallet credentials on this
        // list route through its legacy query contract. Event and detail reads use
        // authenticated headers; Task 087 removes this final compatibility branch.
        JSONArray array = get(context, "/v1/payment-requests" + deviceQuery(context)).getJSONArray("items");
        for (int i = 0; i < array.length(); i++) {
            PaymentInboxStore.upsert(context, PaymentRequest.parse(array.getJSONObject(i)));
        }
        return PaymentInboxStore.list(context);
    }

    private static List<PaymentIntent> syncPaymentIntents(Context context) throws Exception {
        String path = "/v1/payment-intents" + deviceQuery(context);
        JSONArray array = get(context, path).getJSONArray("items");
        for (int i = 0; i < array.length(); i++) {
            PaymentInboxStore.upsert(context, PaymentIntent.parse(array.getJSONObject(i)));
        }
        return PaymentInboxStore.list(context);
    }

    static PaymentIntent fetchIntent(Context context, String id) throws Exception {
        return PaymentIntent.parse(fetchRequest(context, id).toJson());
    }

    static PaymentRequest fetchRequest(Context context, String id) throws Exception {
        Exception standardFailure;
        try {
            JSONObject json = getAuthenticated(context, "/v1/payment-requests/" + urlEncode(id));
            // H7: do not hard-assume an outer "payment_request" wrapper. getJSONObject() throws the
            // moment the shape drifts (bare object, "intent" wrapper, renamed key), which crashed the
            // single fetch. PaymentRequest.parse() already unwraps all of those shapes gracefully.
            return PaymentRequest.parse(json);
        } catch (Exception e) {
            standardFailure = e;
            if (!shouldFallbackFromStandard(e)) throw e;
        }
        try {
            return PaymentIntent.parse(fetchLegacyIntent(context, id)).request;
        } catch (Exception legacyFailure) {
            legacyFailure.addSuppressed(standardFailure);
            throw legacyFailure;
        }
    }

    private static PaymentRequest fetchRequestAuthenticated(Context context, String id) throws Exception {
        JSONObject json = getAuthenticated(context, "/v1/payment-requests/" + urlEncode(id));
        return PaymentRequest.parse(json);
    }

    /** Pure validation for the authenticated device event projection. */
    static RestSyncPlan planRestSync(JSONObject response, long cursor) throws Exception {
        long safeCursor = Math.max(0L, cursor);
        long latest = response.has("latest_seq") ? response.optLong("latest_seq", -1L) : safeCursor;
        if (latest < 0L) throw new IllegalArgumentException("Invalid REST event cursor");
        boolean fullRefresh = safeCursor == 0L
                || response.optBoolean("reset_required", false)
                || latest < safeCursor;
        if (fullRefresh) return new RestSyncPlan(true, latest, Collections.emptyList());

        JSONArray events = response.optJSONArray("items");
        Set<String> requestIds = new LinkedHashSet<>();
        if (events != null) {
            for (int i = 0; i < events.length(); i++) {
                JSONObject event = events.optJSONObject(i);
                if (event == null) throw new IllegalArgumentException("Invalid REST event projection");
                String type = event.optString("type", "").trim();
                if (!type.startsWith("payment_request.")) {
                    throw new IllegalArgumentException("Unexpected REST event type");
                }
                long seq = event.optLong("seq", -1L);
                if (seq <= safeCursor) continue; // a repeated page is idempotent
                if (seq > latest) throw new IllegalArgumentException("REST event exceeds cursor window");
                String requestId = event.optString("request_id", "").trim();
                if (!isOpaqueCoordinate(requestId)) {
                    throw new IllegalArgumentException("Invalid REST request coordinate");
                }
                requestIds.add(requestId);
            }
        }
        return new RestSyncPlan(false, latest, new ArrayList<>(requestIds));
    }

    static final class RestSyncPlan {
        final boolean fullRefresh;
        final long latestSeq;
        final List<String> requestIds;

        RestSyncPlan(boolean fullRefresh, long latestSeq, List<String> requestIds) {
            this.fullRefresh = fullRefresh;
            this.latestSeq = latestSeq;
            this.requestIds = Collections.unmodifiableList(new ArrayList<>(requestIds));
        }
    }

    private static long restEventCursor(Context context) throws Exception {
        return Math.max(0L, context.getSharedPreferences(REST_SYNC_PREFS, Context.MODE_PRIVATE)
                .getLong(restCursorKey(context), 0L));
    }

    private static void setRestEventCursor(Context context, long cursor, boolean replace) throws Exception {
        String key = restCursorKey(context);
        android.content.SharedPreferences preferences = context.getSharedPreferences(REST_SYNC_PREFS, Context.MODE_PRIVATE);
        long next = Math.max(0L, cursor);
        if (!replace) next = Math.max(next, preferences.getLong(key, 0L));
        preferences.edit().putLong(key, next).apply();
    }

    private static String restCursorKey(Context context) throws Exception {
        String binding = PaymentInboxStore.relayUrl(context) + "\n" + PaymentInboxStore.deviceId(context);
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(binding.getBytes(StandardCharsets.UTF_8));
        StringBuilder key = new StringBuilder("cursor:");
        for (byte value : digest) key.append(String.format(java.util.Locale.US, "%02x", value & 0xff));
        return key.toString();
    }

    private static boolean isOpaqueCoordinate(String value) {
        if (value == null || value.length() < 1 || value.length() > 200) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (!(c >= 'a' && c <= 'z') && !(c >= 'A' && c <= 'Z')
                    && !(c >= '0' && c <= '9') && c != '_' && c != '-' && c != '.' && c != ':') return false;
        }
        return true;
    }

    static void updateStatus(Context context, PaymentIntent intent, String status, String txHash, String error) throws Exception {
        Exception standardFailure;
        try {
            updateRequestStatus(context, intent.request, status, txHash, error);
            return;
        } catch (Exception e) {
            standardFailure = e;
            if (!shouldFallbackFromStandard(e)) throw e;
        }
        try {
            updateLegacyStatus(context, intent, status, txHash, error);
        } catch (Exception legacyFailure) {
            legacyFailure.addSuppressed(standardFailure);
            throw legacyFailure;
        }
    }

    static PaymentRequest updateRequestStatus(Context context, PaymentRequest request, String status, String txHash, String error) throws Exception {
        String requestId = firstNonEmpty(request == null ? "" : request.requestId, request == null ? "" : request.id);
        if (requestId.length() == 0) throw new IllegalArgumentException("Missing payment request id");
        JSONObject response = post(context, "/v1/payment-requests/" + urlEncode(requestId) + "/status", statusBody(context, status, txHash, error));
        // H7: once this POST returns, the relay has already accepted the status report. The body is
        // only used to refresh the local projection, so tolerate any wrapper/shape drift instead of
        // letting a parse failure bubble up and make a successful report look like it never happened
        // ("signed but not reported"). parse() unwraps the wrapper-or-bare body; only sync locally
        // when the echoed request actually carries an id so an empty/odd body never clobbers state.
        PaymentRequest updated = PaymentRequest.parse(response);
        if (hasRequestIdentity(updated)) {
            PaymentInboxStore.upsert(context, updated);
            return updated;
        }
        return request;
    }

    private static void updateLegacyStatus(Context context, PaymentIntent intent, String status, String txHash, String error) throws Exception {
        String legacyId = firstNonEmpty(
                intent.request == null ? "" : intent.request.legacyIntentId,
                intent.raw == null ? "" : intent.raw.optString("intent_id", ""),
                intent.id
        );
        if (legacyId.length() == 0) throw new IllegalArgumentException("Missing legacy payment intent id");
        post(context, "/v1/payment-intents/" + urlEncode(legacyId) + "/status", statusBody(context, status, txHash, error));
        PaymentInboxStore.updateStatus(
                context,
                firstNonEmpty(intent.request == null ? "" : intent.request.requestId, intent.id, legacyId),
                status,
                txHash,
                error
        );
    }

    private static JSONObject fetchLegacyIntent(Context context, String id) throws Exception {
        JSONObject json = get(context, "/v1/payment-intents/" + urlEncode(id) + deviceQuery(context));
        return json.getJSONObject("intent");
    }

    private static JSONObject statusBody(Context context, String status, String txHash, String error) throws Exception {
        JSONObject body = new JSONObject()
                .put("device_id", PaymentInboxStore.deviceId(context))
                .put("token", SecureWalletStore.deviceToken(context))
                .put("status", status);
        if (txHash != null) body.put("tx_hash", txHash);
        if (error != null) body.put("error", error);
        return body;
    }

    static PairingSession fetchPairingSession(Context context, String idOrCode, String code) throws Exception {
        String path = "/v1/pairing/sessions/" + urlEncode(idOrCode);
        if (code != null && code.trim().length() > 0) path += "?code=" + urlEncode(code.trim());
        JSONObject response = get(context, path);
        return PairingSession.parse(response.getJSONObject("pairing_session"));
    }

    static AgentConnection approvePairing(Context context, PairingSession session, List<String> approvedScopes) throws Exception {
        JSONArray scopes = new JSONArray();
        for (String scope : approvedScopes) scopes.put(scope);
        JSONObject body = new JSONObject()
                .put("device_id", PaymentInboxStore.deviceId(context))
                .put("token", SecureWalletStore.deviceToken(context))
                .put("pairing_code", session.pairingCode)
                .put("approved_scopes", scopes);
        JSONObject response = post(context, "/v1/pairing/sessions/" + urlEncode(session.pairingSessionId) + "/approve", body);
        AgentConnection connection = AgentConnection.parse(response.getJSONObject("connection"));
        AgentConnectionStore.upsert(context, connection);
        return connection;
    }

    static void rejectPairing(Context context, PairingSession session) throws Exception {
        JSONObject body = new JSONObject()
                .put("device_id", PaymentInboxStore.deviceId(context))
                .put("token", SecureWalletStore.deviceToken(context))
                .put("pairing_code", session.pairingCode);
        post(context, "/v1/pairing/sessions/" + urlEncode(session.pairingSessionId) + "/reject", body);
    }

    static List<AgentConnection> syncConnections(Context context) throws Exception {
        String path = "/v1/connections?device_id=" + urlEncode(PaymentInboxStore.deviceId(context))
                + "&token=" + urlEncode(SecureWalletStore.deviceToken(context));
        JSONArray items = get(context, path).getJSONArray("items");
        List<AgentConnection> out = new ArrayList<>();
        for (int i = 0; i < items.length(); i++) {
            AgentConnection connection = AgentConnection.parse(items.getJSONObject(i));
            AgentConnectionStore.upsert(context, connection);
            out.add(connection);
        }
        return out;
    }

    static AgentConnection updateConnectionStatus(Context context, AgentConnection connection, String status) throws Exception {
        JSONObject body = new JSONObject()
                .put("device_id", PaymentInboxStore.deviceId(context))
                .put("token", SecureWalletStore.deviceToken(context))
                .put("status", status);
        JSONObject response = patch(context, "/v1/connections/" + urlEncode(connection.connectionId), body);
        AgentConnection updated = AgentConnection.parse(response.getJSONObject("connection"));
        AgentConnectionStore.upsert(context, updated);
        return updated;
    }

    static AgentConnection revokeConnection(Context context, AgentConnection connection) throws Exception {
        JSONObject body = new JSONObject()
                .put("device_id", PaymentInboxStore.deviceId(context))
                .put("token", SecureWalletStore.deviceToken(context));
        JSONObject response = delete(context, "/v1/connections/" + urlEncode(connection.connectionId), body);
        AgentConnection updated = AgentConnection.parse(response.getJSONObject("connection"));
        AgentConnectionStore.upsert(context, updated);
        return updated;
    }

    private static JSONObject get(Context context, String path) throws Exception {
        Request request = new Request.Builder()
                .url(relayBase(context) + path)
                .get()
                .build();
        try (Response response = HTTP.newCall(request).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) throw new RelayHttpException(response.code(), text);
            return new JSONObject(text);
        }
    }

    private static JSONObject getAuthenticated(Context context, String path) throws Exception {
        Request request = new Request.Builder()
                .url(relayBase(context) + path)
                .header("X-App-Device-Id", PaymentInboxStore.deviceId(context))
                .header("X-App-Device-Token", SecureWalletStore.deviceToken(context))
                .get()
                .build();
        try (Response response = HTTP.newCall(request).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) throw new RelayHttpException(response.code(), text);
            return new JSONObject(text);
        }
    }

    private static JSONObject post(Context context, String path, JSONObject body) throws Exception {
        return sendWithBody(context, "POST", path, body);
    }

    private static JSONObject patch(Context context, String path, JSONObject body) throws Exception {
        return sendWithBody(context, "PATCH", path, body);
    }

    private static JSONObject put(Context context, String path, JSONObject body) throws Exception {
        return sendWithBody(context, "PUT", path, body);
    }

    private static JSONObject delete(Context context, String path, JSONObject body) throws Exception {
        return sendWithBody(context, "DELETE", path, body);
    }

    private static JSONObject sendWithBody(Context context, String method, String path, JSONObject body) throws Exception {
        RequestBody requestBody = RequestBody.create(body.toString(), JSON);
        Request.Builder builder = new Request.Builder().url(relayBase(context) + path);
        if ("PATCH".equals(method)) {
            builder.patch(requestBody);
        } else if ("PUT".equals(method)) {
            builder.put(requestBody);
        } else if ("DELETE".equals(method)) {
            builder.delete(requestBody);
        } else {
            builder.post(requestBody);
        }
        Request request = builder.build();
        try (Response response = HTTP.newCall(request).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) throw new RelayHttpException(response.code(), text);
            return text.length() == 0 ? new JSONObject() : new JSONObject(text);
        }
    }

    private static String deviceQuery(Context context) {
        return "?device_id=" + urlEncode(PaymentInboxStore.deviceId(context))
                + "&token=" + urlEncode(SecureWalletStore.deviceToken(context));
    }

    private static String relayBase(Context context) {
        String base = PaymentInboxStore.relayUrl(context);
        if (base == null || base.trim().length() == 0) {
            throw new IllegalStateException("Set Relay URL first.");
        }
        base = base.trim().replaceAll("/+$", "");
        if (base.startsWith("https://")) return base;
        // M11: signed payment requests must never travel over cleartext on a hostile
        // network. Plain http:// (and therefore the ws:// it is upgraded to) is allowed
        // only for local development hosts, matching res/xml/network_security_config.xml;
        // every other relay must use https:// / wss://.
        if (base.startsWith("http://")) {
            if (isCleartextDevHost(hostOf(base))) return base;
            throw new IllegalStateException(
                    "Relay URL must use https:// - cleartext http is only allowed for local development hosts.");
        }
        throw new IllegalStateException("Relay URL must start with https:// (or http:// for a local development host).");
    }

    private static String hostOf(String base) {
        int scheme = base.indexOf("://");
        String rest = scheme >= 0 ? base.substring(scheme + 3) : base;
        int slash = rest.indexOf('/');
        if (slash >= 0) rest = rest.substring(0, slash);
        int at = rest.indexOf('@');
        if (at >= 0) rest = rest.substring(at + 1);
        if (rest.startsWith("[")) { // IPv6 literal, keep brackets, drop any :port after
            int close = rest.indexOf(']');
            return close >= 0 ? rest.substring(0, close + 1) : rest;
        }
        int colon = rest.indexOf(':');
        if (colon >= 0) rest = rest.substring(0, colon);
        return rest.toLowerCase(java.util.Locale.US);
    }

    private static boolean isCleartextDevHost(String host) {
        if (host == null || host.length() == 0) return false;
        return host.equals("localhost")
                || host.equals("127.0.0.1")
                || host.equals("10.0.2.2")   // Android emulator -> host loopback
                || host.equals("10.0.3.2");  // Genymotion emulator -> host loopback
    }

    private static boolean isPaymentRequestEvent(String type) {
        return "payment_request".equals(type)
                || "payment_intent".equals(type)
                || "payment_request_status".equals(type)
                || "payment_request.created".equals(type)
                || "payment_request.status".equals(type);
    }

    private static boolean shouldFallbackFromStandard(Exception error) {
        Throwable cursor = error;
        while (cursor != null) {
            if (cursor instanceof RelayHttpException) {
                int code = ((RelayHttpException) cursor).code;
                return code == 404 || code == 405 || code == 410 || code == 501;
            }
            cursor = cursor.getCause();
        }
        return false;
    }

    private static boolean hasRequestIdentity(PaymentRequest request) {
        if (request == null) return false;
        return firstNonEmpty(request.requestId, request.id, request.legacyIntentId).length() > 0;
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

    private static String urlEncode(String value) {
        try {
            return URLEncoder.encode(value == null ? "" : value, "UTF-8");
        } catch (Exception ignored) {
            VpLog.d("RelayClient", "url encode failed; using raw value: " + ignored);
            return value == null ? "" : value;
        }
    }

    private static final class RelayHttpException extends Exception {
        final int code;

        RelayHttpException(int code, String body) {
            // Response bodies can reflect request data. Keep bearer material out of
            // crash messages and UI error surfaces even if a relay misbehaves.
            super("Relay request failed with HTTP " + code + ".");
            this.code = code;
        }
    }
}
