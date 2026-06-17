package ai.agentwallet.hd;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

final class TransactionHistoryStore {
    private static final String PREFS = "agentwallet_transaction_history";
    private static final String KEY_ITEMS = "items";

    private TransactionHistoryStore() {}

    static synchronized void record(
            Context context,
            String sourceId,
            String title,
            String asset,
            String amount,
            String network,
            String to,
            String status,
            String txHash
    ) throws Exception {
        if (sourceId == null || sourceId.length() == 0) sourceId = "local:" + System.currentTimeMillis();
        JSONArray items = readArray(context);
        JSONArray next = new JSONArray();
        boolean replaced = false;
        JSONObject entry = new JSONObject()
                .put("source_id", sourceId)
                .put("title", title == null ? "Transfer" : title)
                .put("asset", asset == null ? "" : asset)
                .put("amount", amount == null ? "" : amount)
                .put("network", network == null ? "" : network)
                .put("to", to == null ? "" : to)
                .put("status", status == null ? "" : status)
                .put("tx_hash", txHash == null ? "" : txHash)
                .put("created_at_ms", System.currentTimeMillis());
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.getJSONObject(i);
            if (sourceId.equals(item.optString("source_id", ""))) {
                next.put(entry);
                replaced = true;
            } else {
                next.put(item);
            }
        }
        if (!replaced) next.put(entry);
        prefs(context).edit().putString(KEY_ITEMS, next.toString()).apply();
    }

    static synchronized List<JSONObject> list(Context context) throws Exception {
        JSONArray items = readArray(context);
        List<JSONObject> out = new ArrayList<>();
        for (int i = 0; i < items.length(); i++) out.add(items.getJSONObject(i));
        Collections.sort(out, (a, b) -> Long.compare(b.optLong("created_at_ms", 0L), a.optLong("created_at_ms", 0L)));
        return out;
    }

    private static JSONArray readArray(Context context) throws Exception {
        return new JSONArray(prefs(context).getString(KEY_ITEMS, "[]"));
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
