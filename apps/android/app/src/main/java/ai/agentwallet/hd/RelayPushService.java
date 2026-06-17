package ai.agentwallet.hd;

import android.app.Service;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.Nullable;

import java.util.List;

public class RelayPushService extends Service {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private RelayClient relayClient;
    private boolean stopped;

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
        if (stopped) return;
        handler.postDelayed(() -> {
            if (!stopped) connectRelay();
        }, 5000);
    }

    private void syncMissedIntents() {
        new Thread(() -> {
            try {
                List<PaymentIntent> items = RelayClient.sync(this);
                for (PaymentIntent intent : items) {
                    if (PaymentIntent.STATUS_PENDING.equals(intent.status)) {
                        PaymentNotifications.notifyPaymentIntent(this, intent);
                    }
                }
            } catch (Exception ignored) {
            }
        }).start();
    }
}
