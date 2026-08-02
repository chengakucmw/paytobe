package ai.agentwallet.hd;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.os.Bundle;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.Arrays;
import java.util.Map;

/**
 * Dependency-free on-device credential checks. The project uses Android's built-in
 * instrumentation transport, so these Keystore tests do not add a test framework or
 * alter the reviewed dependency graph.
 */
public final class SecureCredentialInstrumentation extends Instrumentation {
    private static final String SECURE_PREFS = "velarumpay_secure_credentials_v1";
    private static final String LEGACY_DEVICE_PREFS = "agentwallet_payment_inbox";
    private static final String LEGACY_CONNECTION_PREFS = "agentwallet_agent_connections";
    private static final int TEST_COUNT = 7;

    private Context appContext;
    private int current;
    private int failures;

    @Override
    public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        start();
    }

    @Override
    public void onStart() {
        appContext = getTargetContext().getApplicationContext();
        runCase("freshInstallAndProcessRestart", this::freshInstallAndProcessRestart);
        runCase("legacyMigration", this::legacyMigration);
        runCase("revocationClearsConnectionToken", this::revocationClearsConnectionToken);
        runCase("corruptCiphertextFailsClosed", this::corruptCiphertextFailsClosed);
        runCase("lockedDeviceKeyPolicyAndWalletClear", this::lockedDeviceKeyPolicyAndWalletClear);
        runCase("fcmHintIgnoresPaymentFacts", this::fcmHintIgnoresPaymentFacts);
        runCase("restEventCursorDeduplicates", this::restEventCursorDeduplicates);

        Bundle result = new Bundle();
        result.putString("stream", failures == 0
                ? "\nOK (" + TEST_COUNT + " secure credential tests)\n"
                : "\nFAILURES: " + failures + " of " + TEST_COUNT + " secure credential tests\n");
        finish(failures == 0 ? Activity.RESULT_OK : Activity.RESULT_CANCELED, result);
    }

    private void runCase(String name, CheckedCase test) {
        current += 1;
        Bundle start = status(name);
        start.putString("stream", "\nai.agentwallet.hd.SecureCredentialInstrumentation:" + name);
        sendStatus(1, start);
        try {
            SecureWalletStore.clearCredentials(appContext);
            test.run();
            sendStatus(0, status(name));
        } catch (Throwable failure) {
            failures += 1;
            Bundle failed = status(name);
            failed.putString("stack", failure.getClass().getSimpleName() + ": secure credential assertion failed");
            failed.putString("stream", "\nFailure in " + name + "\n");
            sendStatus(-2, failed);
        }
    }

    private Bundle status(String name) {
        Bundle bundle = new Bundle();
        bundle.putString("id", "VelarumPaySecureCredentials");
        bundle.putString("class", getClass().getName());
        bundle.putString("test", name);
        bundle.putInt("current", current);
        bundle.putInt("numtests", TEST_COUNT);
        return bundle;
    }

    private void freshInstallAndProcessRestart() {
        String first = SecureWalletStore.deviceToken(appContext);
        String second = SecureWalletStore.deviceToken(appContext);
        check(first.equals(second));
        check(!appContext.getSharedPreferences(LEGACY_DEVICE_PREFS, Context.MODE_PRIVATE)
                .contains("device_token"));
        String persisted = appContext.getSharedPreferences(SECURE_PREFS, Context.MODE_PRIVATE)
                .getString("device_token_v1", "");
        check(persisted.contains("\"v\":1"));
        check(!persisted.contains(first));
    }

    private void legacyMigration() {
        String deviceToken = "awt_legacy_private";
        String connectionToken = "ct_legacy_private";
        appContext.getSharedPreferences(LEGACY_DEVICE_PREFS, Context.MODE_PRIVATE)
                .edit().putString("device_token", deviceToken).commit();
        String records = "[{\"connection_id\":\"con_1\",\"connection_token\":\""
                + connectionToken + "\",\"status\":\"active\"}]";
        appContext.getSharedPreferences(LEGACY_CONNECTION_PREFS, Context.MODE_PRIVATE)
                .edit().putString("connections", records).commit();

        check(deviceToken.equals(SecureWalletStore.deviceToken(appContext)));
        check(connectionToken.equals(AgentConnectionStore.list(appContext).get(0).connectionToken));
        check(!appContext.getSharedPreferences(LEGACY_DEVICE_PREFS, Context.MODE_PRIVATE)
                .contains("device_token"));
        check(!appContext.getSharedPreferences(LEGACY_CONNECTION_PREFS, Context.MODE_PRIVATE)
                .contains("connections"));
        String secureValues = appContext.getSharedPreferences(SECURE_PREFS, Context.MODE_PRIVATE)
                .getAll().toString();
        check(!secureValues.contains(deviceToken));
        check(!secureValues.contains(connectionToken));
    }

    private void revocationClearsConnectionToken() throws Exception {
        AgentConnectionStore.upsert(appContext, AgentConnection.parse(new JSONObject()
                .put("connection_id", "con_revoke")
                .put("connection_token", "ct_revoke_private")
                .put("status", "active")));
        AgentConnectionStore.updateStatus(appContext, "con_revoke", "revoked");
        AgentConnection revoked = AgentConnectionStore.find(appContext, "con_revoke");
        check(revoked != null && revoked.isRevoked());
        check(revoked.connectionToken.isEmpty());
        check(!appContext.getSharedPreferences(SECURE_PREFS, Context.MODE_PRIVATE)
                .getAll().toString().contains("ct_revoke_private"));
    }

    private void corruptCiphertextFailsClosed() {
        SecureWalletStore.deviceToken(appContext);
        appContext.getSharedPreferences(SECURE_PREFS, Context.MODE_PRIVATE)
                .edit().putString("device_token_v1", "not-an-envelope").commit();
        boolean failedClosed = false;
        try {
            SecureWalletStore.deviceToken(appContext);
        } catch (SecureWalletStore.CredentialStorageException expected) {
            failedClosed = true;
        }
        check(failedClosed);
        check(!appContext.getSharedPreferences(SECURE_PREFS, Context.MODE_PRIVATE)
                .contains("device_token_v1"));
        check(!appContext.getSharedPreferences(LEGACY_DEVICE_PREFS, Context.MODE_PRIVATE)
                .contains("device_token"));
    }

    private void lockedDeviceKeyPolicyAndWalletClear() throws Exception {
        SecureWalletStore.deviceToken(appContext);
        AgentConnectionStore.upsert(appContext, AgentConnection.parse(new JSONObject()
                .put("connection_id", "con_clear")
                .put("connection_token", "ct_clear_private")
                .put("status", "active")));
        // No authentication window means background REST recovery remains possible when
        // the screen is locked; the Keystore key still never leaves AndroidKeyStore.
        check(!SecureWalletStore.credentialKeyRequiresUserAuthentication());
        SecureWalletStore.clear(appContext);
        check(appContext.getSharedPreferences(SECURE_PREFS, Context.MODE_PRIVATE).getAll().isEmpty());
        check(AgentConnectionStore.list(appContext).isEmpty());
    }

    private void fcmHintIgnoresPaymentFacts() {
        Map<String, String> data = new HashMap<>();
        data.put("type", "velarumpay.sync");
        data.put("sync_required", "true");
        data.put("request_id", "prq_instrumentation");
        data.put("amount", "999");
        data.put("recipient", "not-authoritative");
        data.put("status", "confirmed");
        VelarumFirebaseMessagingService.PushHintDecision decision =
                VelarumFirebaseMessagingService.evaluateData(data);
        check(decision.syncRequired);
        check(decision.ignoredFields);
        check("prq_instrumentation".equals(decision.requestId));
    }

    private void restEventCursorDeduplicates() throws Exception {
        org.json.JSONArray events = new org.json.JSONArray()
                .put(new JSONObject().put("seq", 11).put("type", "payment_request.created").put("request_id", "prq_a"))
                .put(new JSONObject().put("seq", 12).put("type", "payment_request.status").put("request_id", "prq_a"))
                .put(new JSONObject().put("seq", 13).put("type", "payment_request.created").put("request_id", "prq_b"));
        RelayClient.RestSyncPlan plan = RelayClient.planRestSync(new JSONObject()
                .put("latest_seq", 13)
                .put("reset_required", false)
                .put("items", events), 10);
        check(!plan.fullRefresh);
        check(plan.latestSeq == 13L);
        check(plan.requestIds.equals(Arrays.asList("prq_a", "prq_b")));
    }

    private static void check(boolean condition) {
        if (!condition) throw new AssertionError("secure credential assertion failed");
    }

    private interface CheckedCase {
        void run() throws Exception;
    }
}
