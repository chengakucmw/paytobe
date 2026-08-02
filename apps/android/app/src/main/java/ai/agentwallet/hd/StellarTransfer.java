package ai.agentwallet.hd;

import java.util.Base64;

import org.bouncycastle.crypto.digests.SHA256Digest;
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InterruptedIOException;
import java.math.BigDecimal;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

final class StellarTransfer {
    private static final OkHttpClient HTTP = WalletHttp.oneShot();
    private static final MediaType FORM = MediaType.get("application/x-www-form-urlencoded");
    private static final String TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
    private static final String PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015";
    private static final long FALLBACK_MIN_CREATE_ACCOUNT_STROOPS = 10_000_000L;

    /**
     * When true (default), the transaction is built + signed by the shared Rust
     * core (crates/velarum-wallet-core) via WalletCoreBridge; when false, by the
     * native path below. A cross-check test asserts identical transaction hashes,
     * so this preserves behaviour. Network I/O stays native. Set false to revert.
     */
    static boolean USE_SHARED_CORE_SIGNING = true;

    private StellarTransfer() {}

    static String sendXlm(
            String horizonUrl,
            boolean testnet,
            byte[] sourceSeed,
            byte[] sourcePublic,
            String destinationAddress,
            String amountXlm
    ) throws Exception {
        return sendXlm(horizonUrl, testnet, sourceSeed, sourcePublic, destinationAddress, amountXlm, null);
    }

    static String sendXlm(
            String horizonUrl,
            boolean testnet,
            byte[] sourceSeed,
            byte[] sourcePublic,
            String destinationAddress,
            String amountXlm,
            TransactionProgress progress
    ) throws Exception {
        return sendXlm(horizonUrl, testnet, sourceSeed, sourcePublic, destinationAddress, amountXlm, progress, "");
    }

    static String sendXlm(
            String horizonUrl,
            boolean testnet,
            byte[] sourceSeed,
            byte[] sourcePublic,
            String destinationAddress,
            String amountXlm,
            TransactionProgress progress,
            String memo
    ) throws Exception {
        return sendXlm(horizonUrl, testnet, sourceSeed, sourcePublic, destinationAddress, amountXlm, progress, memo, "");
    }

