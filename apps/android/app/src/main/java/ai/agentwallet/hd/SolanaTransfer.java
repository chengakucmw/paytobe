package ai.agentwallet.hd;

import java.util.Base64;

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.bouncycastle.math.ec.rfc8032.Ed25519;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

final class SolanaTransfer {
    private static final OkHttpClient HTTP = WalletHttp.oneShot();
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final byte[] SYSTEM_PROGRAM = new byte[32];
    private static final byte[] TOKEN_PROGRAM = Base58.decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    private static final byte[] ASSOCIATED_TOKEN_PROGRAM = Base58.decode("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    private static final byte[] RENT_SYSVAR = Base58.decode("SysvarRent111111111111111111111111111111111");
    private static final byte[] PDA_MARKER = "ProgramDerivedAddress".getBytes(StandardCharsets.US_ASCII);
    private static final BigInteger MAX_U64 = BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE);

    /** When true (default), native SOL transfers are signed by the shared Rust core
     *  (byte-identical to the native path, verified by a cross-check). Set false to revert. */
    static boolean USE_SHARED_CORE_SIGNING = true;

    /** When true (default), SPL token transfers are signed by the shared Rust core.
     *  The associated token accounts are still derived natively (the existing, tested
     *  PDA code) and passed in; the core does the deterministic message-build + sign,
     *  byte-identical to the native path (verified by a cross-check). Set false to revert. */
    static boolean USE_SHARED_CORE_SPL = true;

    private SolanaTransfer() {}

    static String sendSol(String rpcUrl, byte[] privateSeed, byte[] fromPub, String toAddress, String amountSol) throws Exception {
        byte[] toPub = Base58.decode(toAddress.trim());
        if (toPub.length != 32) throw new IllegalArgumentException("Invalid Solana recipient address");
        String blockhash = getLatestBlockhash(rpcUrl);
        long lamports = solToLamports(amountSol);
        String encoded;
        if (USE_SHARED_CORE_SIGNING) {
            encoded = WalletCoreBridge.signSolana(privateSeed, toAddress.trim(), lamports, blockhash).transactionBase64;
        } else {
            encoded = encodeSignedTx(privateSeed, buildMessage(fromPub, toPub, Base58.decode(blockhash), lamports));
        }
        return broadcastSolana(rpcUrl, encoded);
    }

    static String sendSplToken(
            String rpcUrl,
            byte[] privateSeed,
            byte[] ownerPub,
            String mintAddress,
            String recipientWalletAddress,
            String amount,
            int decimals,
            boolean createRecipientAta
    ) throws Exception {
        byte[] mint = decodePubkey(mintAddress, "SPL token mint");
        byte[] recipientWallet = decodePubkey(recipientWalletAddress, "Solana recipient wallet");
        byte[] sourceAta = associatedTokenAddress(ownerPub, mint);
        byte[] destinationAta = associatedTokenAddress(recipientWallet, mint);
        boolean destinationExists = accountExists(rpcUrl, Base58.encode(destinationAta));
        if (!destinationExists && !createRecipientAta) {
            throw new IllegalStateException("Recipient associated token account does not exist");
        }
        String blockhash = getLatestBlockhash(rpcUrl);
        boolean createAta = !destinationExists && createRecipientAta;
        java.math.BigInteger amountUnits = tokenUnitsU64(amount, decimals);
        String encoded;
        if (USE_SHARED_CORE_SPL) {
            encoded = WalletCoreBridge.signSplToken(
                    privateSeed,
                    Base58.encode(sourceAta),
                    Base58.encode(destinationAta),
                    mintAddress,
                    recipientWalletAddress,
                    amountUnits.toString(),
                    decimals,
                    blockhash,
                    createAta
            ).transactionBase64;
        } else {
            byte[] message = buildSplMessage(
                    ownerPub, sourceAta, destinationAta, recipientWallet, mint,
                    Base58.decode(blockhash), amountUnits, decimals, createAta);
            encoded = encodeSignedTx(privateSeed, message);
        }
        return broadcastSolana(rpcUrl, encoded);
    }

    static String associatedTokenAddressText(String ownerAddress, String mintAddress) throws Exception {
        return Base58.encode(associatedTokenAddress(
                decodePubkey(ownerAddress, "Solana wallet"),
                decodePubkey(mintAddress, "SPL token mint")
        ));
    }

    private static String signAndSend(String rpcUrl, byte[] privateSeed, byte[] message) throws Exception {
        return broadcastSolana(rpcUrl, encodeSignedTx(privateSeed, message));
    }

    /** Native sign + assemble + base64 (kept for SPL + the cross-check test). */
    static String encodeSignedTx(byte[] privateSeed, byte[] message) throws Exception {
        byte[] signature = sign(privateSeed, message);
        ByteArrayOutputStream tx = new ByteArrayOutputStream();
        writeCompact(tx, 1);
        tx.write(signature);
        tx.write(message);
        return Base64.getEncoder().encodeToString(tx.toByteArray());
    }

