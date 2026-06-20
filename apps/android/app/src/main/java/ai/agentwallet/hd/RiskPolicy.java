package ai.agentwallet.hd;

import android.content.Context;
import android.content.SharedPreferences;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

final class RiskPolicy {
    static final String BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    private static final String PREFS = "agentwallet_risk_policy";
    private static final String KEY_EVM_WHITELIST = "evm_whitelist";
    private static final String KEY_STELLAR_WHITELIST = "stellar_whitelist";
    private static final BigDecimal DAILY_USDC_LIMIT = new BigDecimal("1000");
    private static final BigDecimal DAILY_XLM_LIMIT = new BigDecimal("1000");
    // B7: SOL has its own daily cap. Exact BigDecimal, never floating point. The SOL
    // branch previously reused DAILY_USDC_LIMIT; the values coincide today but must be
    // able to move independently when per-asset limits are tuned.
    private static final BigDecimal DAILY_SOL_LIMIT = new BigDecimal("1000");
    // M10: when no recipient whitelist is configured, a payment above these per-asset
    // caps to an unverified recipient is blocked (fail closed) instead of merely
    // warned about, so the advertised whitelist control actually protects users.
    // Exact BigDecimal, never floating point.
    private static final BigDecimal UNVERIFIED_USDC_CAP = new BigDecimal("100");
    private static final BigDecimal UNVERIFIED_XLM_CAP = new BigDecimal("100");
    private static final BigDecimal UNVERIFIED_STELLAR_ASSET_CAP = new BigDecimal("100");

    private RiskPolicy() {}

    static Result evaluate(Context context, PaymentIntent intent) {
        Result result = new Result();
        if (intent.isExpired()) result.errors.add("Payment request is expired");
        if (!intent.status.equals(PaymentIntent.STATUS_PENDING)) result.errors.add("Payment request is not pending");
        String unsupported = TransferAssetRegistry.unsupportedReason(intent.rail, intent.network, intent.asset, intent.to);

        if (unsupported.length() > 0) {
            result.errors.add(unsupported);
        } else if (intent.isBaseUsdc()) {
            if (!BASE_USDC.equalsIgnoreCase(intent.tokenContract)) result.errors.add("Base USDC token contract is not allowlisted");
            if (intent.decimals != 6) result.errors.add("Base USDC decimals must be 6");
            WalletNetworkConfig baseNetwork = WalletNetworkStore.findEnabled(context, intent.network, 8453L);
            if (baseNetwork == null || baseNetwork.rpcUrl.length() == 0) {
                result.errors.add("Verified Base RPC URL is required");
            }
            checkWhitelist(context, KEY_EVM_WHITELIST, intent.to, "recipient EVM address", intent.amount, UNVERIFIED_USDC_CAP, result);
            checkDailyLimit(context, "USDC", intent.amount, DAILY_USDC_LIMIT, result);
        } else if (intent.isStellarXlm()) {
            if (!intent.to.startsWith("G")) result.errors.add("Stellar recipient must be a G... public key");
            if (intent.horizonUrl.length() == 0) result.errors.add("Stellar Horizon URL is required");
            checkWhitelist(context, KEY_STELLAR_WHITELIST, intent.to, "recipient Stellar address", intent.amount, UNVERIFIED_XLM_CAP, result);
            checkDailyLimit(context, "XLM", intent.amount, DAILY_XLM_LIMIT, result);
        } else if (intent.isStellarAsset()) {
            if (!intent.to.startsWith("G")) result.errors.add("Stellar recipient must be a G... public key");
            if (intent.horizonUrl.length() == 0) result.errors.add("Stellar Horizon URL is required");
            if (intent.assetIssuer.length() == 0) result.errors.add("Stellar asset issuer is required");
            checkWhitelist(context, KEY_STELLAR_WHITELIST, intent.to, "recipient Stellar address", intent.amount, UNVERIFIED_STELLAR_ASSET_CAP, result);
            result.warnings.add("Stellar non-XLM assets require an active recipient account and a matching trustline before sending");
        } else if (intent.requiresPreparedPayloadSigner()) {
            // SECURITY (blind-signing fix): a prepared payload is an opaque, server-supplied
            // transaction blob. The wallet cannot decode it to prove it actually pays intent.amount
            // to intent.to, so signing it would mean signing bytes the user cannot see. Until the
            // wallet can build or verify the transaction locally per chain, these assets are
            // review-only and must never be signed in-wallet.
            TransferAssetRegistry.Asset prepared = TransferAssetRegistry.find(intent);
            String chainLabel = prepared == null ? intent.asset : prepared.chain;
            result.errors.add(intent.asset + " on " + chainLabel
                    + " can't be signed in this wallet yet: its prepared transaction can't be verified"
                    + " against the amount and recipient shown here. Review only - do not sign.");
        } else if (intent.requiresSignerAdapter()) {
            result.errors.addAll(TransferAssetRegistry.validateIntent(intent));
        } else if (intent.isSolanaSol()) {
            result.errors.addAll(TransferAssetRegistry.validateIntent(intent));
            if (intent.rpcUrl.length() == 0) result.errors.add("Solana RPC URL is required");
            checkDailyLimit(context, "SOL", intent.amount, DAILY_SOL_LIMIT, result);
        } else if (enabledEvmNetwork(context, intent) != null) {
            checkEnabledEvmPayment(context, intent, result);
        } else {
            result.errors.addAll(TransferAssetRegistry.validateIntent(intent));
        }

        result.warnings.addAll(intent.warnings);
        if (intent.velarumRequestId.length() == 0) result.warnings.add("No Velarum request id is attached");
        // M12: surface (but do not block on) a request the server left without an expiry.
        if (!intent.hasExpiry()) result.warnings.add("This request has no expiry; it stays valid until cancelled");
        if (result.errors.isEmpty()) result.allowed = true;
        return result;
    }

