package ai.agentwallet.hd;

import android.util.Log;

import java.net.URI;
import java.util.Locale;

/** Resolves the fail-closed Platform API boundary for the selected build variant. */
final class PlatformServiceConfig {
    static final String OFFICIAL_TESTNET_ORIGIN = "https://api.velarumai.com";
    private static final String LOG_TAG = "VelarumPayEnvironment";

    private PlatformServiceConfig() {
    }

    static String baseUrl(String userOverride) {
        String resolved = baseUrl(
                BuildConfig.DEFAULT_PLATFORM_API_URL,
                userOverride,
                BuildConfig.INTERNAL_PLATFORM_OVERRIDE_ENABLED
        );
        if (BuildConfig.INTERNAL_PLATFORM_OVERRIDE_ENABLED) {
            Log.w(LOG_TAG, environmentLabel(resolved, true));
        }
        return resolved;
    }

    static String baseUrl(String builtIn, String userOverride, boolean internalOverrideEnabled) {
        String official = requireOfficialOrigin(builtIn);
        if (!internalOverrideEnabled) return official;
        String override = normalize(userOverride);
        return override.isEmpty() ? official : requireStableHttpsOverride(override);
    }

    static boolean isManaged() {
        return BuildConfig.MANAGED_PLATFORM_SERVICE;
    }

    static boolean isUnofficialEnvironment() {
        return BuildConfig.INTERNAL_PLATFORM_OVERRIDE_ENABLED;
    }

    static String environmentLabel(String resolvedBaseUrl, boolean internalOverrideEnabled) {
        if (!internalOverrideEnabled) return "Official testnet";
        String host;
        try {
            host = URI.create(resolvedBaseUrl).getHost();
        } catch (RuntimeException ignored) {
            host = null;
        }
        return "Internal debug · Unofficial environment" + (host == null ? "" : ": " + host);
    }

    static boolean supportsWebSocket() {
        return BuildConfig.PLATFORM_WEBSOCKET_ENABLED;
    }

    private static String requireOfficialOrigin(String value) {
        String normalized = normalize(value);
        if (!OFFICIAL_TESTNET_ORIGIN.equals(normalized)) {
            throw new IllegalStateException("Official builds require the VelarumPay testnet origin.");
        }
        return OFFICIAL_TESTNET_ORIGIN;
    }

    private static String requireStableHttpsOverride(String value) {
        URI uri;
        try {
            uri = URI.create(value);
        } catch (RuntimeException error) {
            throw new IllegalStateException("Internal Platform override is invalid.");
        }
        String host = uri.getHost();
        String normalizedHost = host == null ? "" : host.toLowerCase(Locale.ROOT);
        if (!"https".equalsIgnoreCase(uri.getScheme())
                || normalizedHost.isEmpty()
                || uri.getRawUserInfo() != null
                || uri.getPort() != -1
                || uri.getRawQuery() != null
                || uri.getRawFragment() != null
                || !(uri.getPath() == null || uri.getPath().isEmpty() || "/".equals(uri.getPath()))
                || normalizedHost.indexOf('.') < 0
                || isIpLiteral(normalizedHost)
                || isTemporaryOrLocalHost(normalizedHost)) {
            throw new IllegalStateException("Internal Platform override requires a stable public HTTPS origin.");
        }
        return "https://" + normalizedHost;
    }

    private static boolean isIpLiteral(String host) {
        return host.indexOf(':') >= 0 || host.matches("^[0-9.]+$");
    }

    private static boolean isTemporaryOrLocalHost(String host) {
        return host.equals("localhost")
                || host.endsWith(".localhost")
                || host.endsWith(".local")
                || host.endsWith(".internal")
                || host.endsWith(".lan")
                || host.endsWith(".home")
                || host.endsWith(".localdomain")
                || host.endsWith(".invalid")
                || host.endsWith(".test")
                || host.endsWith(".example")
                || host.endsWith(".example.com")
                || host.endsWith(".example.net")
                || host.endsWith(".example.org")
                || host.endsWith(".chatgpt.site")
                || host.endsWith(".trycloudflare.com")
                || host.endsWith(".ngrok.io")
                || host.endsWith(".ngrok.app");
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim().replaceAll("/+$", "");
    }
}
