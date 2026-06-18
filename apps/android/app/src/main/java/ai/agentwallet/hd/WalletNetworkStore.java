package ai.agentwallet.hd;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;

final class WalletNetworkStore {
    private static final String PREFS = "velarumpay_wallet_networks";
    private static final String KEY_USER_NETWORKS = "user_networks";

    private WalletNetworkStore() {}

    static List<WalletNetworkConfig> builtInEvmNetworks() {
        List<WalletNetworkConfig> networks = new ArrayList<>();
        networks.add(new WalletNetworkConfig(
                WalletNetworkConfig.FAMILY_EVM,
                "Ethereum",
                "https://cloudflare-eth.com",
                1L,
                "ETH",
                "https://etherscan.io",
                WalletNetworkConfig.SOURCE_BUILT_IN,
                WalletNetworkConfig.STATUS_VERIFIED,
                0L
        ));
        networks.add(new WalletNetworkConfig(
                WalletNetworkConfig.FAMILY_EVM,
                "Base",
                "https://mainnet.base.org",
                8453L,
                "ETH",
                "https://basescan.org",
                WalletNetworkConfig.SOURCE_BUILT_IN,
                WalletNetworkConfig.STATUS_VERIFIED,
                0L
        ));
        networks.add(new WalletNetworkConfig(
                WalletNetworkConfig.FAMILY_EVM,
                "Polygon",
                "https://polygon-rpc.com",
                137L,
                "MATIC",
                "https://polygonscan.com",
                WalletNetworkConfig.SOURCE_BUILT_IN,
                WalletNetworkConfig.STATUS_VERIFIED,
                0L
        ));
        return networks;
    }

    static synchronized List<WalletNetworkConfig> userAdded(Context context) {
        List<WalletNetworkConfig> out = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(prefs(context).getString(KEY_USER_NETWORKS, "[]"));
            for (int i = 0; i < array.length(); i++) {
                out.add(WalletNetworkConfig.fromJson(array.getJSONObject(i)));
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    static synchronized List<WalletNetworkConfig> all(Context context) {
        List<WalletNetworkConfig> out = builtInEvmNetworks();
        out.addAll(userAdded(context));
        return out;
    }

    static synchronized void upsert(Context context, WalletNetworkConfig network) throws Exception {
        List<WalletNetworkConfig> networks = userAdded(context);
        boolean replaced = false;
        for (int i = 0; i < networks.size(); i++) {
            if (networks.get(i).id.equals(network.id)) {
                networks.set(i, network);
                replaced = true;
                break;
            }
        }
        if (!replaced) networks.add(network);
        JSONArray array = new JSONArray();
        for (WalletNetworkConfig item : networks) array.put(item.toJson());
        prefs(context).edit().putString(KEY_USER_NETWORKS, array.toString()).apply();
    }

    static WalletNetworkConfig findEnabled(Context context, String network, long chainId) {
        for (WalletNetworkConfig item : all(context)) {
            if (item.matches(network, chainId)) return item;
        }
        return null;
    }

    static boolean isEnabled(Context context, String network, long chainId) {
        if (network != null) {
            String lower = network.toLowerCase(java.util.Locale.US);
            if (lower.contains("stellar") || lower.contains("solana")) return true;
        }
        return findEnabled(context, network, chainId) != null;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