    private static String broadcastSolana(String rpcUrl, String encoded) throws Exception {
        JSONObject params = new JSONObject()
                .put("encoding", "base64")
                .put("skipPreflight", false);
        JSONObject req = rpc("sendTransaction")
                .put("params", new org.json.JSONArray().put(encoded).put(params));
        JSONObject res = post(rpcUrl, req);
        if (res.has("error")) throw new IllegalStateException(res.getJSONObject("error").toString());
        return res.getString("result");
    }

    private static boolean accountExists(String rpcUrl, String accountAddress) throws Exception {
        JSONObject req = rpc("getAccountInfo")
                .put("params", new org.json.JSONArray()
                        .put(accountAddress)
                        .put(new JSONObject().put("encoding", "base64")));
        JSONObject res = post(rpcUrl, req);
        if (res.has("error")) throw new IllegalStateException(res.getJSONObject("error").toString());
        return !res.getJSONObject("result").isNull("value");
    }

    private static String getLatestBlockhash(String rpcUrl) throws Exception {
        JSONObject req = rpc("getLatestBlockhash")
                .put("params", new org.json.JSONArray().put(new JSONObject().put("commitment", "finalized")));
        JSONObject res = post(rpcUrl, req);
        if (res.has("error")) throw new IllegalStateException(res.getJSONObject("error").toString());
        return res.getJSONObject("result").getJSONObject("value").getString("blockhash");
    }

    /**
     * Read-only live fee estimate (no signing, no broadcast): builds the same transfer message
     * the send path would, then asks the RPC {@code getFeeForMessage}. Falls back to the base
     * signature fee (5000 lamports) on any error or when the node can't price the message.
     */
    static long estimateFeeLamports(String rpcUrl, String fromAddress, String toAddress, String amountSol) {
        final long BASE_FEE = 5000L;
        try {
            byte[] fromPub = Base58.decode(fromAddress.trim());
            byte[] toPub = Base58.decode(toAddress.trim());
            if (fromPub.length != 32 || toPub.length != 32) return BASE_FEE;
            String blockhash = getLatestBlockhash(rpcUrl);
            long lamports;
            try { lamports = solToLamports(amountSol); } catch (Exception ignored) { lamports = 0L; }
            byte[] message = buildMessage(fromPub, toPub, Base58.decode(blockhash), lamports);
            String messageB64 = Base64.getEncoder().encodeToString(message);
            JSONObject req = rpc("getFeeForMessage")
                    .put("params", new org.json.JSONArray()
                            .put(messageB64)
                            .put(new JSONObject().put("commitment", "processed")));
            JSONObject res = post(rpcUrl, req);
            if (res.has("error")) return BASE_FEE;
            JSONObject result = res.optJSONObject("result");
            if (result == null || result.isNull("value")) return BASE_FEE;
            long value = result.optLong("value", BASE_FEE);
            return value <= 0L ? BASE_FEE : value;
        } catch (Exception ignored) {
            VpLog.w("SolanaTransfer", "fee estimate failed; using base 5000 lamports", ignored);
            return BASE_FEE;
        }
    }

    private static JSONObject rpc(String method) throws Exception {
        return new JSONObject()
                .put("jsonrpc", "2.0")
                .put("id", 1)
                .put("method", method);
    }

