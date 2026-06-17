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

    private RiskPolicy() {}

    static Result evaluate(Context context, PaymentIntent intent) {
        Result result = new Result();
        if (intent.isExpired()) result.errors.add("Payment request is expired");
        if (!intent.status.equals(PaymentIntent.STATUS_PENDING)) result.errors.add("Payment request is not pending");

        if (intent.isBaseUsdc()) {
            if (!BASE_USDC.equalsIgnoreCase(intent.tokenContract)) result.errors.add("Base USDC token contract is not allowlisted");
            if (intent.decimals != 6) result.errors.add("Base USDC decimals must be 6");
            if (intent.rpcUrl.length() == 0) result.errors.add("Base RPC URL is required");
            checkWhitelist(context, KEY_EVM_WHITELIST, intent.to, "recipient EVM address", result);
            checkDailyLimit(context, "USDC", intent.amount, DAILY_USDC_LIMIT, result);
        } else if (intent.isStellarXlm()) {
            if (!intent.to.startsWith("G")) result.errors.add("Stellar recipient must be a G... public key");
            if (intent.horizonUrl.length() == 0) result.errors.add("Stellar Horizon URL is required");
            checkWhitelist(context, KEY_STELLAR_WHITELIST, intent.to, "recipient Stellar address", result);
            checkDailyLimit(context, "XLM", intent.amount, DAILY_XLM_LIMIT, result);
        } else if (intent.isStellarAsset()) {
            if (!intent.to.startsWith("G")) result.errors.add("Stellar recipient must be a G... public key");
            if (intent.horizonUrl.length() == 0) result.errors.add("Stellar Horizon URL is required");
            if (intent.assetIssuer.length() == 0) result.errors.add("Stellar asset issuer is required");
            checkWhitelist(context, KEY_STELLAR_WHITELIST, intent.to, "recipient Stellar address", result);
            result.warnings.add("Stellar non-XLM assets require an active recipient account and a matching trustline before sending");
        } else {
            result.errors.add("Unsupported payment rail or asset");
        }

        result.warnings.addAll(intent.warnings);
        if (intent.velarumRequestId.length() == 0) result.warnings.add("No Velarum request id is attached");
        if (result.errors.isEmpty()) result.allowed = true;
        return result;
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

    private static void checkWhitelist(Context context, String key, String address, String label, Result result) {
        Set<String> list = prefs(context).getStringSet(key, new HashSet<>());
        if (list == null || list.isEmpty()) {
            result.warnings.add("No local whitelist is configured for " + label);
            return;
        }
        boolean found = false;
        for (String item : list) {
            if (item.equalsIgnoreCase(address)) found = true;
        }
        if (!found) result.errors.add("The " + label + " is not in the local whitelist");
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
