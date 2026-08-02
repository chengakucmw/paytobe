package ai.agentwallet.hd;

import android.content.Context;

import java.math.BigDecimal;
import java.math.BigInteger;

/**
 * 只读网络费用估算：与 {@link PaymentExecutor#execute} 完全相同的分链路由，但只做只读 RPC 查询
 * （Stellar fee_stats / Solana getFeeForMessage / EVM gasPrice×gasLimit），绝不签名、绝不广播。
 *
 * 供发送页 CONFIRM 步骤展示「真实网络费用」。任何不支持的链或任何失败都返回 null，UI 据此回退到
 * 「Calculated at broadcast」旧文案——因此该估算永远不会阻塞或影响签名流程（铁律：只读、可失败）。
 *
 * Gas/手续费一律以该链的「原生币」计价（如 Base 上的 USDC 转账，手续费仍以 ETH 计），与链上实际扣费一致。
 */
final class NetworkFeeEstimator {
    private NetworkFeeEstimator() {}

    /** 返回形如 “≈ 0.000005 SOL” 的展示串；无法估算（链不支持 / 出错 / 超时）时返回 null。 */
    static String estimateDisplayFee(Context context, HDWallet wallet, PaymentIntent intent) {
        try {
            // Base USDC（ERC-20）：手续费以 Base 原生币 ETH 计价。
            if (intent.isBaseUsdc()) {
                BigInteger wei = EvmTransfer.estimateFeeWei(
                        RiskPolicy.verifiedEvmRpcUrl(context, intent),
                        wallet.evm.address, intent.tokenContract, intent.to, intent.amount, 6, true);
                return formatMinor(wei, 18, "ETH");
            }
            if (intent.isStellarXlm()) {
                long stroops = StellarTransfer.estimateFeeStroops(intent.horizonUrl, intent.stellarTestnet);
                return formatMinor(BigInteger.valueOf(stroops), 7, "XLM");
            }
            if (intent.isSolanaSol()) {
                long lamports = SolanaTransfer.estimateFeeLamports(
                        intent.rpcUrl, wallet.solana.address, intent.to, intent.amount);
                return formatMinor(BigInteger.valueOf(lamports), 9, "SOL");
            }
            // 任意已启用的 EVM 链：原生币转账，或（未来的）其他 ERC-20。
            WalletNetworkConfig evmNetwork = RiskPolicy.enabledEvmNetwork(context, intent);
            if (evmNetwork != null) {
                String nativeSymbol = nativeSymbol(evmNetwork, intent);
                if (RiskPolicy.isErc20Payment(intent)) {
                    BigInteger wei = EvmTransfer.estimateFeeWei(
                            evmNetwork.rpcUrl, wallet.evm.address, intent.tokenContract,
                            intent.to, intent.amount, intent.decimals, true);
                    return formatMinor(wei, 18, nativeSymbol);
                }
                BigInteger wei = EvmTransfer.estimateFeeWei(
                        evmNetwork.rpcUrl, wallet.evm.address, null, intent.to, intent.amount, 18, false);
                return formatMinor(wei, 18, nativeSymbol);
            }
        } catch (Exception ignored) {
            VpLog.w("NetworkFeeEstimator", "fee estimate failed; falling back to broadcast-time wording", ignored);
        }
        return null;
    }

    /** 原生币符号：原生转账用 intent.asset；否则用网络配置里的币种符号，再兜底 ETH。 */
    private static String nativeSymbol(WalletNetworkConfig evmNetwork, PaymentIntent intent) {
        if (!RiskPolicy.isErc20Payment(intent) && intent.asset != null && !intent.asset.isEmpty()) {
            return intent.asset;
        }
        if (evmNetwork.currencySymbol != null && !evmNetwork.currencySymbol.isEmpty()) {
            return evmNetwork.currencySymbol;
        }
        return "ETH";
    }

    /** 把最小单位（stroops/lamports/wei）按 decimals 精确换算为十进制串（绝不用浮点）。null/非正 → null。 */
    private static String formatMinor(BigInteger minor, int decimals, String symbol) {
        if (minor == null || minor.signum() <= 0) return null;
        BigDecimal value = new BigDecimal(minor).movePointLeft(decimals).stripTrailingZeros();
        return "≈ " + value.toPlainString() + " " + symbol;
    }
}
