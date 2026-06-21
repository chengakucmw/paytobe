package ai.agentwallet.hd;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

final class PaymentNotifications {
    static final String PAYMENT_CHANNEL_ID = "agentwallet_payment_requests";
    static final String RELAY_CHANNEL_ID = "agentwallet_relay_status";
    static final int RELAY_FOREGROUND_ID = 1001;

    private static final String PREFS = "agentwallet_notification_state";

    private PaymentNotifications() {}

    static void ensureChannels(Context context) {
        NotificationManager manager = manager(context);

        NotificationChannel payments = new NotificationChannel(
                PAYMENT_CHANNEL_ID,
                "Payment Requests",
                NotificationManager.IMPORTANCE_HIGH
        );
        payments.setDescription("OpenClaw payment requests delivered through AgentWallet Relay.");
        manager.createNotificationChannel(payments);

        NotificationChannel relay = new NotificationChannel(
                RELAY_CHANNEL_ID,
                "Relay Connection",
                NotificationManager.IMPORTANCE_LOW
        );
        relay.setDescription("AgentWallet Relay listener status.");
        manager.createNotificationChannel(relay);
    }

    static boolean hasNotificationPermission(Context context) {
        return Build.VERSION.SDK_INT < 33
                || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    static void notifyPaymentIntent(Context context, PaymentIntent intent) {
        if (intent == null || intent.id.length() == 0) return;
        ensureChannels(context);

        // M8: de-duplicate by (id, status), not by id alone. The old code stored a
        // single boolean per request id, so the FIRST event won and every later
        // payment_request.status event (expired / cancelled / rejected / paid) was
        // silently dropped - the user kept staring at a stale "New payment request".
        // Now each distinct lifecycle status for a request is handled exactly once.
        String status = paymentStatus(intent);

        // A request that is no longer pending is not actionable, so its earlier
        // "New payment request" card is misleading and must be removed. Cancelling
        // needs no POST_NOTIFICATIONS permission, so do it before the permission gate.
        if (!isActionablePaymentStatus(status)) {
            if (markNotified(context, intent.id, status)) {
                cancelPaymentNotification(context, intent.id);
            }
            return;
        }

        if (!hasNotificationPermission(context)) return;
        if (!markNotified(context, intent.id, status)) return;

        Intent launch = new Intent(context, MainComposeActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(MainComposeActivity.EXTRA_OPEN_PAYMENT_INTENT_ID, intent.id);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                context,
                notificationId(intent.id),
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        String detail = intent.title() + " to " + shortAddress(intent.to);
        Notification notification = new Notification.Builder(context, PAYMENT_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_velarum)
                .setContentTitle("New payment request")
                .setContentText(detail)
                .setStyle(new Notification.BigTextStyle().bigText(
                        intent.title()
                                + "\n" + intent.sourceLabel()
                                + "\nNetwork: " + intent.network
                                + "\nRecipient: " + shortAddress(intent.to)
                ))
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .setPriority(Notification.PRIORITY_HIGH)
                .build();

        manager(context).notify(notificationId(intent.id), notification);
    }

    static Notification foregroundNotification(Context context) {
        ensureChannels(context);

        Intent launch = new Intent(context, MainComposeActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                context,
                RELAY_FOREGROUND_ID,
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new Notification.Builder(context, RELAY_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_velarum)
                .setContentTitle("AgentWallet relay connected")
                .setContentText("Listening for OpenClaw payment requests.")
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .setPriority(Notification.PRIORITY_LOW)
                .build();
    }

    /**
     * Records the last status we notified for {@code intentId} and returns true only
     * when this {@code status} differs from it. Keying on (id, status) - instead of a
     * bare per-id boolean - is what lets a later expired/cancelled/rejected event get
     * through to update or cancel the notification (bug M8). One String per id keeps
     * the stored state bounded.
     */
    private static boolean markNotified(Context context, String intentId, String status) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String key = "payment_status:" + intentId;
        String current = status == null ? "" : status;
        if (current.equals(prefs.getString(key, ""))) return false;
        prefs.edit().putString(key, current).apply();
        return true;
    }

    private static void cancelPaymentNotification(Context context, String intentId) {
        manager(context).cancel(notificationId(intentId));
    }

    private static String paymentStatus(PaymentIntent intent) {
        String status = intent == null ? "" : intent.status;
        return status == null || status.trim().length() == 0
                ? PaymentIntent.STATUS_PENDING
                : status.trim();
    }

    /** Only a still-pending request is actionable enough to show a payment card. */
    static boolean isActionablePaymentStatus(String status) {
        return PaymentIntent.STATUS_PENDING.equals(status);
    }

    private static int notificationId(String value) {
        int hash = value.hashCode();
        if (hash == Integer.MIN_VALUE) return 2000;
        return 2000 + Math.abs(hash % 1_000_000);
    }

    private static String shortAddress(String value) {
        // Delegates to the shared AddressFormat (D9/Q5) — unified 10…8 form.
        return AddressFormat.medium(value);
    }

    private static NotificationManager manager(Context context) {
        return (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    }
}
