package ai.agentwallet.hd;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;

final class AgentConnectionStore {
    private static final String PREFS = "agentwallet_agent_connections";
    private static final String KEY_CONNECTIONS = "connections";

    private AgentConnectionStore() {}

    static List<AgentConnection> list(Context context) {
        List<AgentConnection> out = new ArrayList<>();
        String raw = prefs(context).getString(KEY_CONNECTIONS, "[]");
        try {
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i++) {
                out.add(AgentConnection.parse(array.getJSONObject(i)));
            }
        } catch (Exception ignored) {
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
        for (AgentConnection connection : items) array.put(connection.toJson());
        prefs(context).edit().putString(KEY_CONNECTIONS, array.toString()).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