    private static JSONObject post(String url, JSONObject body) throws Exception {
        Request request = new Request.Builder()
                .url(url)
                .post(RequestBody.create(body.toString(), JSON))
                .build();
        try (Response response = HTTP.newCall(request).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) throw new IllegalStateException("HTTP " + response.code() + ": " + text);
            return new JSONObject(text);
        }
    }

    static byte[] buildMessage(byte[] from, byte[] to, byte[] recentBlockhash, long lamports) throws Exception {
        if (recentBlockhash.length != 32) throw new IllegalArgumentException("Invalid Solana blockhash");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(1);
        out.write(0);
        out.write(1);
        writeCompact(out, 3);
        out.write(from);
        out.write(to);
        out.write(SYSTEM_PROGRAM);
        out.write(recentBlockhash);
        writeCompact(out, 1);
        out.write(2);
        writeCompact(out, 2);
        out.write(0);
        out.write(1);
        byte[] data = transferData(lamports);
        writeCompact(out, data.length);
        out.write(data);
        return out.toByteArray();
    }

    static byte[] buildSplMessage(
            byte[] owner,
            byte[] sourceAta,
            byte[] destinationAta,
            byte[] recipientWallet,
            byte[] mint,
            byte[] recentBlockhash,
            BigInteger amountUnits,
            int decimals,
            boolean createDestinationAta
    ) throws Exception {
        if (recentBlockhash.length != 32) throw new IllegalArgumentException("Invalid Solana blockhash");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(1);
        out.write(0);
        out.write(createDestinationAta ? 6 : 2);
        if (createDestinationAta) {
            writeCompact(out, 9);
            out.write(owner);
            out.write(sourceAta);
            out.write(destinationAta);
            out.write(mint);
            out.write(recipientWallet);
            out.write(SYSTEM_PROGRAM);
            out.write(TOKEN_PROGRAM);
            out.write(ASSOCIATED_TOKEN_PROGRAM);
            out.write(RENT_SYSVAR);
            out.write(recentBlockhash);
            writeCompact(out, 2);
            writeInstruction(out, 7, new int[]{0, 2, 4, 3, 5, 6, 8}, new byte[0]);
            writeInstruction(out, 6, new int[]{1, 3, 2, 0}, transferCheckedData(amountUnits, decimals));
        } else {
            writeCompact(out, 5);
            out.write(owner);
            out.write(sourceAta);
            out.write(destinationAta);
            out.write(mint);
            out.write(TOKEN_PROGRAM);
            out.write(recentBlockhash);
            writeCompact(out, 1);
            writeInstruction(out, 4, new int[]{1, 3, 2, 0}, transferCheckedData(amountUnits, decimals));
        }
        return out.toByteArray();
    }

    private static byte[] transferData(long lamports) {
        ByteBuffer buffer = ByteBuffer.allocate(12).order(ByteOrder.LITTLE_ENDIAN);
        buffer.putInt(2);
        buffer.putLong(lamports);
        return buffer.array();
    }

    private static long solToLamports(String sol) {
        // Delegates to shared AmountUnits (D9/Q4): now validated with friendly messages
        // instead of leaking raw NumberFormatException / ArithmeticException to the user.
        return AmountUnits.solToLamports(sol);
    }

    static BigInteger tokenUnitsU64(String amount, int decimals) {
        return AmountUnits.tokenUnitsU64(amount, decimals);
    }

    private static byte[] transferCheckedData(BigInteger amountUnits, int decimals) {
        byte[] out = new byte[10];
        out[0] = 12;
        byte[] amount = u64Le(amountUnits);
        System.arraycopy(amount, 0, out, 1, amount.length);
        out[9] = (byte) decimals;
        return out;
    }

    private static byte[] u64Le(BigInteger value) {
        byte[] out = new byte[8];
        BigInteger v = value;
        for (int i = 0; i < out.length; i++) {
            out[i] = v.and(BigInteger.valueOf(0xff)).byteValue();
            v = v.shiftRight(8);
        }
        return out;
    }

    private static void writeInstruction(ByteArrayOutputStream out, int programIndex, int[] accountIndexes, byte[] data) {
        out.write(programIndex);
        writeCompact(out, accountIndexes.length);
        for (int index : accountIndexes) out.write(index);
        writeCompact(out, data.length);
        out.write(data, 0, data.length);
    }

    static byte[] associatedTokenAddress(byte[] owner, byte[] mint) throws Exception {
        return findProgramAddress(new byte[][]{owner, TOKEN_PROGRAM, mint}, ASSOCIATED_TOKEN_PROGRAM);
    }

    private static byte[] findProgramAddress(byte[][] seeds, byte[] programId) throws Exception {
        for (int bump = 255; bump >= 0; bump--) {
            byte[][] withBump = new byte[seeds.length + 1][];
            System.arraycopy(seeds, 0, withBump, 0, seeds.length);
            withBump[seeds.length] = new byte[]{(byte) bump};
            try {
                return createProgramAddress(withBump, programId);
            } catch (IllegalArgumentException ignored) {
                // Try the next bump when the derived address lands on the Ed25519 curve.
            }
        }
        throw new IllegalStateException("Unable to derive associated token account");
    }

    private static byte[] createProgramAddress(byte[][] seeds, byte[] programId) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        for (byte[] seed : seeds) {
            if (seed.length > 32) throw new IllegalArgumentException("Solana PDA seed is too long");
            digest.update(seed);
        }
        digest.update(programId);
        digest.update(PDA_MARKER);
        byte[] address = digest.digest();
        if (Ed25519.validatePublicKeyFull(address, 0)) {
            throw new IllegalArgumentException("Derived address is on curve");
        }
        return address;
    }

    private static byte[] decodePubkey(String address, String label) {
        byte[] out = Base58.decode(address.trim());
        if (out.length != 32) throw new IllegalArgumentException("Invalid " + label + " address");
        return out;
    }

    private static byte[] sign(byte[] privateSeed, byte[] message) {
        Ed25519Signer signer = new Ed25519Signer();
        signer.init(true, new Ed25519PrivateKeyParameters(privateSeed, 0));
        signer.update(message, 0, message.length);
        return signer.generateSignature();
    }

    private static void writeCompact(ByteArrayOutputStream out, int value) {
        if (value < 128) {
            out.write(value);
            return;
        }
        while (true) {
            int elem = value & 0x7f;
            value >>>= 7;
            if (value == 0) {
                out.write(elem);
                break;
            } else {
                out.write(elem | 0x80);
            }
        }
    }
}
