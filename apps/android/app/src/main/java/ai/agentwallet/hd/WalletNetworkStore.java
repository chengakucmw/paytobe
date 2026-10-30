package ai.agentwallet.hd;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;

final class WalletNetworkStore {
    private static final String PREFS = "Paytobe_wallet_networks";
    private static final String KEY_USER_NETWORKS = "user_networks";

    private WalletNetworkStore() {}

    static List<WalletNetworkConfig> builtInEvmNetworks() {
        List<WalletNetworkConfig> networks = new ArrayList<>();
        if (BuildConfig.TESTNET_ONLY) return networks;
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
        // The remaining EVM chains in TransferAssetRegistry share the generic EvmTransfer
        // signer (secp256k1); they only lacked a built-in RPC, which is why they could not be
        // sent before. Wiring verified public RPC endpoints here makes every direct_broadcast
        // EVM chain genuinely send-ready (chain-id is what WalletNetworkConfig.matches keys on).
        networks.add(new WalletNetworkConfig(
                WalletNetworkConfig.FAMILY_EVM,
                "Arbitrum One",
                "https://arb1.arbitrum.io/rpc",
                42161L,
                "ETH",
                "https://arbiscan.io",
                WalletNetworkConfig.SOURCE_BUILT_IN,
                WalletNetworkConfig.STATUS_VERIFIED,
                0L
        ));
        networks.add(new WalletNetworkConfig(
                WalletNetworkConfig.FAMILY_EVM,
                "Optimism",
                "https://mainnet.optimism.io",
                10L,
                "ETH",
                "https://optimistic.etherscan.io",
                WalletNetworkConfig.SOURCE_BUILT_IN,
                WalletNetworkConfig.STATUS_VERIFIED,
                0L
        ));
        networks.add(new WalletNetworkConfig(
                WalletNetworkConfig.FAMILY_EVM,
                "BNB Smart Chain",
                "https://bsc-dataseed.binance.org",
                56L,
                "BNB",
                "https://bscscan.com",
                WalletNetworkConfig.SOURCE_BUILT_IN,
                WalletNetworkConfig.STATUS_VERIFIED,
                0L
        ));
        networks.add(new WalletNetworkConfig(
                WalletNetworkConfig.FAMILY_EVM,
                "Avalanche C-Chain",
                "https://api.avax.network/ext/bc/C/rpc",
                43114L,
                "AVAX",
                "https://snowtrace.io",
                WalletNetworkConfig.SOURCE_BUILT_IN,
                WalletNetworkConfig.STATUS_VERIFIED,
                0L
        ));
        networks.add(new WalletNetworkConfig(
                WalletNetworkConfig.FAMILY_EVM,
                "Cronos",
                "https://evm.cronos.org",
                25L,
                "CRO",
                "https://cronoscan.com",
                WalletNetworkConfig.SOURCE_BUILT_IN,
                WalletNetworkConfig.STATUS_VERIFIED,
                0L
        ));
        networks.add(new WalletNetworkConfig(
                WalletNetworkConfig.FAMILY_EVM,
                "Mantle",
                "https://rpc.mantle.xyz",
                5000L,
                "MNT",
                "https://explorer.mantle.xyz",
                WalletNetworkConfig.SOURCE_BUILT_IN,
                WalletNetworkConfig.STATUS_VERIFIED,
                0L
        ));
        networks.add(new WalletNetworkConfig(
                WalletNetworkConfig.FAMILY_EVM,
                "ZKsync Era",
                "https://mainnet.era.zksync.io",
                324L,
                "ETH",
                "https://explorer.zksync.io",
                WalletNetworkConfig.SOURCE_BUILT_IN,
                WalletNetworkConfig.STATUS_VERIFIED,
                0L
        ));
        networks.add(new WalletNetworkConfig(
                WalletNetworkConfig.FAMILY_EVM,
                "Linea",
                "https://rpc.linea.build",
                59144L,
                "ETH",
                "https://lineascan.build",
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
            VpLog.w("WalletNetworkStore", "read user networks failed; returning partial list", ignored);
        }
        return out;
    }

    static synchronized List<WalletNetworkConfig> all(Context context) {
        if (BuildConfig.TESTNET_ONLY) return new ArrayList<>();
        List<WalletNetworkConfig> out = builtInEvmNetworks();
        out.addAll(userAdded(context));
        return out;
    }

    static synchronized void upsert(Context context, WalletNetworkConfig network) throws Exception {
        if (BuildConfig.TESTNET_ONLY) {
            throw new IllegalStateException("Custom EVM networks are disabled in the testnet build");
        }
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