    static String sendXlm(
            String horizonUrl,
            boolean testnet,
            byte[] sourceSeed,
            byte[] sourcePublic,
            String destinationAddress,
            String amountXlm,
            TransactionProgress progress,
            String memo,
            String memoType
    ) throws Exception {
        horizonUrl = normalizeHorizonUrl(horizonUrl, testnet);
        // Final fail-closed check immediately before sequence lookup, signing, and
        // broadcast. Testnet is unaffected; public-network use is build-gated.
        StellarMainnetPolicy.assertAllowed(testnet, horizonUrl, destinationAddress, amountXlm);
        // M-3: defense in depth at the signing boundary. The passphrase chosen later
        // (mainnet = real funds, testnet = test funds) MUST agree with the Horizon
        // host we are about to broadcast to. Refuse to sign if a recognized host
        // contradicts the testnet flag, mirroring iOS StellarService.assertNetworkConsistency.
        assertNetworkConsistency(horizonUrl, testnet);
        String sourceAddress = StellarStrKey.encodePublicKey(sourcePublic);
        long sequence = fetchSequence(horizonUrl, sourceAddress) + 1;
        StellarStrKey.decodePublicKey(destinationAddress); // validate destination up front
        long amount = xlmToStroops(amountXlm);
        boolean createAccount = fetchAccount(horizonUrl, destinationAddress) == null;
        if (createAccount) {
            long minimum = fetchMinimumCreateAccountBalanceStroops(horizonUrl);
            if (amount < minimum) {
                throw new IllegalStateException(
                        "Recipient Stellar account is not activated on this network. "
                                + "Send at least " + stroopsToXlm(minimum)
                                + " XLM to create it, or ask the recipient to activate the account first."
                );
            }
        }
        SignedEnvelope signed = buildSignedEnvelope(sourceSeed, sourcePublic, sequence, destinationAddress, amountXlm, createAccount, memo, memoType, testnet);
        String envelope64 = signed.envelope64;
        String txHash = signed.txHash;
        if (progress != null) progress.onGenerated("Signed Stellar transaction");
        String body = "tx=" + URLEncoder.encode(envelope64, "UTF-8");
        Request request = new Request.Builder()
                .url(horizonUrl + "/transactions")
                .post(RequestBody.create(body, FORM))
                .build();
        try (Response response = HTTP.newCall(request).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) throw new IllegalStateException(stellarErrorMessage(response.code(), text));
            JSONObject json = new JSONObject(text);
            return json.optString("hash", txHash);
        } catch (InterruptedIOException e) {
            if (waitForTransaction(horizonUrl, txHash)) return txHash;
            throw new IllegalStateException("Stellar submission timed out. Transaction hash may be pending: " + txHash, e);
        }
    }

    static void requireDestinationCanReceiveAsset(
            String horizonUrl,
            boolean testnet,
            String destinationAddress,
            String assetCode,
            String assetIssuer
    ) throws Exception {
        horizonUrl = normalizeHorizonUrl(horizonUrl, testnet);
        StellarStrKey.decodePublicKey(destinationAddress);
        JSONObject destination = fetchAccount(horizonUrl, destinationAddress);
        if (destination == null) {
            throw new IllegalStateException(
                    "Recipient Stellar account is not activated on this network. "
                            + "Non-XLM Stellar assets require an existing account before payment."
            );
        }
        if ("XLM".equalsIgnoreCase(assetCode)) return;
        if (assetIssuer == null || assetIssuer.trim().length() == 0) {
            throw new IllegalStateException("Stellar " + assetCode + " issuer is required before checking recipient trustline.");
        }
        StellarStrKey.decodePublicKey(assetIssuer);
        if (!hasTrustline(destination, assetCode, assetIssuer)) {
            throw new IllegalStateException(
                    "Recipient Stellar account does not have a trustline for "
                            + assetCode + ":" + assetIssuer
                            + ". Ask the recipient to add the trustline before sending."
            );
        }
    }

    private static long fetchSequence(String horizonUrl, String accountId) throws Exception {
        JSONObject account = fetchAccount(horizonUrl, accountId);
        if (account == null) {
            throw new IllegalStateException("Source Stellar account is not activated on this network. Fund it with XLM before sending.");
        }
        return Long.parseLong(account.getString("sequence"));
    }

    private static JSONObject fetchAccount(String horizonUrl, String accountId) throws Exception {
        Request request = new Request.Builder().url(horizonUrl + "/accounts/" + accountId).get().build();
        try (Response response = HTTP.newCall(request).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (response.code() == 404) return null;
            if (!response.isSuccessful()) throw new IllegalStateException(stellarErrorMessage(response.code(), text));
            return new JSONObject(text);
        }
    }

    private static boolean waitForTransaction(String horizonUrl, String txHash) throws Exception {
        for (int i = 0; i < 8; i++) {
            Thread.sleep(1500);
            Request request = new Request.Builder().url(horizonUrl + "/transactions/" + txHash).get().build();
            try (Response response = HTTP.newCall(request).execute()) {
                String text = response.body() == null ? "" : response.body().string();
                if (response.code() == 404) continue;
                if (!response.isSuccessful()) continue;
                return new JSONObject(text).optBoolean("successful", false);
            }
        }
        return false;
    }

    /** Pure (no network) build-and-sign, switchable between the shared core and
     *  the native path so the two can be cross-checked. */
    static SignedEnvelope buildSignedEnvelope(
            byte[] sourceSeed,
            byte[] sourcePublic,
            long sequence,
            String destinationAddress,
            String amountXlm,
            boolean createAccount,
            String memo,
            String memoType,
            boolean testnet
    ) throws Exception {
        if (USE_SHARED_CORE_SIGNING) {
            String passphrase = testnet ? TESTNET_PASSPHRASE : PUBLIC_PASSPHRASE;
            SignedStellarCore s = WalletCoreBridge.signStellar(
                    sourceSeed, passphrase, sequence, destinationAddress, amountXlm, memo, memoType, createAccount);
            return new SignedEnvelope(s.envelopeBase64, s.txHashHex);
        }
        // C-1: the native fallback below only encodes MEMO_TEXT. Fail closed on a
        // numeric / hash memo type rather than silently downgrading an exchange
        // MEMO_ID to text (which loses the deposit). The shared core path above
        // handles every memo type; this branch is fallback-only.
        String mt = memoType == null ? "" : memoType.trim().toLowerCase(java.util.Locale.ROOT);
        if (!mt.isEmpty() && !mt.equals("text")) {
            throw new IllegalStateException(
                    "Stellar memo type \"" + memoType + "\" requires the shared signing core. "
                            + "Enable USE_SHARED_CORE_SIGNING to send a non-text memo.");
        }
        byte[] destinationPublic = StellarStrKey.decodePublicKey(destinationAddress);
        long amount = xlmToStroops(amountXlm);
        byte[] tx = transactionXdr(sourcePublic, destinationPublic, sequence, amount, createAccount, memo);
        byte[] networkHash = sha256((testnet ? TESTNET_PASSPHRASE : PUBLIC_PASSPHRASE).getBytes(StandardCharsets.UTF_8));
        ByteArrayOutputStream signatureBase = new ByteArrayOutputStream();
        signatureBase.write(networkHash);
        writeInt(signatureBase, 2);
        signatureBase.write(tx);
        byte[] txHashBytes = sha256(signatureBase.toByteArray());
        byte[] signature = sign(sourceSeed, txHashBytes);
        byte[] envelope = envelopeXdr(tx, sourcePublic, signature);
        return new SignedEnvelope(Base64.getEncoder().encodeToString(envelope), Hex.bytesToHex(txHashBytes));
    }

    static final class SignedEnvelope {
        final String envelope64;
        final String txHash;
        SignedEnvelope(String envelope64, String txHash) {
            this.envelope64 = envelope64;
            this.txHash = txHash;
        }
    }

    private static byte[] transactionXdr(byte[] source, byte[] destination, long sequence, long amount, boolean createAccount, String memo) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        writeAccountId(out, source);
        writeInt(out, 100);
        writeLong(out, sequence);
        writeInt(out, 0);
        writeMemo(out, memo);
        writeInt(out, 1);
        writeBool(out, false);
        if (createAccount) {
            writeInt(out, 0);
            writeAccountId(out, destination);
            writeLong(out, amount);
        } else {
            writeInt(out, 1);
            writeMuxedAccount(out, destination);
            writeInt(out, 0);
            writeLong(out, amount);
        }
        writeInt(out, 0);
        return out.toByteArray();
    }

    private static long fetchMinimumCreateAccountBalanceStroops(String horizonUrl) {
        Request request = new Request.Builder().url(horizonUrl + "/ledgers?order=desc&limit=1").get().build();
        try (Response response = HTTP.newCall(request).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) return FALLBACK_MIN_CREATE_ACCOUNT_STROOPS;
            JSONObject root = new JSONObject(text);
            JSONObject embedded = root.optJSONObject("_embedded");
            JSONArray records = embedded == null ? null : embedded.optJSONArray("records");
            if (records == null || records.length() == 0) return FALLBACK_MIN_CREATE_ACCOUNT_STROOPS;
            long baseReserve = records.getJSONObject(0).optLong("base_reserve_in_stroops", 0L);
            if (baseReserve <= 0L) return FALLBACK_MIN_CREATE_ACCOUNT_STROOPS;
            return baseReserve * 2L;
        } catch (Exception ignored) {
            VpLog.w("StellarTransfer", "min-balance fetch failed; using fallback reserve", ignored);
            return FALLBACK_MIN_CREATE_ACCOUNT_STROOPS;
        }
    }

    /**
     * Read-only live fee estimate (no signing, no broadcast): the per-operation base fee from
     * Horizon's /fee_stats. A simple XLM payment is a single operation, so this is the fee the
     * transaction will pay. Falls back to the protocol minimum (100 stroops) on any error.
     */
    static long estimateFeeStroops(String horizonUrl, boolean testnet) {
        String url = normalizeHorizonUrl(horizonUrl, testnet);
        Request request = new Request.Builder().url(url + "/fee_stats").get().build();
        try (Response response = HTTP.newCall(request).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) return 100L;
            JSONObject root = new JSONObject(text);
            // Horizon returns these as numeric strings (e.g. "100"); optLong coerces them.
            long base = root.optLong("last_ledger_base_fee", 100L);
            return base <= 0L ? 100L : base;
        } catch (Exception ignored) {
            VpLog.w("StellarTransfer", "fee_stats fetch failed; using base fee 100 stroops", ignored);
            return 100L;
        }
    }

    private static boolean hasTrustline(JSONObject account, String assetCode, String assetIssuer) {
        JSONArray balances = account.optJSONArray("balances");
        if (balances == null) return false;
        for (int i = 0; i < balances.length(); i++) {
            JSONObject balance = balances.optJSONObject(i);
            if (balance == null) continue;
            if (assetCode.equalsIgnoreCase(balance.optString("asset_code", ""))
                    && assetIssuer.equalsIgnoreCase(balance.optString("asset_issuer", ""))) {
                return true;
            }
        }
        return false;
    }

    /**
     * M-3: extract the host from the (already normalized) Horizon URL and ask the
     * shared core whether it contradicts the declared network. Throws
     * IllegalStateException (fail closed) on a recognized mismatch; a malformed or
     * custom host yields an empty host string, which the core treats as
     * unrecognized and allows through on the declared flag.
     */
    private static void assertNetworkConsistency(String horizonUrl, boolean testnet) {
        String host;
        try {
            host = new java.net.URI(horizonUrl).getHost();
        } catch (Exception e) {
            VpLog.w("StellarTransfer", "horizon host parse failed; treating as unrecognized", e);
            host = null;
        }
        WalletCoreBridge.assertStellarNetwork(host == null ? "" : host, testnet);
    }

    private static String normalizeHorizonUrl(String horizonUrl, boolean testnet) {
        String clean = horizonUrl == null ? "" : horizonUrl.trim().replaceAll("/+$", "");
        if (clean.length() > 0) return clean;
        return testnet ? "https://horizon-testnet.stellar.org" : "https://horizon.stellar.org";
    }

    private static String stellarErrorMessage(int httpCode, String text) {
        try {
            JSONObject root = new JSONObject(text);
            JSONObject extras = root.optJSONObject("extras");
            JSONObject resultCodes = extras == null ? null : extras.optJSONObject("result_codes");
            String transactionCode = resultCodes == null ? "" : resultCodes.optString("transaction", "");
            JSONArray operations = resultCodes == null ? null : resultCodes.optJSONArray("operations");
            String operationCode = operations == null || operations.length() == 0 ? "" : operations.optString(0, "");
            String friendly = friendlyResultCode(operationCode, transactionCode);
            if (friendly.length() > 0) return friendly;
            String detail = root.optString("detail", root.optString("title", ""));
            if (operationCode.length() > 0 || transactionCode.length() > 0) {
                return "Stellar transaction failed"
                        + (operationCode.length() > 0 ? " (" + operationCode + ")" : "")
                        + (transactionCode.length() > 0 ? " [" + transactionCode + "]" : "")
                        + (detail.length() > 0 ? ": " + shorten(detail) : "");
            }
        } catch (Exception ignored) {
            VpLog.w("StellarTransfer", "parse horizon error body failed; using generic message", ignored);
        }
        return "Stellar Horizon HTTP " + httpCode + ": " + shorten(text);
    }

    private static String friendlyResultCode(String operationCode, String transactionCode) {
        if ("op_no_destination".equals(operationCode)) {
            return "Recipient Stellar account is not activated on this network. Send XLM with Create Account first, or ask the recipient to activate the address.";
        }
        if ("op_no_trust".equals(operationCode)) {
            return "Recipient Stellar account does not have the required trustline for this asset.";
        }
        if ("op_underfunded".equals(operationCode)) {
            return "Source Stellar account does not have enough spendable balance after fees and minimum reserve.";
        }
        if ("op_low_reserve".equals(operationCode)) {
            return "Amount is below the current Stellar minimum reserve required to create a new account.";
        }
        if ("op_already_exists".equals(operationCode)) {
            return "Recipient Stellar account already exists. Retry as a normal payment.";
        }
        if ("op_no_issuer".equals(operationCode)) {
            return "The Stellar asset issuer account does not exist.";
        }
        if ("tx_bad_seq".equals(transactionCode)) {
            return "Stellar sequence number changed before submission. Refresh and retry.";
        }
        if ("tx_insufficient_fee".equals(transactionCode)) {
            return "Stellar fee is too low for the current network conditions.";
        }
        if ("tx_bad_auth".equals(transactionCode)) {
            return "Stellar signature was rejected by the network.";
        }
        return "";
    }

    private static String shorten(String value) {
        if (value == null) return "";
        String clean = value.replace('\n', ' ').replace('\r', ' ').trim();
        return clean.length() <= 600 ? clean : clean.substring(0, 600) + "...";
    }

    private static byte[] envelopeXdr(byte[] tx, byte[] sourcePublic, byte[] signature) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        writeInt(out, 2);
        out.write(tx);
        writeInt(out, 1);
        out.write(Arrays.copyOfRange(sourcePublic, 28, 32));
        writeOpaque(out, signature);
        return out.toByteArray();
    }

    private static void writeAccountId(ByteArrayOutputStream out, byte[] publicKey) throws Exception {
        writeInt(out, 0);
        out.write(publicKey);
    }

    private static void writeMuxedAccount(ByteArrayOutputStream out, byte[] publicKey) throws Exception {
        writeInt(out, 0);
        out.write(publicKey);
    }

    private static void writeBool(ByteArrayOutputStream out, boolean value) {
        writeInt(out, value ? 1 : 0);
    }

    // Stellar Memo union. An empty memo encodes MEMO_NONE, byte-identical to the
    // previous no-memo behaviour, so existing transactions/fixtures are unaffected.
    // A non-empty memo is sent as MEMO_TEXT (string<28>).
    private static void writeMemo(ByteArrayOutputStream out, String memo) throws Exception {
        String text = memo == null ? "" : memo.trim();
        if (text.isEmpty()) {
            writeInt(out, 0); // MEMO_NONE
            return;
        }
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 28) {
            throw new IllegalStateException(
                    "Stellar text memo must be 28 bytes or fewer (this one is " + bytes.length
                            + "). Shorten it, or confirm the exchange wants a numeric ID memo instead.");
        }
        writeInt(out, 1); // MEMO_TEXT
        writeOpaque(out, bytes); // XDR string<28>: 4-byte length prefix + bytes + padding
    }

    private static void writeInt(ByteArrayOutputStream out, int value) {
        out.write((value >>> 24) & 0xff);
        out.write((value >>> 16) & 0xff);
        out.write((value >>> 8) & 0xff);
        out.write(value & 0xff);
    }

    private static void writeLong(ByteArrayOutputStream out, long value) {
        for (int i = 7; i >= 0; i--) out.write((int) ((value >>> (8 * i)) & 0xff));
    }

    private static void writeOpaque(ByteArrayOutputStream out, byte[] bytes) throws Exception {
        writeInt(out, bytes.length);
        out.write(bytes);
        int pad = (4 - (bytes.length % 4)) % 4;
        for (int i = 0; i < pad; i++) out.write(0);
    }

    private static byte[] sign(byte[] privateSeed, byte[] payload) {
        Ed25519Signer signer = new Ed25519Signer();
        signer.init(true, new Ed25519PrivateKeyParameters(privateSeed, 0));
        signer.update(payload, 0, payload.length);
        return signer.generateSignature();
    }

    private static byte[] sha256(byte[] data) {
        SHA256Digest digest = new SHA256Digest();
        digest.update(data, 0, data.length);
        byte[] out = new byte[32];
        digest.doFinal(out, 0);
        return out;
    }

    private static long xlmToStroops(String xlm) {
        // Delegates to the shared AmountUnits (D9/Q4, 2026-06-20): single home for
        // decimal -> base-unit money conversion. Behaviour is unchanged.
        return AmountUnits.xlmToStroops(xlm);
    }

    private static String stroopsToXlm(long stroops) {
        return BigDecimal.valueOf(stroops).divide(new BigDecimal("10000000")).stripTrailingZeros().toPlainString();
    }
}
