package ai.agentwallet.hd;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

final class TransferAssetRegistry {
    static final List<Asset> ASSETS;
    static final String MODE_DIRECT_BROADCAST = "direct_broadcast";
    static final String MODE_PREPARED_PAYLOAD = "prepared_payload";
    static final String KEY_SECP256K1 = "secp256k1";
    static final String KEY_ED25519 = "ed25519";
    static final String KEY_STARK = "stark";

    private static final Pattern TRON_ADDRESS = Pattern.compile("^T[1-9A-HJ-NP-Za-km-z]{25,40}$");

    static {
        ArrayList<Asset> assets = new ArrayList<>();
        assets.add(direct("xlm-stellar", "stellar_xlm", "XLM", "Stellar", "stellar_public", "stellar", 7, 0, "", KEY_ED25519, 148, "^G[A-Z2-7]{55}$"));
        assets.add(direct("sol-solana", "solana_sol", "SOL", "Solana", "solana_mainnet", "solana", 9, 0, "", KEY_ED25519, 501, "^[1-9A-HJ-NP-Za-km-z]{32,48}$"));
        assets.add(direct("eth-ethereum", "ethereum_eth", "ETH", "Ethereum", "ethereum_mainnet", "evm", 18, 1, "", KEY_SECP256K1, 60, "^0x[0-9a-fA-F]{40}$"));
        assets.add(direct("usdc-base", "base_usdc", "USDC", "Base", "base_mainnet", "evm", 6, 8453, RiskPolicy.BASE_USDC, KEY_SECP256K1, 60, "^0x[0-9a-fA-F]{40}$"));
        assets.add(prepared("btc-bitcoin", "bitcoin_btc", "BTC", "Bitcoin", "bitcoin_mainnet", "bitcoin", 8, 0, "", KEY_SECP256K1, 0, "^(bc1|[13])[A-HJ-NP-Za-km-z0-9]{18,90}$"));
        assets.add(direct("bnb-bnb-smart-chain", "bsc_bnb", "BNB", "BNB Smart Chain", "bsc_mainnet", "evm", 18, 56, "", KEY_SECP256K1, 60, "^0x[0-9a-fA-F]{40}$"));
        assets.add(prepared("xrp-xrp-ledger", "xrpl_xrp", "XRP", "XRP Ledger", "xrpl_mainnet", "xrp", 6, 0, "", KEY_SECP256K1, 144, "^r[1-9A-HJ-NP-Za-km-z]{12,40}$"));
        assets.add(direct("eth-arbitrum-one", "arbitrum_eth", "ETH", "Arbitrum One", "arbitrum_one", "evm", 18, 42161, "", KEY_SECP256K1, 60, "^0x[0-9a-fA-F]{40}$"));
        assets.add(direct("pol-polygon-pos", "polygon_pol", "POL", "Polygon PoS", "polygon_pos", "evm", 18, 137, "", KEY_SECP256K1, 60, "^0x[0-9a-fA-F]{40}$"));
        assets.add(direct("avax-avalanche-c-chain", "avalanche_avax", "AVAX", "Avalanche C-Chain", "avalanche_c_chain", "evm", 18, 43114, "", KEY_SECP256K1, 60, "^0x[0-9a-fA-F]{40}$"));
        assets.add(direct("eth-optimism", "optimism_eth", "ETH", "Optimism", "optimism_mainnet", "evm", 18, 10, "", KEY_SECP256K1, 60, "^0x[0-9a-fA-F]{40}$"));
        assets.add(prepared("sui-sui", "sui_sui", "SUI", "Sui", "sui_mainnet", "move", 9, 0, "", KEY_ED25519, 784, "^0x[0-9a-fA-F]{48,80}$"));
        assets.add(prepared("apt-aptos", "aptos_apt", "APT", "Aptos", "aptos_mainnet", "move", 8, 0, "", KEY_ED25519, 637, "^0x[0-9a-fA-F]{48,80}$"));
        assets.add(prepared("ton-ton", "ton_ton", "TON", "TON", "ton_mainnet", "ton", 9, 0, "", KEY_ED25519, 607, "^[EU]Q[A-Za-z0-9_-]{20,80}$"));
        assets.add(prepared("ada-cardano", "cardano_ada", "ADA", "Cardano", "cardano_mainnet", "cardano", 6, 0, "", KEY_ED25519, 1815, "^addr1[0-9a-z]{20,120}$"));
        assets.add(prepared("atom-cosmos-hub", "cosmos_atom", "ATOM", "Cosmos Hub", "cosmos_hub", "cosmos", 6, 0, "", KEY_SECP256K1, 118, "^cosmos1[0-9a-z]{20,80}$"));
        assets.add(prepared("dot-polkadot", "polkadot_dot", "DOT", "Polkadot", "polkadot_mainnet", "substrate", 10, 0, "", KEY_ED25519, 354, "^[1-9A-HJ-NP-Za-km-z]{35,55}$"));
        assets.add(prepared("hbar-hedera", "hedera_hbar", "HBAR", "Hedera", "hedera_mainnet", "hedera", 8, 0, "", KEY_ED25519, 3030, "^0\\.0\\.[0-9]+$"));
        assets.add(direct("cro-cronos", "cronos_cro", "CRO", "Cronos", "cronos_mainnet", "evm", 18, 25, "", KEY_SECP256K1, 60, "^0x[0-9a-fA-F]{40}$"));
        assets.add(direct("mnt-mantle", "mantle_mnt", "MNT", "Mantle", "mantle_mainnet", "evm", 18, 5000, "", KEY_SECP256K1, 60, "^0x[0-9a-fA-F]{40}$"));
        assets.add(prepared("strk-starknet", "starknet_strk", "STRK", "Starknet", "starknet_mainnet", "starknet", 18, 0, "", KEY_STARK, 9004, "^0x[0-9a-fA-F]{48,80}$"));
        assets.add(direct("eth-zksync-era", "zksync_eth", "ETH", "ZKsync Era", "zksync_era", "evm", 18, 324, "", KEY_SECP256K1, 60, "^0x[0-9a-fA-F]{40}$"));
        assets.add(direct("eth-linea", "linea_eth", "ETH", "Linea", "linea_mainnet", "evm", 18, 59144, "", KEY_SECP256K1, 60, "^0x[0-9a-fA-F]{40}$"));
        assets.add(prepared("algo-algorand", "algorand_algo", "ALGO", "Algorand", "algorand_mainnet", "algorand", 6, 0, "", KEY_ED25519, 283, "^[A-Z2-7]{40,70}$"));
        assets.add(prepared("xtz-tezos", "tezos_xtz", "XTZ", "Tezos", "tezos_mainnet", "tezos", 6, 0, "", KEY_ED25519, 1729, "^tz[1-3][1-9A-HJ-NP-Za-km-z]{20,40}$"));
        assets.add(prepared("icp-internet-computer", "internet_computer_icp", "ICP", "Internet Computer", "internet_computer", "icp", 8, 0, "", KEY_ED25519, 223, "^[a-z0-9-]{20,90}$"));
        assets.add(prepared("fil-filecoin", "filecoin_fil", "FIL", "Filecoin", "filecoin_mainnet", "filecoin", 18, 0, "", KEY_SECP256K1, 461, "^f[0-4][a-z0-9]{10,90}$"));
        assets.add(prepared("ltc-litecoin", "litecoin_ltc", "LTC", "Litecoin", "litecoin_mainnet", "litecoin", 8, 0, "", KEY_SECP256K1, 2, "^(ltc1|[LM3])[A-HJ-NP-Za-km-z0-9]{18,90}$"));
        assets.add(prepared("bch-bitcoin-cash", "bitcoin_cash_bch", "BCH", "Bitcoin Cash", "bitcoin_cash_mainnet", "bitcoin_cash", 8, 0, "", KEY_SECP256K1, 145, "^(bitcoincash:)?[qp][a-z0-9]{20,90}$"));
        assets.add(prepared("doge-dogecoin", "dogecoin_doge", "DOGE", "Dogecoin", "dogecoin_mainnet", "dogecoin", 8, 0, "", KEY_SECP256K1, 3, "^D[1-9A-HJ-NP-Za-km-z]{25,40}$"));
        ASSETS = Collections.unmodifiableList(assets);
    }

