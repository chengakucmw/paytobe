package ai.agentwallet.hd;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;

/**
 * Shared factory for the app's OkHttp clients.
 *
 * <p>Every network client must be built here so that all requests carry explicit
 * timeouts. Previously each caller used {@code new OkHttpClient()}, which has no
 * overall call timeout: a stalled server (or a connection that trickles bytes
 * just often enough to keep resetting the per-read timeout) could leave a request
 * hanging indefinitely, freezing the UI on an endless spinner (bug H8).
 *
 * <p>Centralising the policy keeps every call site consistent and means any new
 * networking code inherits sane timeouts automatically.
 */
final class WalletHttp {
    /** TCP + TLS handshake budget. */
    private static final long CONNECT_TIMEOUT_SECONDS = 15L;
    /** Per-read budget while waiting for response bytes. */
    private static final long READ_TIMEOUT_SECONDS = 30L;
    /** Budget for streaming the request body out. */
    private static final long WRITE_TIMEOUT_SECONDS = 30L;
    /** Hard ceiling for an entire call, including connect, redirects and retries. */
    private static final long CALL_TIMEOUT_SECONDS = 60L;
    /** Keep-alive ping cadence for long-lived web sockets. */
    private static final long WEBSOCKET_PING_SECONDS = 20L;

    private WalletHttp() {}

    /**
     * Client for one-shot request/response calls. The call timeout guarantees the
     * request can never hang past {@value #CALL_TIMEOUT_SECONDS} seconds.
     */
    static OkHttpClient oneShot() {
        return new OkHttpClient.Builder()
                .connectTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .readTimeout(READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .writeTimeout(WRITE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .callTimeout(CALL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .build();
    }

    /**
     * Client for long-lived web socket connections. The connect timeout still
     * bounds the initial handshake, and a periodic ping detects a dead peer, but
     * read and call timeouts are intentionally left disabled so that an open but
     * idle socket is not torn down mid-session.
     */
    static OkHttpClient webSocket() {
        return new OkHttpClient.Builder()
                .connectTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .pingInterval(WEBSOCKET_PING_SECONDS, TimeUnit.SECONDS)
                .build();
    }
}
