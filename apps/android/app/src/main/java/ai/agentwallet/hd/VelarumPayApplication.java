package ai.agentwallet.hd;

import android.app.Application;

public final class VelarumPayApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        PaymentNotifications.ensureChannels(this);
        FirebaseBootstrap.initialize(this);
    }
}
