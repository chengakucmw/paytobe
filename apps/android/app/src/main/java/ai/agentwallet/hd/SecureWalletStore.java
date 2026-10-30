package ai.agentwallet.hd;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

import org.json.JSONObject;

final class SecureWalletStore {
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "agentwallet_hd_transfer_v1_aes";
    static final String CREDENTIAL_KEY_ALIAS = "Paytobe_credential_wrap_v1_aes";
    private static final String PREFS = "agentwallet_hd_transfer_store";
    private static final String PREF_IV = "wallet_iv";
    private static final String PREF_CT = "wallet_ciphertext";
    private static final String PREF_BACKUP_VERIFIED = "wallet_backup_verified";

    private static final String CREDENTIAL_PREFS = "Paytobe_secure_credentials_v1";
    private static final String PREF_WRAPPED_APP_KEY = "wrapped_app_key_v1";
    private static final String SLOT_DEVICE_TOKEN = "device_token_v1";
    private static final String SLOT_CONNECTION_RECORDS = "connection_records_v1";
    private static final String LEGACY_DEVICE_PREFS = "agentwallet_payment_inbox";
    private static final String LEGACY_DEVICE_TOKEN = "device_token";
    private static final String LEGACY_CONNECTION_PREFS = "agentwallet_agent_connections";
    private static final String LEGACY_CONNECTIONS = "connections";
    private static final String APP_KEY_AAD = "Paytobe.credentials.app-key.v1";
    private static final String VALUE_AAD_PREFIX = "Paytobe.credentials.value.v1:";
    private static final SecureRandom RANDOM = new SecureRandom();

    private SecureWalletStore() {}

    static void save(Context context, String plaintext) throws Exception {
        save(context, plaintext, false);
    }

    static void save(Context context, String plaintext, boolean backupVerified) throws Exception {
        SecretKey key = getOrCreateKey();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(PREF_IV, encode(cipher.getIV()))
                .putString(PREF_CT, encode(ciphertext))
                .putBoolean(PREF_BACKUP_VERIFIED, backupVerified)
                .apply();
    }

