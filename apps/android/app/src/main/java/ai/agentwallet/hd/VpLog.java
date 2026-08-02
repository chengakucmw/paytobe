package ai.agentwallet.hd;

import android.util.Log;

/**
 * App-wide thin logging facade (code-quality review D9 / Q1, 2026-06-20).
 *
 * Why this exists: before this class the Android app had NO logging at all, so the
 * dozens of {@code catch (... ignored) {}} blocks failed completely silently in
 * production — a broadcast could succeed while a local status write was dropped with
 * zero diagnostic trace. This wrapper gives those sites a one-line breadcrumb and a
 * single place to later swap in a structured logger / crash reporter.
 *
 * SECURITY — never pass secrets here. Do NOT log mnemonics, seeds, private keys,
 * recovery phrases, or raw amounts/addresses. Log the operation name + the caught
 * exception only. Exceptions from the JSON / network / parse layers do not carry key
 * material, which is what makes logging a {@code Throwable} here safe.
 */
public final class VpLog {
    private VpLog() {}

    public static void d(String tag, String message) {
        Log.d(tag, message);
    }

    public static void i(String tag, String message) {
        Log.i(tag, message);
    }

    public static void w(String tag, String message) {
        Log.w(tag, message);
    }

    public static void w(String tag, String message, Throwable t) {
        Log.w(tag, message, t);
    }

    public static void e(String tag, String message, Throwable t) {
        Log.e(tag, message, t);
    }
}
