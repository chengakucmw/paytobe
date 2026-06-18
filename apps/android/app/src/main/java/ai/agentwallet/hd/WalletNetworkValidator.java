package ai.agentwallet.hd;

import java.net.URI;

final class WalletNetworkValidator {
    private WalletNetworkValidator() {}

    static WalletNetworkConfig buildVerifiedEvmConfig(
            String name,
            String rpcUrl,
            String chainId,
            String currencySymbol,
            String blockExplorerUrl,
            String source,
            boolean allowLocalUrls
    ) {
        String cleanName = require(name, "Network name");
        String cleanRpc = require(rpcUrl, "Default RPC URL");
        String cleanSymbol = require(currencySymbol, "Currency symbol").toUpperCase(java.util.Locale.US);
        String cleanExplorer = blockExplorerUrl == null ? "" : blockExplorerUrl.trim();
        long parsedChainId = parseFlexibleChainId(require(chainId, "Chain ID"));

        if (cleanSymbol.length() > 12) throw new IllegalArgumentException("Currency symbol must be 12 characters or fewer");
        requireAllowedUrl(cleanRpc, "Default RPC URL", allowLocalUrls);
        if (cleanExplorer.length() > 0) requireAllowedUrl(cleanExplorer, "Block explorer URL", allowLocalUrls);

        return WalletNetworkConfig.evm(cleanName, cleanRpc, parsedChainId, cleanSymbol, cleanExplorer, source);
    }

    static long parseFlexibleChainId(String value) {
        String clean = require(value, "Chain ID").toLowerCase(java.util.Locale.US);
        try {
            long out = clean.startsWith("0x") ? Long.parseLong(clean.substring(2), 16) : Long.parseLong(clean);
            if (out <= 0L) throw new IllegalArgumentException("Chain ID must be greater than 0");
            return out;
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("Chain ID must be a decimal number or 0x-prefixed hex value");
        }
    }

    static long parseRpcChainId(String value) {
        String clean = require(value, "RPC chain ID");
        if (!clean.toLowerCase(java.util.Locale.US).startsWith("0x")) {
            throw new IllegalArgumentException("RPC returned an invalid chain ID");
        }
        return parseFlexibleChainId(clean);
    }

    static boolean matchesRpcChainId(String rpcChainId, long expectedChainId) {
        return parseRpcChainId(rpcChainId) == expectedChainId;
    }

    static String fingerprint(String name, String rpcUrl, String chainId, String currencySymbol, String blockExplorerUrl) {
        return require(name, "Network name") + "|"
                + require(rpcUrl, "Default RPC URL") + "|"
                + parseFlexibleChainId(require(chainId, "Chain ID")) + "|"
                + require(currencySymbol, "Currency symbol").toUpperCase(java.util.Locale.US) + "|"
                + (blockExplorerUrl == null ? "" : blockExplorerUrl.trim());
    }

    private static void requireAllowedUrl(String value, String label, boolean allowLocalUrls) {
        try {
            URI uri = URI.create(value.trim());
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(java.util.Locale.US);
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(java.util.Locale.US);
            if ("https".equals(scheme)) return;
            if (allowLocalUrls && "http".equals(scheme) && isLocalHost(host)) return;
            throw new IllegalArgumentException(label + " must use https");
        } catch (IllegalArgumentException e) {
            if (e.getMessage() != null && e.getMessage().contains("must use https")) throw e;
            throw new IllegalArgumentException(label + " is not a valid URL");
        }
    }

    private static boolean isLocalHost(String host) {
        return "localhost".equals(host)
                || "127.0.0.1".equals(host)
                || "10.0.2.2".equals(host)
                || "::1".equals(host);
    }

    private static String require(String value, String label) {
        String clean = value == null ? "" : value.trim();
        if (clean.length() == 0) throw new IllegalArgumentException(label + " is required");
        return clean;
    }
}