    static String load(Context context) throws Exception {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String ivText = prefs.getString(PREF_IV, null);
        String ctText = prefs.getString(PREF_CT, null);
        if (ivText == null || ctText == null) return null;
        SecretKey key = getOrCreateKey();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, decode(ivText)));
        return new String(cipher.doFinal(decode(ctText)), StandardCharsets.UTF_8);
    }

    static void clear(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        clearCredentials(context);
    }

    static boolean hasWallet(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).contains(PREF_CT);
    }

    static boolean isBackupVerified(Context context) {
        return hasWallet(context)
                && context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(PREF_BACKUP_VERIFIED, false);
    }

    static void markBackupVerified(Context context) {
        if (!hasWallet(context)) return;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean(PREF_BACKUP_VERIFIED, true)
                .apply();
    }

    /**
     * Returns the app authentication token from encrypted storage. A legacy plaintext
     * value is migrated exactly once; a failed migration deletes both copies and makes
     * the caller re-register this app installation.
     */
    static synchronized String deviceToken(Context context) {
        String token = readOrMigrate(
                context,
                SLOT_DEVICE_TOKEN,
                legacy(context, LEGACY_DEVICE_PREFS, LEGACY_DEVICE_TOKEN)
        );
        if (token != null && !token.isEmpty()) return token;
        String generated = "awt_" + java.util.UUID.randomUUID().toString().replace("-", "");
        putCredential(context, SLOT_DEVICE_TOKEN, generated);
        return generated;
    }

    /** A non-secret fingerprint suitable for the developer diagnostics screen. */
    static String deviceTokenLabel(Context context) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(deviceToken(context).getBytes(StandardCharsets.UTF_8));
            StringBuilder fingerprint = new StringBuilder();
            for (int i = 0; i < 4; i++) fingerprint.append(String.format("%02x", digest[i] & 0xff));
            return "Stored securely · " + fingerprint;
        } catch (CredentialStorageException unavailable) {
            return "Reconnect required";
        } catch (Exception unavailable) {
            return "Unavailable";
        }
    }

    static synchronized String connectionRecords(Context context) {
        String raw = readOrMigrate(
                context,
                SLOT_CONNECTION_RECORDS,
                legacy(context, LEGACY_CONNECTION_PREFS, LEGACY_CONNECTIONS)
        );
        return raw == null || raw.trim().isEmpty() ? "[]" : raw;
    }

    static synchronized void saveConnectionRecords(Context context, String records) {
        LegacyValue legacy = legacy(context, LEGACY_CONNECTION_PREFS, LEGACY_CONNECTIONS);
        try {
            putCredential(context, SLOT_CONNECTION_RECORDS, records == null ? "[]" : records);
            removeLegacyOrThrow(legacy);
        } catch (CredentialStorageException error) {
            clearFailedCredential(context, SLOT_CONNECTION_RECORDS, legacy);
            throw error;
        }
    }

    static synchronized void clearConnectionRecords(Context context) {
        securePrefs(context).edit().remove(SLOT_CONNECTION_RECORDS).commit();
        legacy(context, LEGACY_CONNECTION_PREFS, LEGACY_CONNECTIONS).clear();
    }

    /** Clears wallet-adjacent credentials on wallet reset or local account removal. */
    static synchronized void clearCredentials(Context context) {
        securePrefs(context).edit().clear().commit();
        legacy(context, LEGACY_DEVICE_PREFS, LEGACY_DEVICE_TOKEN).clear();
        legacy(context, LEGACY_CONNECTION_PREFS, LEGACY_CONNECTIONS).clear();
    }

    static boolean credentialKeyRequiresUserAuthentication() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        if (!keyStore.containsAlias(CREDENTIAL_KEY_ALIAS)) return false;
        SecretKey key = ((KeyStore.SecretKeyEntry) keyStore.getEntry(CREDENTIAL_KEY_ALIAS, null)).getSecretKey();
        SecretKeyFactory factory = SecretKeyFactory.getInstance(key.getAlgorithm(), ANDROID_KEYSTORE);
        KeyInfo info = (KeyInfo) factory.getKeySpec(key, KeyInfo.class);
        return info.isUserAuthenticationRequired();
    }

    private static String readOrMigrate(Context context, String slot, LegacyValue legacy) {
        SharedPreferences prefs = securePrefs(context);
        if (prefs.contains(slot)) {
            try {
                String value = decryptCredential(context, slot, prefs.getString(slot, null));
                removeLegacyOrThrow(legacy);
                return value;
            } catch (CredentialStorageException error) {
                clearFailedCredential(context, slot, legacy);
                throw error;
            } catch (Exception error) {
                clearFailedCredential(context, slot, legacy);
                throw new CredentialStorageException("Secure credentials are unavailable; reconnect required.", error);
            }
        }

        String plaintext = legacy.read();
        if (plaintext == null || plaintext.isEmpty()) return null;
        migrateLegacy(plaintext, new MigrationIo() {
            @Override public void writeCiphertext(String value) {
                putCredential(context, slot, value);
            }

            @Override public String readCiphertext() throws Exception {
                return decryptCredential(context, slot, securePrefs(context).getString(slot, null));
            }

            @Override public void clearCiphertext() {
                securePrefs(context).edit().remove(slot).commit();
            }

            @Override public void clearLegacy() {
                legacy.clear();
            }

            @Override public boolean hasLegacy() {
                return legacy.exists();
            }
        });
        return plaintext;
    }

    static void migrateLegacy(String plaintext, MigrationIo io) {
        try {
            io.writeCiphertext(plaintext);
            String reread = io.readCiphertext();
            if (!constantTimeEquals(plaintext, reread)) {
                throw new IllegalStateException("Credential verification failed");
            }
            io.clearLegacy();
            if (io.hasLegacy()) throw new IllegalStateException("Legacy credential deletion failed");
        } catch (Exception migrationFailure) {
            try { io.clearCiphertext(); } catch (Exception ignored) { /* fail closed below */ }
            try { io.clearLegacy(); } catch (Exception ignored) { /* fail closed below */ }
            throw new CredentialStorageException(
                    "Secure credential migration failed; reconnect required.",
                    migrationFailure
            );
        }
    }

    private static void putCredential(Context context, String slot, String plaintext) {
        try {
            SecretKey appKey = getOrCreateCredentialAppKey(context);
            String envelope = EnvelopeCodec.encrypt(appKey, plaintext, VALUE_AAD_PREFIX + slot);
            if (!securePrefs(context).edit().putString(slot, envelope).commit()) {
                throw new IllegalStateException("Credential commit failed");
            }
            String reread = decryptCredential(context, slot, securePrefs(context).getString(slot, null));
            if (!constantTimeEquals(plaintext, reread)) {
                throw new IllegalStateException("Credential verification failed");
            }
        } catch (CredentialStorageException error) {
            securePrefs(context).edit().remove(slot).commit();
            throw error;
        } catch (Exception error) {
            securePrefs(context).edit().remove(slot).commit();
            throw new CredentialStorageException("Secure credentials are unavailable; reconnect required.", error);
        }
    }

    private static String decryptCredential(Context context, String slot, String envelope) throws Exception {
        if (envelope == null || envelope.isEmpty()) throw new IllegalStateException("Credential envelope missing");
        SecretKey appKey = credentialAppKey(context, false);
        if (appKey == null) throw new IllegalStateException("Wrapped application key missing");
        return EnvelopeCodec.decrypt(appKey, envelope, VALUE_AAD_PREFIX + slot);
    }

    private static SecretKey getOrCreateCredentialAppKey(Context context) throws Exception {
        SecretKey existing = credentialAppKey(context, false);
        if (existing != null) return existing;

        byte[] raw = new byte[32];
        RANDOM.nextBytes(raw);
        SecretKey appKey = new SecretKeySpec(raw, "AES");
        String wrapped = EnvelopeCodec.encrypt(getOrCreateCredentialWrappingKey(), encode(raw), APP_KEY_AAD);
        java.util.Arrays.fill(raw, (byte) 0);
        if (!securePrefs(context).edit().putString(PREF_WRAPPED_APP_KEY, wrapped).commit()) {
            throw new IllegalStateException("Wrapped application key commit failed");
        }
        SecretKey reread = credentialAppKey(context, false);
        if (reread == null || !MessageDigest.isEqual(appKey.getEncoded(), reread.getEncoded())) {
            securePrefs(context).edit().remove(PREF_WRAPPED_APP_KEY).commit();
            throw new IllegalStateException("Wrapped application key verification failed");
        }
        return reread;
    }

    private static SecretKey credentialAppKey(Context context, boolean unused) throws Exception {
        String wrapped = securePrefs(context).getString(PREF_WRAPPED_APP_KEY, null);
        if (wrapped == null || wrapped.isEmpty()) return null;
        try {
            String encoded = EnvelopeCodec.decrypt(getOrCreateCredentialWrappingKey(), wrapped, APP_KEY_AAD);
            byte[] raw = decode(encoded);
            if (raw.length != 32) throw new IllegalStateException("Invalid application key length");
            SecretKey key = new SecretKeySpec(raw, "AES");
            java.util.Arrays.fill(raw, (byte) 0);
            return key;
        } catch (Exception error) {
            clearCredentials(context);
            throw error;
        }
    }

    private static void clearFailedCredential(Context context, String slot, LegacyValue legacy) {
        securePrefs(context).edit().remove(slot).commit();
        legacy.clear();
    }

    private static void removeLegacyOrThrow(LegacyValue legacy) {
        if (!legacy.exists()) return;
        legacy.clear();
        if (legacy.exists()) {
            throw new CredentialStorageException("Legacy credential deletion failed; reconnect required.");
        }
    }

    private static LegacyValue legacy(Context context, String prefsName, String key) {
        return new LegacyValue(context.getSharedPreferences(prefsName, Context.MODE_PRIVATE), key);
    }

    private static SharedPreferences securePrefs(Context context) {
        return context.getSharedPreferences(CREDENTIAL_PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey getOrCreateCredentialWrappingKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        if (keyStore.containsAlias(CREDENTIAL_KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(CREDENTIAL_KEY_ALIAS, null)).getSecretKey();
        }
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
            try {
                return generateKey(CREDENTIAL_KEY_ALIAS, true);
            } catch (Exception strongBoxUnavailable) {
                try {
                    keyStore.deleteEntry(CREDENTIAL_KEY_ALIAS);
                } catch (Exception ignored) {
                    VpLog.w("SecureWalletStore", "best-effort credential alias cleanup failed", ignored);
                }
            }
        }
        return generateKey(CREDENTIAL_KEY_ALIAS, false);
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        // Hardening: bind the wallet-encryption key to the device's tamper-resistant
        // StrongBox secure element when available (API 28+). Many devices ship without
        // StrongBox, so fall back to the normal hardware-backed keystore. This only
        // affects NEWLY created wallets — an existing key keeps working unchanged, so
        // there is no migration and no risk of locking anyone out of their funds.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
            try {
                return generateKey(KEY_ALIAS, true);
            } catch (Exception strongBoxUnavailable) {
                // StrongBoxUnavailableException / no secure element: drop any
                // half-created alias and retry without StrongBox.
                try {
                    keyStore.deleteEntry(KEY_ALIAS);
                } catch (Exception ignored) {
                    VpLog.w("SecureWalletStore", "best-effort delete of half-created key alias failed", ignored);
                }
            }
        }
        return generateKey(KEY_ALIAS, false);
    }

    private static SecretKey generateKey(String alias, boolean strongBox) throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        KeyGenParameterSpec.Builder builder = new KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true);
        if (strongBox && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
            builder.setIsStrongBoxBacked(true);
        }
        generator.init(builder.build());
        return generator.generateKey();
    }

    private static boolean constantTimeEquals(String left, String right) {
        if (left == null || right == null) return false;
        return MessageDigest.isEqual(
                left.getBytes(StandardCharsets.UTF_8),
                right.getBytes(StandardCharsets.UTF_8)
        );
    }

    private static String encode(byte[] bytes) {
        return Base64.getEncoder().withoutPadding().encodeToString(bytes);
    }

    private static byte[] decode(String value) {
        return Base64.getDecoder().decode(value);
    }

    interface MigrationIo {
        void writeCiphertext(String value) throws Exception;
        String readCiphertext() throws Exception;
        void clearCiphertext() throws Exception;
        void clearLegacy() throws Exception;
        boolean hasLegacy() throws Exception;
    }

    static final class CredentialStorageException extends IllegalStateException {
        CredentialStorageException(String message) {
            super(message);
        }

        CredentialStorageException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    private static final class LegacyValue {
        private final SharedPreferences preferences;
        private final String key;

        LegacyValue(SharedPreferences preferences, String key) {
            this.preferences = preferences;
            this.key = key;
        }

        String read() {
            return preferences.getString(key, null);
        }

        boolean exists() {
            return preferences.contains(key);
        }

        void clear() {
            preferences.edit().remove(key).commit();
        }
    }

    static final class EnvelopeCodec {
        private EnvelopeCodec() {}

        static String encrypt(SecretKey key, String plaintext, String aad) throws Exception {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            // AndroidKeyStore keys created with randomized encryption reject a
            // caller-provided IV. Let the provider generate it for encryption and
            // persist that IV in the envelope; decryption continues to use the
            // stored IV and remains compatible with existing envelopes.
            cipher.init(Cipher.ENCRYPT_MODE, key);
            byte[] iv = cipher.getIV();
            if (iv == null || iv.length != 12) {
                throw new IllegalStateException("Invalid generated credential IV");
            }
            cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
            byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            return new JSONObject()
                    .put("v", 1)
                    .put("alg", "A256GCM")
                    .put("iv", encode(iv))
                    .put("ct", encode(ciphertext))
                    .toString();
        }

        static String decrypt(SecretKey key, String envelope, String aad) throws Exception {
            JSONObject json = new JSONObject(envelope);
            if (json.optInt("v", 0) != 1 || !"A256GCM".equals(json.optString("alg", ""))) {
                throw new IllegalArgumentException("Unsupported credential envelope");
            }
            byte[] iv = decode(json.getString("iv"));
            if (iv.length != 12) throw new IllegalArgumentException("Invalid credential IV");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
            cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
            return new String(cipher.doFinal(decode(json.getString("ct"))), StandardCharsets.UTF_8);
        }
    }
}