    private TransferAssetRegistry() {}

    static Asset find(String rail, String network, String asset, long chainId) {
        String cleanRail = clean(rail);
        if (cleanRail.length() > 0) {
            for (Asset item : ASSETS) if (item.rail.equals(cleanRail)) return item;
        }
        String cleanNetwork = clean(network);
        String cleanAsset = upper(asset);
        for (Asset item : ASSETS) {
            if (cleanAsset.length() > 0 && !item.symbol.equals(cleanAsset)) continue;
            if (cleanNetwork.length() > 0 && !item.network.equals(cleanNetwork)) continue;
            if (chainId > 0 && item.chainId > 0 && item.chainId != chainId) continue;
            if (cleanAsset.length() > 0 && cleanNetwork.length() > 0) return item;
        }
        return null;
    }

    static Asset find(PaymentIntent intent) {
        return find(intent.rail, intent.network, intent.asset, intent.chainId);
    }

    static String inferRail(String network, String asset, String tokenContract, long chainId) {
        Asset item = find("", network, asset, chainId);
        if (item != null) return item.rail;
        if (tokenContract != null && tokenContract.startsWith("0x")) return "evm_erc20";
        return "";
    }

    static String unsupportedReason(String rail, String network, String asset, String to) {
        String joined = (clean(rail) + " " + clean(network) + " " + clean(asset)).trim();
        if (TRON_ADDRESS.matcher(String.valueOf(to)).matches()
                || joined.matches(".*\\b(tron|trx|trc10|trc20)\\b.*")) {
            return "TRON, TRX, TRC10, and TRC20 are not supported by VelarumPay.";
        }
        if (joined.matches(".*(\\bnear\\b|near[-_ ]?protocol).*")) {
            return "NEAR is removed from the v1 supported transfer asset list.";
        }
        return "";
    }

