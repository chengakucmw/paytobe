package ai.agentwallet.hd;

/**
 * Single home for shortening blockchain addresses / hashes for display
 * (code-quality review D9 / Q5, 2026-06-20).
 *
 * Before this class the same truncation was copy-pasted six times in two drifting
 * formats, and the separator had already diverged — some sites used ASCII "..."
 * while {@code WalletViewModel.shortAddress} used the single "…" ellipsis character,
 * producing visibly inconsistent UI. All call sites now share these two helpers,
 * standardised on the single-character ellipsis "…".
 */
public final class AddressFormat {
    private AddressFormat() {}

    private static final String ELLIPSIS = "…"; // …
    private static final String EM_DASH = "—";  // —

    /**
     * 6 + … + 4 (e.g. {@code GB3JDW…QBYX}). Blank input renders as an em dash; values
     * of 12 chars or fewer are returned unchanged. Matches the previous
     * WalletViewModel.shortAddress behaviour (and replaces WalletRepository.shorten,
     * whose only difference was the ASCII "..." separator).
     */
    public static String shortAddress(String address) {
        if (address == null || address.trim().isEmpty()) return EM_DASH;
        if (address.length() <= 12) return address;
        return address.substring(0, 6) + ELLIPSIS + address.substring(address.length() - 4);
    }

    /**
     * 10 + … + 8 — the longer form used by detail panels / notifications for hashes
     * and full addresses. Null or already-short values (&le; 18 chars) are returned
     * safely (the previous inline copies had no length guard and could throw).
     */
    public static String medium(String value) {
        if (value == null) return "";
        if (value.length() <= 18) return value;
        return value.substring(0, 10) + ELLIPSIS + value.substring(value.length() - 8);
    }
}
