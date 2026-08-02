package ai.agentwallet.hd;

import java.math.BigDecimal;
import java.math.BigInteger;

/**
 * Single home for "decimal string -&gt; integer base units" money conversion on
 * Android (code-quality review D9 / Q4, 2026-06-20).
 *
 * Before this class the same conversion was re-implemented four times across
 * {@code StellarTransfer} / {@code SolanaTransfer} / {@code EvmTransfer} with
 * inconsistent validation — notably {@code solToLamports} leaked raw
 * {@link NumberFormatException} / {@link ArithmeticException} to the user while
 * {@code xlmToStroops} had been hardened with friendly messages. They now share one
 * validated path.
 *
 * Discipline carried over verbatim: exact {@link BigDecimal} / {@link BigInteger}
 * math, never floating point. The numeric output of every method is identical to the
 * previous per-class implementations; the only behaviour change is that
 * {@link #solToLamports(String)} now produces the same friendly validation messages
 * as {@link #xlmToStroops(String)} instead of leaking raw exceptions.
 */
public final class AmountUnits {
    private AmountUnits() {}

    /** u64 max (2^64 - 1): the SPL token amount ceiling. */
    private static final BigInteger MAX_U64 = new BigInteger("18446744073709551615");

    /** XLM -&gt; stroops (1 XLM = 10^7 stroops). Behaviour unchanged from StellarTransfer.xlmToStroops. */
    public static long xlmToStroops(String xlm) {
        return scaledLongExact(
                xlm, 7,
                "Enter an amount of XLM to send.",
                "Enter a valid XLM amount, for example 1.5.",
                "XLM amount must be greater than 0.",
                "XLM supports at most 7 decimal places (1 stroop = 0.0000001 XLM) and must be within range. Adjust the amount.");
    }

    /** SOL -&gt; lamports (1 SOL = 10^9 lamports). Now validated with friendly messages (previously leaked raw exceptions). */
    public static long solToLamports(String sol) {
        return scaledLongExact(
                sol, 9,
                "Enter an amount of SOL to send.",
                "Enter a valid SOL amount, for example 1.5.",
                "SOL amount must be greater than 0.",
                "SOL supports at most 9 decimal places (1 lamport = 0.000000001 SOL) and must be within range. Adjust the amount.");
    }

    /** Generic EVM / ERC-20 whole-token amount -&gt; base units. Behaviour unchanged from EvmTransfer.tokenUnits. */
    public static BigInteger tokenUnits(String amount, int decimals) {
        if (decimals < 0 || decimals > 255) throw new IllegalArgumentException("Token decimals must be between 0 and 255");
        BigInteger units = new BigDecimal(amount.trim()).movePointRight(decimals).toBigIntegerExact();
        if (units.signum() <= 0) throw new IllegalArgumentException("Token amount must be greater than zero");
        return units;
    }

    /** SPL token amount -&gt; base units, capped at u64. Behaviour unchanged from SolanaTransfer.tokenUnitsU64. */
    public static BigInteger tokenUnitsU64(String amount, int decimals) {
        if (decimals < 0 || decimals > 255) throw new IllegalArgumentException("SPL token decimals must be between 0 and 255");
        BigInteger units = new BigDecimal(amount.trim()).movePointRight(decimals).toBigIntegerExact();
        if (units.signum() <= 0) throw new IllegalArgumentException("Token amount must be greater than zero");
        if (units.compareTo(MAX_U64) > 0) throw new IllegalArgumentException("SPL token amount exceeds u64");
        return units;
    }

    /**
     * Shared validated path for {@link #xlmToStroops} / {@link #solToLamports}: trim,
     * reject empty / non-numeric / non-positive, scale by 10^decimals with exact
     * integer math, and map overflow or excess precision to a friendly message.
     * Mirrors the original StellarTransfer.xlmToStroops behaviour exactly
     * ({@code movePointRight(n)} is equivalent to {@code multiply(10^n)} for BigDecimal,
     * and {@code longValueExact()} stays inside the same catch so overflow is friendly too).
     */
    private static long scaledLongExact(
            String raw, int decimals, String emptyMsg, String invalidMsg, String nonPositiveMsg, String overflowMsg) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) throw new IllegalStateException(emptyMsg);
        BigDecimal value;
        try {
            value = new BigDecimal(s);
        } catch (NumberFormatException e) {
            throw new IllegalStateException(invalidMsg);
        }
        if (value.signum() <= 0) throw new IllegalStateException(nonPositiveMsg);
        try {
            return value.movePointRight(decimals).toBigIntegerExact().longValueExact();
        } catch (ArithmeticException e) {
            throw new IllegalStateException(overflowMsg);
        }
    }
}
