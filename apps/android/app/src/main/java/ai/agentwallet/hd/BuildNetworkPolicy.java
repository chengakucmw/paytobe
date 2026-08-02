package ai.agentwallet.hd;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Hard network boundary for the independently installable testnet build. */
final class BuildNetworkPolicy {
    static final String STELLAR_TESTNET_NETWORK = "stellar_testnet";
    static final String STELLAR_TESTNET_HORIZON = "https://horizon-testnet.stellar.org";

    private BuildNetworkPolicy() {}

    static List<String> violations(PaymentIntent intent) {
        return violations(intent, BuildConfig.OFFICIAL_TESTNET_ONLY, BuildConfig.TESTNET_ONLY);
    }

    static List<String> violations(PaymentIntent intent, boolean testnetOnly) {
        return violations(intent, testnetOnly, testnetOnly);
    }

    static List<String> violations(PaymentIntent intent, boolean officialTestnetOnly, boolean stellarTestnetFlavor) {
        List<String> errors = new ArrayList<>();
        if (!officialTestnetOnly) return errors;
        if (intent == null) {
            errors.add("This official testnet build requires a payment request");
            return errors;
        }
        if (!intent.isStellarXlm()) {
            errors.add("Official testnet builds accept only Stellar testnet XLM payment requests");
        }
        if (!intent.stellarTestnet
                || !STELLAR_TESTNET_NETWORK.equals(normalize(intent.network))) {
            errors.add("Mainnet and unapproved networks are disabled in official testnet builds");
        }
        if ((stellarTestnetFlavor || intent.isStellarXlm())
                && !STELLAR_TESTNET_HORIZON.equals(normalizeUrl(intent.horizonUrl))) {
            errors.add("The testnet build requires the official Stellar testnet Horizon endpoint");
        }
        return errors;
    }

    static void assertAllowed(PaymentIntent intent) {
        List<String> errors = violations(intent);
        if (!errors.isEmpty()) throw new IllegalStateException(String.join("; ", errors));
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    }

    private static String normalizeUrl(String value) {
        return normalize(value).replaceAll("/+$", "");
    }
}
