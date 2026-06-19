package ai.agentwallet.hd;

import android.util.Base64;

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
        horizonUrl = normalizeHorizonUrl(horizonUrl, testnet);
        String sourceAddress = StellarStrKey.encodePublicKey(sourcePublic);
        long sequence = fetchSequence(horizonUrl, sourceAddress) + 1;
        byte[] destinationPublic = StellarStrKey.decodePublicKey(destinationAddress);
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
        byte[] tx = transactionXdr(sourcePublic, destinationPublic, sequence, amount, createAccount, memo);
        byte[] networkHash = sha256((testnet ? TESTNET_PASSPHRASE : PUBLIC_PASSPHRASE).getBytes(StandardCharsets.UTF_8));
        ByteArrayOutputStream signatureBase = new ByteArrayOutputStream();
        signatureBase.write(networkHash);
        writeInt(signatureBase, 2);
        signatureBase.write(tx);
        byte[] txHashBytes = sha256(signatureBase.toByteArray());
        String txHash = Hex.bytesToHex(txHashBytes);
        byte[] signature = sign(sourceSeed, txHashBytes);
        byte[] envelope = envelopeXdr(tx, sourcePublic, signature);
        String envelope64 = Base64.encodeToString(envelope, Base64.NO_WRAP);
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
            return FALLBACK_MIN_CREATE_ACCOUNT_STROOPS;
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
        // Validate with clear messages instead of leaking raw NumberFormatException /
        // ArithmeticException to the user (e.g. when the amount has more than the 7
        // decimal places Stellar supports, is non-numeric, or overflows).
        String raw = xlm == null ? "" : xlm.trim();
        if (raw.isEmpty()) throw new IllegalStateException("Enter an amount of XLM to send.");
        BigDecimal value;
        try {
            value = new BigDecimal(raw);
        } catch (NumberFormatException e) {
            throw new IllegalStateException("Enter a valid XLM amount, for example 1.5.");
        }
        if (value.signum() <= 0) throw new IllegalStateException("XLM amount must be greater than 0.");
        try {
            return value.multiply(new BigDecimal("10000000")).toBigIntegerExact().longValueExact();
        } catch (ArithmeticException e) {
            throw new IllegalStateException(
                    "XLM supports at most 7 decimal places (1 stroop = 0.0000001 XLM) and must be within range. Adjust the amount.");
        }
    }

    private static String stroopsToXlm(long stroops) {
        return BigDecimal.valueOf(stroops).divide(new BigDecimal("10000000")).stripTrailingZeros().toPlainString();
    }
}
