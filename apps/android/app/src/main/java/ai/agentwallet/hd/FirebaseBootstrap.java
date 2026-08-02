package ai.agentwallet.hd;

import android.content.Context;

import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;

final class FirebaseBootstrap {
    private static volatile boolean initialized;

    private FirebaseBootstrap() {}

    static synchronized boolean initialize(Context context) {
        if (initialized) return true;
        if (!hasCompleteConfiguration()) {
            VpLog.d("FirebaseBootstrap", "FCM is disabled because Firebase build configuration is incomplete");
            return false;
        }
        Context appContext = context.getApplicationContext();
        if (FirebaseApp.getApps(appContext).isEmpty()) {
            FirebaseOptions options = new FirebaseOptions.Builder()
                    .setApplicationId(BuildConfig.FIREBASE_APPLICATION_ID)
                    .setApiKey(BuildConfig.FIREBASE_API_KEY)
                    .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
                    .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
                    .build();
            FirebaseApp.initializeApp(appContext, options);
        }
        initialized = true;
        registerCurrentToken(appContext);
        return true;
    }

    static void registerCurrentToken(Context context) {
        if (!initialized) {
            initialize(context);
            return;
        }
        if (PaymentInboxStore.relayUrl(context).trim().isEmpty()) return;
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (!task.isSuccessful() || task.getResult() == null || task.getResult().trim().isEmpty()) {
                VpLog.w("FirebaseBootstrap", "FCM registration token is unavailable", task.getException());
                return;
            }
            registerTokenWithRelay(context.getApplicationContext(), task.getResult());
        });
    }

    static void registerTokenWithRelay(Context context, String token) {
        if (token == null || token.trim().isEmpty()) return;
        new Thread(() -> {
            try {
                RelayClient.registerPushToken(context, token.trim());
            } catch (Exception error) {
                VpLog.w("FirebaseBootstrap", "FCM token registration with relay failed", error);
            }
        }, "velarumpay-fcm-register").start();
    }

    static boolean isConfigured() {
        return hasCompleteConfiguration();
    }

    private static boolean hasCompleteConfiguration() {
        return !BuildConfig.FIREBASE_APPLICATION_ID.trim().isEmpty()
                && !BuildConfig.FIREBASE_API_KEY.trim().isEmpty()
                && !BuildConfig.FIREBASE_PROJECT_ID.trim().isEmpty()
                && !BuildConfig.FIREBASE_SENDER_ID.trim().isEmpty();
    }
}
