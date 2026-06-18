package ai.agentwallet.hd;

import org.json.JSONObject;

final class WalletNetworkConfig {
    static final String FAMILY_EVM = "evm";
    static final String SOURCE_BUILT_IN = "built_in";
    static final String SOURCE_USER = "user_added";
    static final String SOURCE_PAYMENT_REQUEST = "payment_request";
    static final String STATUS_VERIFIED = "verified";

    final String id;
    final String family;
    final String name;
    final String rpcUrl;
    final long chainId;
    final String currencySymbol;
    final String blockExplorerUrl;
    final String source;
    final String verificationStatus;
    final long verifiedAtMs;

    WalletNetworkConfig(
            String family,
            String name,
            String rpcUrl,
            long chainId,
            String currencySymbol,
            String blockExplorerUrl,
            String source,
            String verificationStatus,
            long verifiedAtMs
    ) {
        this.id = FAMILY_EVM.equals(family) && chainId > 0 ? "eip155:" + chainId : slug(name);
        this.family = clean(family);
        this.name = clean(name);
        this.rpcUrl = clean(rpcUrl);
        this.chainId = chainId;
        this.currencySymbol = clean(currencySymbol).toUpperCase();
        this.blockExplorerUrl = clean(blockExplorerUrl);
        this.source = clean(source);
        this.verificationStatus = clean(verificationStatus);
        this.verifiedAtMs = verifiedAtMs;
    }

    static WalletNetworkConfig evm(
            String name,
            String rpcUrl,
            long chainId,
            String currencySymbol,
            String blockExplorerUrl,
            String source
    ) {
        return new WalletNetworkConfig(
                FAMILY_EVM,
                name,
                rpcUrl,
                chainId,
                currencySymbol,
                blockExplorerUrl,
                source,
                STATUS_VERIFIED,
                System.currentTimeMillis()
        );
    }

    WalletNetworkConfig withSource(String value) {
        return new WalletNetworkConfig(
                family,
                name,
                rpcUrl,
                chainId,
                currencySymbol,
                blockExplorerUrl,
                value,
                verificationStatus,
                verifiedAtMs
        );
    }

    JSONObject toJson() throws Exception {
        return new JSONObject()
                .put("id", id)
                .put("family", family)
                .put("name", name)
                .put("default_rpc_url", rpcUrl)
                .put("chain_id", chainId)
                .put("currency_symbol", currencySymbol)
                .put("block_explorer_url", blockExplorerUrl)
                .put("source", source)
                .put("verification_status", verificationStatus)
                .put("verified_at_ms", verifiedAtMs);
    }

    static WalletNetworkConfig fromJson(JSONObject value) {
        return new WalletNetworkConfig(
                value.optString("family", FAMILY_EVM),
                value.optString("name", ""),
                value.optString("default_rpc_url", value.optString("rpc_url", "")),
                value.optLong("chain_id", 0L),
                value.optString("currency_symbol", ""),
                value.optString("block_explorer_url", ""),
                value.optString("source", SOURCE_USER),
                value.optString("verification_status", STATUS_VERIFIED),
                value.optLong("verified_at_ms", 0L)
        );
    }

    boolean matches(String network, long requestedChainId) {
        if (requestedChainId > 0 && chainId == requestedChainId) return true;
        String target = slug(network);
        if (target.length() == 0) return false;
        String mine = slug(name);
        return mine.equals(target) || mine.contains(target) || target.contains(mine);
    }

    String displayLine() {
        String idLine = chainId > 0 ? "Chain ID " + chainId : "No chain ID";
        return currencySymbol.length() == 0 ? idLine : idLine + " / " + currencySymbol;
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    private static String slug(String value) {
        return clean(value).toLowerCase(java.util.Locale.US)
                .replace("-", "_")
                .replace(" ", "_")
                .replace(".", "_");
    }
}
