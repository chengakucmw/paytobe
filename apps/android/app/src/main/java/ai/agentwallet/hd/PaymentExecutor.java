package ai.agentwallet.hd;

import android.content.Context;

final class PaymentExecutor {
    private PaymentExecutor() {}

    static String execute(Context context, HDWallet wallet, PaymentIntent intent) throws Exception {
        return execute(context, wallet, intent, null);
    }

    static String execute(Context context, HDWallet wallet, PaymentIntent intent, TransactionProgress progress) throws Exception {
        RiskPolicy.Result risk = RiskPolicy.evaluate(context, intent);
        if (!risk.allowed) throw new IllegalStateException(join(risk.errors));
        if (intent.isBaseUsdc()) {
            return EvmTransfer.sendErc20(
                    intent.rpcUrl,
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
            return StellarTransfer.sendXlm(
                    intent.horizonUrl,
                    intent.stellarTestnet,
                    wallet.stellar.privateSeed,
                    wallet.stellar.publicKey,
                    intent.to,
                    intent.amount,
                    progress
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
