package ai.agentwallet.hd;

import android.content.Context;

final class PaymentExecutor {
    private PaymentExecutor() {}

    static String execute(Context context, HDWallet wallet, PaymentIntent intent) throws Exception {
        return execute(context, wallet, intent, null);
    }

    static String execute(Context context, HDWallet wallet, PaymentIntent intent, TransactionProgress progress) throws Exception {
        BuildNetworkPolicy.assertAllowed(intent);
        RiskPolicy.Result risk = RiskPolicy.evaluate(context, intent);
        if (!risk.allowed) throw new IllegalStateException(join(risk.errors));
        if (intent.isBaseUsdc()) {
            return EvmTransfer.sendErc20(
                    RiskPolicy.verifiedEvmRpcUrl(context, intent),
                    8453L,
                    wallet.evm.privateKey,
                    intent.tokenContract,
                    intent.to,
                    intent.amount,
                    6,
                    progress
            );
        }
        if (intent.isStellarXlm()) {
            // Re-check at the signing boundary so a caller cannot bypass the UI/risk
            // review and directly broadcast a mainnet transaction.
            StellarMainnetPolicy.assertAllowed(
                    intent.stellarTestnet,
                    intent.horizonUrl,
                    intent.to,
                    intent.amount
            );
            return StellarTransfer.sendXlm(
                    intent.horizonUrl,
                    intent.stellarTestnet,
                    wallet.stellar.privateSeed,
                    wallet.stellar.publicKey,
                    intent.to,
                    intent.amount,
                    progress,
                    intent.memo,
                    intent.memoType
            );
        }
        if (intent.isStellarAsset()) {
            StellarTransfer.requireDestinationCanReceiveAsset(
                    intent.horizonUrl,
                    intent.stellarTestnet,
                    intent.to,
                    intent.asset,
                    intent.assetIssuer
            );
            throw new IllegalStateException(
                    "Stellar " + intent.asset
                            + " recipient is ready, but this app version only broadcasts Stellar XLM. "
                    + "Enable the Stellar asset signer before sending non-XLM assets."
            );
        }
        if (intent.requiresSignerAdapter()) {
            TransferAssetRegistry.Asset asset = TransferAssetRegistry.find(intent);
            throw new IllegalStateException(
                    (asset == null ? intent.asset : asset.symbol + " on " + asset.chain)
                            + " requires a chain-family signer adapter before broadcast"
            );
        }
        if (intent.requiresPreparedPayloadSigner()) {
            // SECURITY (blind-signing fix): never sign a server-supplied prepared payload. Its bytes
            // are opaque and cannot be proven to match the amount/recipient shown to the user, so
            // signing here would be a blind signature. This rail is review-only until the wallet can
            // build or verify the transaction locally per chain. RiskPolicy already blocks it; this
            // is a hard defense-in-depth guard so the blind-sign path can never be reached.
            TransferAssetRegistry.Asset asset = TransferAssetRegistry.find(intent);
            throw new IllegalStateException(
                    (asset == null ? intent.asset : asset.symbol + " on " + asset.chain)
                            + " can't be signed in this wallet yet: its prepared transaction can't be"
                            + " verified against the amount and recipient shown here.");
        }
        if (intent.isSolanaSol()) {
            return SolanaTransfer.sendSol(
                    intent.rpcUrl,
                    wallet.solana.privateSeed,
                    wallet.solana.publicKey,
                    intent.to,
                    intent.amount
            );
        }
        WalletNetworkConfig evmNetwork = RiskPolicy.enabledEvmNetwork(context, intent);
        if (evmNetwork != null) {
            if (RiskPolicy.isErc20Payment(intent)) {
                return EvmTransfer.sendErc20(
                        evmNetwork.rpcUrl,
                        evmNetwork.chainId,
                        wallet.evm.privateKey,
                        intent.tokenContract,
                        intent.to,
                        intent.amount,
                        intent.decimals,
                        progress
                );
            }
            return EvmTransfer.sendNative(
                    evmNetwork.rpcUrl,
                    evmNetwork.chainId,
                    wallet.evm.privateKey,
                    intent.to,
                    intent.amount,
                    progress
            );
        }
        throw new IllegalArgumentException("Unsupported payment request");
    }

    private static String join(java.util.List<String> values) {
        StringBuilder out = new StringBuilder();
        for (String value : values) {
            if (out.length() > 0) out.append("; ");
            out.append(value);
        }
        return out.toString();
    }
}