    static List<String> validateIntent(PaymentIntent intent) {
        ArrayList<String> errors = new ArrayList<>();
        String unsupported = unsupportedReason(intent.rail, intent.network, intent.asset, intent.to);
        if (unsupported.length() > 0) {
            errors.add(unsupported);
            return errors;
        }
        Asset asset = find(intent);
        if (asset == null) {
            errors.add("Unsupported payment rail or asset");
            return errors;
        }
        if (!asset.network.equals(intent.network)) errors.add(asset.symbol + " is supported only on " + asset.network);
        if (!asset.symbol.equalsIgnoreCase(intent.asset)) errors.add("Only " + asset.symbol + " is allowlisted on " + asset.chain);
        if (asset.chainId > 0 && intent.chainId != asset.chainId) errors.add(asset.chain + " chain id must be " + asset.chainId);
        if (asset.tokenContract.length() > 0 && !asset.tokenContract.equalsIgnoreCase(intent.tokenContract)) {
            errors.add(asset.chain + " " + asset.symbol + " token contract is not allowlisted");
        }
        if (asset.decimals >= 0 && intent.decimals >= 0 && intent.decimals != asset.decimals) {
            errors.add(asset.chain + " " + asset.symbol + " decimals must be " + asset.decimals);
        }
        if (!asset.recipient.matcher(intent.to == null ? "" : intent.to).matches()) {
            errors.add(asset.chain + " " + asset.symbol + " recipient address is invalid");
        }
        if (!asset.signerImplemented) {
            errors.add(asset.symbol + " on " + asset.chain + " requires a chain-family signer adapter before broadcast");
        }
        if (asset.requiresPreparedPayload()) {
            if (intent.signingPayload.length() == 0) {
                errors.add(asset.symbol + " on " + asset.chain + " requires a prepared unsigned transaction payload for local signing");
            }
            if (!supportedPayloadEncoding(intent.signingPayloadEncoding)) {
                errors.add("Prepared transaction payload encoding must be hex, base64, utf8, or text");
            }
            if (intent.broadcastUrl.length() == 0) {
                errors.add(asset.symbol + " on " + asset.chain + " requires a broadcast URL for the signed prepared payload");
            } else if (!intent.broadcastUrl.startsWith("https://") && !intent.broadcastUrl.startsWith("http://")) {
                errors.add("Prepared transaction broadcast URL must be http(s)");
            }
        }
        return errors;
    }

    private static Asset direct(String id, String rail, String symbol, String chain, String network, String family, int decimals, long chainId, String tokenContract, String keyCurve, int coinType, String addressPattern) {
        return asset(id, rail, symbol, chain, network, family, decimals, chainId, tokenContract, true, MODE_DIRECT_BROADCAST, keyCurve, coinType, addressPattern);
    }

    private static Asset prepared(String id, String rail, String symbol, String chain, String network, String family, int decimals, long chainId, String tokenContract, String keyCurve, int coinType, String addressPattern) {
        return asset(id, rail, symbol, chain, network, family, decimals, chainId, tokenContract, true, MODE_PREPARED_PAYLOAD, keyCurve, coinType, addressPattern);
    }

    private static Asset asset(String id, String rail, String symbol, String chain, String network, String family, int decimals, long chainId, String tokenContract, boolean signerImplemented, String executionMode, String keyCurve, int coinType, String addressPattern) {
        return new Asset(id, rail, symbol, chain, network, family, decimals, chainId, tokenContract, signerImplemented, executionMode, keyCurve, coinType, Pattern.compile(addressPattern, Pattern.CASE_INSENSITIVE));
    }

    private static boolean supportedPayloadEncoding(String value) {
        String clean = clean(value);
        return clean.equals("hex") || clean.equals("base64") || clean.equals("utf8") || clean.equals("text");
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim().toLowerCase();
    }

    private static String upper(String value) {
        return value == null ? "" : value.trim().toUpperCase();
    }

    static final class Asset {
        final String id;
        final String rail;
        final String symbol;
        final String chain;
        final String network;
        final String family;
        final int decimals;
        final long chainId;
        final String tokenContract;
        final boolean signerImplemented;
        final String executionMode;
        final String keyCurve;
        final int coinType;
        final Pattern recipient;

        Asset(String id, String rail, String symbol, String chain, String network, String family, int decimals, long chainId, String tokenContract, boolean signerImplemented, String executionMode, String keyCurve, int coinType, Pattern recipient) {
            this.id = id;
            this.rail = rail;
            this.symbol = symbol;
            this.chain = chain;
            this.network = network;
            this.family = family;
            this.decimals = decimals;
            this.chainId = chainId;
            this.tokenContract = tokenContract == null ? "" : tokenContract;
            this.signerImplemented = signerImplemented;
            this.executionMode = executionMode == null ? "" : executionMode;
            this.keyCurve = keyCurve == null ? "" : keyCurve;
            this.coinType = coinType;
            this.recipient = recipient;
        }

        boolean requiresPreparedPayload() {
            return MODE_PREPARED_PAYLOAD.equals(executionMode);
        }
    }
}
