package ai.agentwallet.hd;

import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import javax.crypto.spec.SecretKeySpec;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public final class SecureCredentialEnvelopeTest {
    private static final SecretKeySpec KEY = new SecretKeySpec(new byte[32], "AES");

    @Test
    public void envelopeIsVersionedAuthenticatedAndDoesNotContainPlaintext() throws Exception {
        String plaintext = "ct_private_connection_token";
        String envelope = SecureWalletStore.EnvelopeCodec.encrypt(KEY, plaintext, "slot-a");

        JSONObject json = new JSONObject(envelope);
        assertEquals(1, json.getInt("v"));
        assertEquals("A256GCM", json.getString("alg"));
        assertEquals(12, java.util.Base64.getDecoder().decode(json.getString("iv")).length);
        assertFalse(envelope.contains(plaintext));
        assertEquals(plaintext, SecureWalletStore.EnvelopeCodec.decrypt(KEY, envelope, "slot-a"));

        try {
            SecureWalletStore.EnvelopeCodec.decrypt(KEY, envelope, "slot-b");
            fail("AAD must bind ciphertext to its credential slot");
        } catch (Exception expected) {
            assertFalse(expected.getMessage() != null && expected.getMessage().contains(plaintext));
        }
    }

    @Test
    public void corruptedCiphertextFailsClosedWithoutLeakingSecret() throws Exception {
        String plaintext = "awt_private_device_token";
        String envelope = SecureWalletStore.EnvelopeCodec.encrypt(KEY, plaintext, "device");
        JSONObject json = new JSONObject(envelope);
        String ciphertext = json.getString("ct");
        json.put("ct", (ciphertext.startsWith("A") ? "B" : "A") + ciphertext.substring(1));

        try {
            SecureWalletStore.EnvelopeCodec.decrypt(KEY, json.toString(), "device");
            fail("tampered ciphertext must not decrypt");
        } catch (Exception expected) {
            assertFalse(String.valueOf(expected.getMessage()).contains(plaintext));
        }
    }

    @Test
    public void migrationWritesAndRereadsBeforeDeletingLegacyValue() {
        RecordingMigration io = new RecordingMigration();
        SecureWalletStore.migrateLegacy("legacy-secret", io);

        assertEquals(List.of("write", "read", "clear-legacy", "has-legacy"), io.events);
        assertFalse(io.legacyPresent);
        assertEquals("legacy-secret", io.ciphertext);
    }

    @Test
    public void failedMigrationDeletesCiphertextAndLegacyPlaintext() {
        RecordingMigration io = new RecordingMigration();
        io.rereadOverride = "wrong-value";

        try {
            SecureWalletStore.migrateLegacy("legacy-secret", io);
            fail("verification mismatch must fail migration");
        } catch (SecureWalletStore.CredentialStorageException expected) {
            assertEquals("Secure credential migration failed; reconnect required.", expected.getMessage());
        }

        assertTrue(io.events.contains("clear-ciphertext"));
        assertTrue(io.events.contains("clear-legacy"));
        assertFalse(io.legacyPresent);
        assertNull(io.ciphertext);
    }

    private static final class RecordingMigration implements SecureWalletStore.MigrationIo {
        final List<String> events = new ArrayList<>();
        boolean legacyPresent = true;
        String ciphertext;
        String rereadOverride;

        @Override public void writeCiphertext(String value) {
            events.add("write");
            ciphertext = value;
        }

        @Override public String readCiphertext() {
            events.add("read");
            return rereadOverride == null ? ciphertext : rereadOverride;
        }

        @Override public void clearCiphertext() {
            events.add("clear-ciphertext");
            ciphertext = null;
        }

        @Override public void clearLegacy() {
            events.add("clear-legacy");
            legacyPresent = false;
        }

        @Override public boolean hasLegacy() {
            events.add("has-legacy");
            return legacyPresent;
        }
    }
}
