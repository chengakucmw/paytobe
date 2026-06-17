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
        if (!hasNotificationPermission(context)) return;
        if (!markNotified(context, intent.id)) return;

        Intent launch = new Intent(context, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(MainActivity.EXTRA_OPEN_PAYMENT_INTENT_ID, intent.id);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                context,
                notificationId(intent.id),
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        String detail = intent.title() + " to " + shortAddress(intent.to);
        Notification notification = new Notification.Builder(context, PAYMENT_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
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

        Intent launch = new Intent(context, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                context,
                RELAY_FOREGROUND_ID,
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new Notification.Builder(context, RELAY_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("AgentWallet relay connected")
                .setContentText("Listening for OpenClaw payment requests.")
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .setPriority(Notification.PRIORITY_LOW)
                .build();
    }

    private static boolean markNotified(Context context, String intentId) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String key = "payment:" + intentId;
        if (prefs.getBoolean(key, false)) return false;
        prefs.edit().putBoolean(key, true).apply();
        return true;
    }

    private static int notificationId(String value) {
        int hash = value.hashCode();
        if (hash == Integer.MIN_VALUE) return 2000;
        return 2000 + Math.abs(hash % 1_000_000);
    }

    private static String shortAddress(String value) {
        if (value == null) return "";
        if (value.length() <= 18) return value;
        return value.substring(0, 10) + "..." + value.substring(value.length() - 8);
    }

    private static NotificationManager manager(Context context) {
        return (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    }
}
