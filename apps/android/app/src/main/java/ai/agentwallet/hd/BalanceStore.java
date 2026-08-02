package ai.agentwallet.hd;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

final class BalanceStore {
    private static final String PREFS = "agentwallet_balance_store";
    private static final String KEY_BALANCES = "balances_json";

    private BalanceStore() {}

    static JSONObject cached(Context context) {
        try {
            String raw = prefs(context).getString(KEY_BALANCES, "{}");
            return new JSONObject(raw == null ? "{}" : raw);
        } catch (Exception ignored) {
            VpLog.w("BalanceStore", "cached balances read failed; returning empty", ignored);
            return new JSONObject();
        }
    }

    static void save(Context context, JSONObject balances) {
        prefs(context).edit().putString(KEY_BALANCES, balances.toString()).apply();
    }

    static void clear(Context context) {
        prefs(context).edit().clear().apply();
    }

    static String updatedAt(JSONObject balances) {
        return balances.optString("updated_at", "Not refreshed");
    }

    static JSONObject asset(JSONObject balances, String key) {
        JSONObject assets = balances.optJSONObject("assets");
        if (assets == null) return new JSONObject();
        JSONObject asset = assets.optJSONObject(key);
        return asset == null ? new JSONObject() : asset;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