    static String verifiedEvmRpcUrl(Context context, PaymentIntent intent) {
        WalletNetworkConfig network = enabledEvmNetwork(context, intent);
        if (network != null && network.rpcUrl.length() > 0) return network.rpcUrl;
        return intent == null ? "" : intent.rpcUrl;
    }

    static WalletNetworkConfig enabledEvmNetwork(Context context, PaymentIntent intent) {
        if (intent == null || intent.chainId <= 0L || !isEvmRecipient(intent.to)) return null;
        return WalletNetworkStore.findEnabled(context, intent.network, intent.chainId);
    }

    private static void checkEnabledEvmPayment(Context context, PaymentIntent intent, Result result) {
        WalletNetworkConfig network = enabledEvmNetwork(context, intent);
        if (network == null) {
            result.errors.add("Target EVM network is not enabled");
            return;
        }
        if (network.rpcUrl.length() == 0) result.errors.add("Verified RPC URL is required");
        if (!isEvmRecipient(intent.to)) result.errors.add("Recipient must be an EVM 0x address");
        if (intent.amount.length() == 0) result.errors.add("Amount is required");
        else {
            try {
                if (new BigDecimal(intent.amount).compareTo(BigDecimal.ZERO) <= 0) {
                    result.errors.add("Amount must be greater than zero");
                }
            } catch (Exception e) {
                result.errors.add("Amount is invalid");
            }
        }
        if (isErc20Payment(intent)) {
            if (!isEvmRecipient(intent.tokenContract)) result.errors.add("Token contract must be an EVM 0x address");
            if (intent.decimals < 0 || intent.decimals > 255) result.errors.add("Token decimals must be between 0 and 255");
        }
        result.warnings.add("This request targets a locally enabled custom EVM network. Confirm recipient, asset, fees, and explorer details before signing.");
    }

    static boolean isErc20Payment(PaymentIntent intent) {
        return "evm_erc20".equals(intent.rail) || intent.tokenContract.length() > 0;
    }

    static void recordSuccessfulPayment(Context context, PaymentIntent intent) {
        String asset = intent.asset.toUpperCase();
        String key = "spent:" + LocalDate.now() + ":" + asset;
        SharedPreferences prefs = prefs(context);
        BigDecimal before = new BigDecimal(prefs.getString(key, "0"));
        BigDecimal after = before.add(new BigDecimal(intent.amount));
        prefs.edit().putString(key, after.toPlainString()).apply();
    }

    static Set<String> evmWhitelist(Context context) {
        return prefs(context).getStringSet(KEY_EVM_WHITELIST, new HashSet<>());
    }

    static Set<String> stellarWhitelist(Context context) {
        return prefs(context).getStringSet(KEY_STELLAR_WHITELIST, new HashSet<>());
    }

    private static void checkDailyLimit(Context context, String asset, String amount, BigDecimal limit, Result result) {
        BigDecimal value;
        try {
            value = new BigDecimal(amount);
        } catch (Exception e) {
            result.errors.add(asset + " amount is invalid");
            return;
        }
        String key = "spent:" + LocalDate.now() + ":" + asset;
        BigDecimal spent = new BigDecimal(prefs(context).getString(key, "0"));
        if (spent.add(value).compareTo(limit) > 0) {
            result.errors.add("Daily " + asset + " limit exceeded");
        }
    }

    private static void checkWhitelist(Context context, String key, String address, String label,
                                       String amount, BigDecimal unverifiedCap, Result result) {
        Set<String> list = prefs(context).getStringSet(key, new HashSet<>());
        if (list != null && !list.isEmpty()) {
            boolean found = false;
            for (String item : list) {
                if (item.equalsIgnoreCase(address)) found = true;
            }
            if (!found) result.errors.add("The " + label + " is not in your local whitelist");
            return;
        }
        // M10: with no whitelist to match against, this control previously only warned
        // and never blocked - the advertised "recipient whitelist" was effectively dead.
        // Fail closed instead: everyday small payments still go through (with a warning),
        // but anything above the per-asset cap to an unverified recipient is blocked.
        if (exceedsCap(amount, unverifiedCap)) {
            result.errors.add("No recipient whitelist is set, so a payment of " + amount
                    + " to an unverified " + label + " is blocked (limit "
                    + unverifiedCap.toPlainString() + "). Send a smaller amount, or to a recipient you trust.");
        } else {
            result.warnings.add("No recipient whitelist is set for " + label
                    + "; this recipient has not been verified.");
        }
    }

    private static boolean exceedsCap(String amount, BigDecimal cap) {
        if (cap == null) return false;
        try {
            return new BigDecimal(amount).compareTo(cap) > 0;
        } catch (Exception e) {
            // An unparseable/blank amount is treated as over the cap (fail closed); the
            // per-rail amount validation surfaces a clearer "amount is invalid" error too.
            return true;
        }
    }

    private static boolean isEvmRecipient(String value) {
        return value != null && value.matches("^0x[0-9a-fA-F]{40}$");
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static final class Result {
        boolean allowed;
        final List<String> errors = new ArrayList<>();
        final List<String> warnings = new ArrayList<>();
    }
}
