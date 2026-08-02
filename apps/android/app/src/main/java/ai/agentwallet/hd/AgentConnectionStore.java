package ai.agentwallet.hd;

import android.content.Context;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;

final class AgentConnectionStore {
    private AgentConnectionStore() {}

    static List<AgentConnection> list(Context context) {
        List<AgentConnection> out = new ArrayList<>();
        try {
            String raw = SecureWalletStore.connectionRecords(context);
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i++) {
                out.add(AgentConnection.parse(array.getJSONObject(i)));
            }
        } catch (Exception ignored) {
            // Legacy JSON parser messages can echo the record being parsed. Never attach
            // that throwable because a damaged legacy record may still contain a token.
            VpLog.w("AgentConnectionStore", "read connections failed; reconnect may be required");
        }
        return out;
    }

    static AgentConnection find(Context context, String connectionId) {
        for (AgentConnection connection : list(context)) {
            if (connection.connectionId.equals(connectionId)) return connection;
        }
        return null;
    }

    static void upsert(Context context, AgentConnection connection) throws Exception {
        if (connection == null || connection.connectionId.length() == 0) return;
        List<AgentConnection> items = list(context);
        boolean replaced = false;
        for (int i = 0; i < items.size(); i++) {
            if (!items.get(i).connectionId.equals(connection.connectionId)) continue;
            items.set(i, connection.withTokenFrom(items.get(i)));
            replaced = true;
            break;
        }
        if (!replaced) items.add(connection);
        save(context, items);
    }

    static void updateStatus(Context context, String connectionId, String status) throws Exception {
        List<AgentConnection> items = list(context);
        for (int i = 0; i < items.size(); i++) {
            AgentConnection connection = items.get(i);
            if (connection.connectionId.equals(connectionId)) {
                items.set(i, connection.withStatus(status));
                save(context, items);
                return;
            }
        }
    }

    private static void save(Context context, List<AgentConnection> items) throws Exception {
        JSONArray array = new JSONArray();
        for (AgentConnection connection : items) {
            org.json.JSONObject item = connection.toJson();
            if (connection.isRevoked()) item.put("connection_token", "");
            array.put(item);
        }
        SecureWalletStore.saveConnectionRecords(context, array.toString());
    }

    static void clear(Context context) {
        SecureWalletStore.clearConnectionRecords(context);
    }
}
