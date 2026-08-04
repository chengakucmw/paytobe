package ai.agentwallet.hd;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.List;
import java.util.concurrent.TimeUnit;

/** Performs the authenticated REST compensation sync outside the short FCM callback window. */
public final class PaymentSyncWorker extends Worker {
    static final String UNIQUE_WORK_NAME = "velarumpay-payment-sync";
    static final int MAX_ATTEMPTS = 5;

    public PaymentSyncWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    static void enqueue(Context context) {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(PaymentSyncWorker.class)
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build();
        WorkManager.getInstance(context.getApplicationContext()).enqueueUniqueWork(
                UNIQUE_WORK_NAME,
                ExistingWorkPolicy.KEEP,
                request
        );
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            List<PaymentIntent> items = RelayClient.sync(getApplicationContext());
            for (PaymentIntent intent : items) {
                PaymentNotifications.notifyPaymentIntent(getApplicationContext(), intent);
            }
            List<ConnectInvitation> invitations = RelayClient.syncConnectInvitations(getApplicationContext());
            for (ConnectInvitation invitation : invitations) {
                PaymentNotifications.notifyConnectInvitation(getApplicationContext(), invitation);
            }
            return Result.success();
        } catch (Exception error) {
            VpLog.w("VelarumFcm", "authenticated REST compensation sync failed", error);
            return shouldRetry(getRunAttemptCount()) ? Result.retry() : Result.failure();
        }
    }

    static boolean shouldRetry(int runAttemptCount) {
        return runAttemptCount + 1 < MAX_ATTEMPTS;
    }
}
