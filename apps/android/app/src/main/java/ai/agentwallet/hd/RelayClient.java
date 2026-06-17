package ai.agentwallet.hd;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

final class RelayClient {
    interface Listener {
        void onConnected();
        void onIntent(PaymentIntent intent);
        void onMessage(String message);
        void onFailure(String message);
    }

    private static final OkHttpClient HTTP = new OkHttpClient();
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private WebSocket socket;

    void connect(Context context, Listener listener) {
        String base = PaymentInboxStore.relayUrl(context);
        String deviceId = PaymentInboxStore.deviceId(context);
        String token = PaymentInboxStore.deviceToken(context);
        String wsBase = base.startsWith("https://")
                ? "wss://" + base.substring("https://".length())
                : "ws://" + base.replaceFirst("^http://", "");
        Request request = new Request.Builder()
                .url(wsBase + "/v1/ws/app?device_id=" + urlEncode(deviceId) + "&token=" + urlEncode(token))
                .build();
        socket = HTTP.newWebSocket(request, new WebSocketListener() {
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
                    listener.onFailure(e.getMessage());
                }
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                listener.onFailure(t.getMessage());
            }
        });
    }

    void close() {
        if (socket != null) socket.close(1000, "closed");
    }

    static void register(Context context) throws Exception {
        JSONObject body = new JSONObject()
                .put("device_id", PaymentInboxStore.deviceId(context))
                .put("token", PaymentInboxStore.deviceToken(context));
        post(context, "/v1/devices/app", body);
    }

    static JSONObject createDemoSession(Context context, String label, String telegramBot, String stellarAddress, String evmAddress) throws Exception {
        JSONObject body = new JSONObject()
                .put("device_id", PaymentInboxStore.deviceId(context))
                .put("token", PaymentInboxStore.deviceToken(context))
                .put("label", label)
                .put("telegram_bot", telegramBot)
                .put("stellar_address", stellarAddress)
                .put("evm_address", evmAddress);
        JSONObject response = post(context, "/v1/demo/sessions", body);
        JSONObject session = response.getJSONObject("session");
        PaymentInboxStore.setDemoSessionId(context, session.optString("session_id", ""));
        PaymentInboxStore.setTelegramBot(context, telegramBot);
        return session;
    }

    static List<PaymentIntent> sync(Context context) throws Exception {
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

    private static List<PaymentIntent> syncPaymentRequests(Context context) throws Exception {
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
            JSONObject json = get(context, "/v1/payment-requests/" + urlEncode(id) + deviceQuery(context));
            return PaymentRequest.parse(json.getJSONObject("payment_request"));
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
        PaymentRequest updated = PaymentRequest.parse(response.getJSONObject("payment_request"));
        PaymentInboxStore.upsert(context, updated);
        return updated;
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
                .put("token", PaymentInboxStore.deviceToken(context))
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
                .put("token", PaymentInboxStore.deviceToken(context))
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
                .put("token", PaymentInboxStore.deviceToken(context))
                .put("pairing_code", session.pairingCode);
        post(context, "/v1/pairing/sessions/" + urlEncode(session.pairingSessionId) + "/reject", body);
    }

    static List<AgentConnection> syncConnections(Context context) throws Exception {
        String path = "/v1/connections?device_id=" + urlEncode(PaymentInboxStore.deviceId(context))
                + "&token=" + urlEncode(PaymentInboxStore.deviceToken(context));
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
                .put("token", PaymentInboxStore.deviceToken(context))
                .put("status", status);
        JSONObject response = patch(context, "/v1/connections/" + urlEncode(connection.connectionId), body);
        AgentConnection updated = AgentConnection.parse(response.getJSONObject("connection"));
        AgentConnectionStore.upsert(context, updated);
        return updated;
    }

    static AgentConnection revokeConnection(Context context, AgentConnection connection) throws Exception {
        JSONObject body = new JSONObject()
                .put("device_id", PaymentInboxStore.deviceId(context))
                .put("token", PaymentInboxStore.deviceToken(context));
        JSONObject response = delete(context, "/v1/connections/" + urlEncode(connection.connectionId), body);
        AgentConnection updated = AgentConnection.parse(response.getJSONObject("connection"));
        AgentConnectionStore.upsert(context, updated);
        return updated;
    }

    private static JSONObject get(Context context, String path) throws Exception {
        Request request = new Request.Builder()
                .url(PaymentInboxStore.relayUrl(context) + path)
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

    private static JSONObject delete(Context context, String path, JSONObject body) throws Exception {
        return sendWithBody(context, "DELETE", path, body);
    }

    private static JSONObject sendWithBody(Context context, String method, String path, JSONObject body) throws Exception {
        RequestBody requestBody = RequestBody.create(body.toString(), JSON);
        Request.Builder builder = new Request.Builder().url(PaymentInboxStore.relayUrl(context) + path);
        if ("PATCH".equals(method)) {
            builder.patch(requestBody);
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
                + "&token=" + urlEncode(PaymentInboxStore.deviceToken(context));
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
            return value == null ? "" : value;
        }
    }

    private static final class RelayHttpException extends Exception {
        final int code;

        RelayHttpException(int code, String body) {
            super("HTTP " + code + ": " + body);
            this.code = code;
        }
    }
}
