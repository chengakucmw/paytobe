package ai.agentwallet.hd;

final class WalletSecurityNavigationPolicy {
    static final String SURFACE_HOME = "home";
    static final String SURFACE_PROFILE = "profile";
    static final String SURFACE_SETTINGS_SECURITY = "settings/security";
    static final String SURFACE_RECOVERY_PHRASE = "settings/security/recovery_phrase";
    static final String STATE_BACKUP_REQUIRED = "backup_required";

    private WalletSecurityNavigationPolicy() {}

    static boolean allowsMnemonicEntry(String surface) {
        String normalized = normalizeSurface(surface);
        return normalized.equals(SURFACE_SETTINGS_SECURITY)
                || normalized.startsWith(SURFACE_SETTINGS_SECURITY + "/");
    }

    static boolean allowsMnemonicReveal(String surface) {
        return normalizeSurface(surface).equals(SURFACE_RECOVERY_PHRASE);
    }

    static boolean requiresBackupGate(boolean walletLoaded, boolean backupVerified, boolean paymentReady) {
        return walletLoaded && paymentReady && !backupVerified;
    }

    static boolean canCreateSignature(boolean walletLoaded, boolean backupVerified, boolean paymentReady) {
        return walletLoaded && backupVerified && paymentReady;
    }

    static String backupGateCopy() {
        return "Back up and verify the recovery phrase in Settings > Security before this device can sign or export secrets.";
    }

    private static String normalizeSurface(String surface) {
        if (surface == null) return "";
        return surface.trim().toLowerCase().replace(" ", "_");
    }
}
