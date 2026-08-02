package ai.agentwallet.hd;

import android.app.Service;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.Nullable;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class RelayPushService extends Service {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService syncExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean syncRunning = new AtomicBoolean(false);
    private final AtomicBoolean syncRequested = new AtomicBoolean(false);
    private RelayClient relayClient;
    private volatile boolean stopped;
    private volatile boolean reconnectScheduled;
    private int reconnectAttempts;

    @Override
    public void onCreate() {
        super.onCreate();
        PaymentNotifications.ensureChannels(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        stopped = false;
        startForeground(PaymentNotifications.RELAY_FOREGROUND_ID, PaymentNotifications.foregroundNotification(this));
        connectRelay();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopped = true;
        if (relayClient != null) relayClient.close();
        handler.removeCallbacksAndMessages(null);
        syncExecutor.shutdownNow();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void connectRelay() {
        if (relayClient != null) relayClient.close();
        relayClient = new RelayClient();
        relayClient.connect(this, new RelayClient.Listener() {
            @Override
            public void onConnected() {
                reconnectAttempts = 0;
                reconnectScheduled = false;
                syncMissedIntents();
            }

            @Override
            public void onIntent(PaymentIntent intent) {
                PaymentNotifications.notifyPaymentIntent(RelayPushService.this, intent);
            }

            @Override
            public void onMessage(String message) {
            }

            @Override
            public void onFailure(String message) {
                scheduleReconnect();
            }
        });
    }

    private void scheduleReconnect() {
        if (stopped || reconnectScheduled) return;
        reconnectScheduled = true;
        // Exponential backoff capped at 60s (5s, 10s, 20s, 40s, 60s…) instead of
        // hammering a down/misconfigured relay every 5s forever — which, for a
        // foreground dataSync service, drains battery and network in a tight loop.
        // reconnectAttempts resets to 0 on a successful connect (onConnected).
        long delay = Math.min(60_000L, 5_000L * (1L << Math.min(reconnectAttempts, 4)));
        reconnectAttempts++;
        handler.postDelayed(() -> {
            reconnectScheduled = false;
            if (!stopped) connectRelay();
        }, delay);
    }

    private void syncMissedIntents() {
        syncRequested.set(true);
        if (!syncRunning.compareAndSet(false, true)) return;
        syncExecutor.execute(() -> {
            try {
                while (!stopped && syncRequested.getAndSet(false)) {
                    try {
                        List<PaymentIntent> items = RelayClient.sync(this);
                        for (PaymentIntent intent : items) {
                            PaymentNotifications.notifyPaymentIntent(this, intent);
                        }
                    } catch (Exception error) {
                        VpLog.w("RelayPushService", "authenticated REST recovery sync failed", error);
                    }
                }
            } finally {
                syncRunning.set(false);
                if (!stopped && syncRequested.get()) syncMissedIntents();
            }
        });
    }
}
