package ai.agentwallet.hd;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

final class StellarMainnetPolicy {
    private StellarMainnetPolicy() {}

    static List<String> violations(
            boolean testnet,
            String horizonUrl,
            String destination,
            String amountXlm
    ) {
        return violations(testnet, horizonUrl, destination, amountXlm, Config.fromBuild());
    }

    static List<String> violations(
            boolean testnet,
            String horizonUrl,
            String destination,
            String amountXlm,
            Config config
    ) {
        List<String> errors = new ArrayList<>();
        if (testnet) return errors;
        if (!config.enabled) {
            errors.add("Stellar mainnet payments are disabled in this build");
            return errors;
        }

        String configuredHorizon = normalizeUrl(config.horizonUrl);
        String requestedHorizon = normalizeUrl(horizonUrl);
        if (!configuredHorizon.startsWith("https://")) {
            errors.add("Stellar mainnet Horizon configuration must use HTTPS");
        } else if (!configuredHorizon.equalsIgnoreCase(requestedHorizon)) {
            errors.add("Stellar mainnet Horizon URL is not the build-approved endpoint");
        }

        BigDecimal amount = positiveDecimal(amountXlm);
        BigDecimal maximum = positiveDecimal(config.maximumXlm);
        if (maximum == null) {
            errors.add("Stellar mainnet payment limit is not configured correctly");
        } else if (amount == null) {
            errors.add("Stellar mainnet amount must be greater than zero");
        } else if (amount.compareTo(maximum) > 0) {
            errors.add("Stellar mainnet payment exceeds the per-transfer limit of "
                    + maximum.stripTrailingZeros().toPlainString() + " XLM");
        }

        Set<String> recipients = parseRecipients(config.recipients);
        if (recipients.isEmpty()) {
            errors.add("Stellar mainnet recipient allowlist is empty");
        } else if (!recipients.contains(String.valueOf(destination).trim().toUpperCase(Locale.ROOT))) {
            errors.add("Stellar mainnet recipient is not in the build-approved allowlist");
        }
        return errors;
    }

    static void assertAllowed(
            boolean testnet,
            String horizonUrl,
            String destination,
            String amountXlm
    ) {
        List<String> errors = violations(testnet, horizonUrl, destination, amountXlm);
        if (!errors.isEmpty()) throw new IllegalStateException(String.join("; ", errors));
    }

    private static BigDecimal positiveDecimal(String value) {
        try {
            BigDecimal number = new BigDecimal(String.valueOf(value).trim());
            return number.compareTo(BigDecimal.ZERO) > 0 ? number : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static Set<String> parseRecipients(String value) {
        Set<String> recipients = new HashSet<>();
        for (String item : String.valueOf(value).split(",")) {
            String clean = item.trim().toUpperCase(Locale.ROOT);
            if (!clean.isEmpty()) recipients.add(clean);
        }
        return recipients;
    }

    private static String normalizeUrl(String value) {
        return String.valueOf(value == null ? "" : value).trim().replaceAll("/+$", "");
    }

    static final class Config {
        final boolean enabled;
        final String maximumXlm;
        final String horizonUrl;
        final String recipients;

        Config(boolean enabled, String maximumXlm, String horizonUrl, String recipients) {
            this.enabled = enabled;
            this.maximumXlm = maximumXlm;
            this.horizonUrl = horizonUrl;
            this.recipients = recipients;
        }

        static Config fromBuild() {
            return new Config(
                    BuildConfig.STELLAR_MAINNET_ENABLED,
                    BuildConfig.STELLAR_MAINNET_MAX_XLM,
                    BuildConfig.STELLAR_MAINNET_HORIZON_URL,
                    BuildConfig.STELLAR_MAINNET_RECIPIENTS
            );
        }
    }
}
