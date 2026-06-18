package ai.agentwallet.hd;

import org.bitcoinj.core.ECKey;
import org.bitcoinj.core.Sha256Hash;
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.json.JSONObject;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

final class PreparedPayloadTransfer {
    private static final OkHttpClient HTTP = WalletHttp.oneShot();
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final BigInteger ONE = BigInteger.ONE;
    private static final BigInteger TWO = BigInteger.valueOf(2);
    private static final BigInteger THREE = BigInteger.valueOf(3);

    private static final BigInteger STARK_FIELD = new BigInteger("3618502788666131213697322783095070105623107215331596699973092056135872020481");
    private static final BigInteger STARK_BETA = new BigInteger("3141592653589793238462643383279502884197169399375105820974944592307816406665");
    private static final BigInteger STARK_ORDER = new BigInteger("3618502788666131213697322783095070105526743751716087489154079457884512865583");
    private static final BigInteger STARK_HASH_BOUND = ONE.shiftLeft(251);
    private static final StarkPoint STARK_GENERATOR = new StarkPoint(
            new BigInteger("874739451078007766457464989774322083649278607533249481151382481072868806602"),
            new BigInteger("152666792071518830868575557812948353041420400780739481342941381225525861407"),
            false
    );

    private PreparedPayloadTransfer() {}

    static String signAndSubmit(
            HDWallet wallet,
            PaymentIntent intent,
            TransferAssetRegistry.Asset asset,
            TransactionProgress progress
    ) throws Exception {
        SignedPayload signed = sign(wallet, asset, intent.signingPayload, intent.signingPayloadEncoding, intent.signingPayloadDigest);
        if (progress != null) progress.onGenerated("Signed " + asset.chain + " prepared transaction payload");
        JSONObject body = new JSONObject()
                .put("payment_request_id", intent.id)
                .put("rail", asset.rail)
                .put("network", asset.network)
                .put("chain_family", asset.family)
                .put("asset", asset.symbol)
                .put("amount", intent.amount)
                .put("to", intent.to)
                .put("memo", intent.memo)
                .put("signing_payload", intent.signingPayload)
                .put("signing_payload_encoding", intent.signingPayloadEncoding)
                .put("signing_payload_is_digest", intent.signingPayloadDigest)
                .put("payload_digest", signed.payloadDigestHex)
                .put("signature", signed.signatureHex)
                .put("signature_encoding", signed.signatureEncoding)
                .put("signature_algorithm", signed.algorithm)
                .put("public_key", signed.publicKeyHex)
                .put("address", signed.address)
                .put("derivation_path", signed.derivationPath);
        if (signed.rHex.length() > 0) body.put("r", signed.rHex);
        if (signed.sHex.length() > 0) body.put("s", signed.sHex);

        Request request = new Request.Builder()
                .url(intent.broadcastUrl)
                .post(RequestBody.create(body.toString(), JSON))
                .build();
        try (Response response = HTTP.newCall(request).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) throw new IllegalStateException("HTTP " + response.code() + ": " + text);
            String txHash = extractTxHash(new JSONObject(text));
            if (progress != null) progress.onGenerated("Submitted signed " + asset.chain + " payload");
            return txHash;
        }
    }

    static SignedPayload signForTest(
            HDWallet wallet,
            TransferAssetRegistry.Asset asset,
            String payload,
            String encoding,
            boolean payloadIsDigest
    ) throws Exception {
        return sign(wallet, asset, payload, encoding, payloadIsDigest);
    }

    private static SignedPayload sign(
            HDWallet wallet,
            TransferAssetRegistry.Asset asset,
            String payload,
            String encoding,
            boolean payloadIsDigest
    ) throws Exception {
        byte[] payloadBytes = decodePayload(payload, encoding);
        if (TransferAssetRegistry.KEY_SECP256K1.equals(asset.keyCurve)) {
            return signSecp256k1(wallet, asset, payloadBytes, payloadIsDigest);
        }
        if (TransferAssetRegistry.KEY_ED25519.equals(asset.keyCurve)) {
            return signEd25519(wallet, asset, payloadBytes);
        }
        if (TransferAssetRegistry.KEY_STARK.equals(asset.keyCurve)) {
            return signStark(wallet, asset, payloadBytes, payloadIsDigest);
        }
        throw new IllegalArgumentException("Unsupported prepared payload signer curve: " + asset.keyCurve);
    }

    private static SignedPayload signSecp256k1(
            HDWallet wallet,
            TransferAssetRegistry.Asset asset,
            byte[] payload,
            boolean payloadIsDigest
    ) throws Exception {
        byte[] digest = digestForEcdsa(payload, payloadIsDigest);
        byte[] privateKey = wallet.secp256k1PrivateKey(asset.coinType);
        byte[] publicKey = wallet.secp256k1CompressedPublicKey(asset.coinType);
        ECKey.ECDSASignature signature = ECKey.fromPrivate(new BigInteger(1, privateKey), true)
                .sign(Sha256Hash.wrap(digest))
                .toCanonicalised();
        return new SignedPayload(
                Hex.bytesToHex(signature.encodeToDER()),
                "der_hex",
                "secp256k1-sha256",
                Hex.bytesToHex(digest),
                Hex.bytesToHex(publicKey),
                "",
                "m/44'/" + asset.coinType + "'/0'/0/0",
                leftPad(signature.r.toString(16), 64),
                leftPad(signature.s.toString(16), 64)
        );
    }

    private static SignedPayload signEd25519(
            HDWallet wallet,
            TransferAssetRegistry.Asset asset,
            byte[] payload
    ) throws Exception {
        HDWallet.EdAccount account = wallet.ed25519Account(asset.coinType);
        Ed25519Signer signer = new Ed25519Signer();
        signer.init(true, new Ed25519PrivateKeyParameters(account.privateSeed, 0));
        signer.update(payload, 0, payload.length);
        byte[] signature = signer.generateSignature();
        return new SignedPayload(
                Hex.bytesToHex(signature),
                "hex",
                "ed25519",
                Hex.bytesToHex(sha256(payload)),
                Hex.bytesToHex(account.publicKey),
                account.address,
                account.path,
                "",
                ""
        );
    }

    private static SignedPayload signStark(
            HDWallet wallet,
            TransferAssetRegistry.Asset asset,
            byte[] payload,
            boolean payloadIsDigest
    ) throws Exception {
        byte[] digest = digestForEcdsa(payload, payloadIsDigest);
        BigInteger privateKey = new BigInteger(1, wallet.secp256k1PrivateKey(asset.coinType))
                .mod(STARK_ORDER.subtract(ONE))
                .add(ONE);
        BigInteger messageHash = new BigInteger(1, digest).mod(STARK_HASH_BOUND);
        if (messageHash.signum() == 0) messageHash = ONE;
        StarkSignature signature = starkSign(privateKey, messageHash);
        return new SignedPayload(
                leftPad(signature.r.toString(16), 64) + leftPad(signature.s.toString(16), 64),
                "stark_rs_hex",
                "stark-ecdsa",
                Hex.bytesToHex(digest),
                leftPad(starkPublicKey(privateKey).toString(16), 64),
                "",
                "m/44'/" + asset.coinType + "'/0'/0/0",
                leftPad(signature.r.toString(16), 64),
                leftPad(signature.s.toString(16), 64)
        );
    }

    private static byte[] decodePayload(String payload, String encoding) {
        String cleanPayload = payload == null ? "" : payload.trim();
        String cleanEncoding = encoding == null ? "hex" : encoding.trim().toLowerCase();
        if ("base64".equals(cleanEncoding)) return Base64.getDecoder().decode(cleanPayload);
        if ("utf8".equals(cleanEncoding) || "text".equals(cleanEncoding)) {
            return cleanPayload.getBytes(StandardCharsets.UTF_8);
        }
        return Hex.hexToBytes(cleanPayload);
    }

    private static byte[] digestForEcdsa(byte[] payload, boolean payloadIsDigest) throws Exception {
        if (payloadIsDigest) {
            if (payload.length != 32) throw new IllegalArgumentException("Prepared digest payload must be exactly 32 bytes");
            return payload;
        }
        return sha256(payload);
    }

    private static byte[] sha256(byte[] input) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(input);
    }

    private static StarkSignature starkSign(BigInteger privateKey, BigInteger messageHash) throws Exception {
        for (int counter = 0; counter < 1024; counter++) {
            BigInteger k = deterministicStarkNonce(privateKey, messageHash, counter);
            StarkPoint point = starkMultiply(STARK_GENERATOR, k);
            BigInteger r = point.x;
            if (r.signum() == 0 || r.compareTo(STARK_HASH_BOUND) >= 0) continue;
            BigInteger s = messageHash.add(r.multiply(privateKey)).mod(STARK_ORDER)
                    .multiply(k.modInverse(STARK_ORDER))
                    .mod(STARK_ORDER);
            if (s.signum() > 0) return new StarkSignature(r, s);
        }
        throw new IllegalStateException("Unable to generate Stark signature");
    }

    private static BigInteger deterministicStarkNonce(BigInteger privateKey, BigInteger messageHash, int counter) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(fixed32(privateKey), "HmacSHA256"));
        mac.update(fixed32(messageHash));
        mac.update(ByteBuffer.allocate(4).putInt(counter).array());
        return new BigInteger(1, mac.doFinal()).mod(STARK_ORDER.subtract(ONE)).add(ONE);
    }

    private static BigInteger starkPublicKey(BigInteger privateKey) {
        return starkMultiply(STARK_GENERATOR, privateKey).x;
    }

    private static StarkPoint starkMultiply(StarkPoint point, BigInteger scalar) {
        StarkPoint result = StarkPoint.INFINITY;
        StarkPoint addend = point;
        BigInteger k = scalar;
        while (k.signum() > 0) {
            if (k.testBit(0)) result = starkAdd(result, addend);
            addend = starkAdd(addend, addend);
            k = k.shiftRight(1);
        }
        return result;
    }

    private static StarkPoint starkAdd(StarkPoint a, StarkPoint b) {
        if (a.infinity) return b;
        if (b.infinity) return a;
        if (a.x.equals(b.x) && mod(a.y.add(b.y)).signum() == 0) return StarkPoint.INFINITY;
        BigInteger slope;
        if (a.x.equals(b.x) && a.y.equals(b.y)) {
            slope = THREE.multiply(a.x).multiply(a.x).add(ONE)
                    .multiply(TWO.multiply(a.y).mod(STARK_FIELD).modInverse(STARK_FIELD));
        } else {
            slope = b.y.subtract(a.y)
                    .multiply(b.x.subtract(a.x).mod(STARK_FIELD).modInverse(STARK_FIELD));
        }
        slope = mod(slope);
        BigInteger x = mod(slope.multiply(slope).subtract(a.x).subtract(b.x));
        BigInteger y = mod(slope.multiply(a.x.subtract(x)).subtract(a.y));
        return new StarkPoint(x, y, false);
    }

    private static BigInteger mod(BigInteger value) {
        BigInteger out = value.mod(STARK_FIELD);
        return out.signum() < 0 ? out.add(STARK_FIELD) : out;
    }

    private static byte[] fixed32(BigInteger value) {
        byte[] raw = value.toByteArray();
        byte[] out = new byte[32];
        int srcPos = Math.max(0, raw.length - 32);
        int length = Math.min(raw.length, 32);
        System.arraycopy(raw, srcPos, out, 32 - length, length);
        return out;
    }

    private static String leftPad(String value, int width) {
        if (value.length() >= width) return value;
        StringBuilder out = new StringBuilder(width);
        for (int i = value.length(); i < width; i++) out.append('0');
        out.append(value);
        return out.toString();
    }

    private static String extractTxHash(JSONObject json) throws Exception {
        String direct = firstNonEmpty(
                json.optString("tx_hash", ""),
                json.optString("transaction_hash", ""),
                json.optString("hash", ""),
                json.optString("id", "")
        );
        if (direct.length() > 0) return direct;
        Object result = json.opt("result");
        if (result instanceof JSONObject) {
            JSONObject value = (JSONObject) result;
            direct = firstNonEmpty(
                    value.optString("tx_hash", ""),
                    value.optString("transaction_hash", ""),
                    value.optString("hash", ""),
                    value.optString("id", "")
            );
            if (direct.length() > 0) return direct;
        } else if (result != null) {
            direct = String.valueOf(result).trim();
            if (direct.length() > 0 && !"null".equalsIgnoreCase(direct)) return direct;
        }
        throw new IllegalStateException("Broadcast response did not include a transaction hash");
    }

    private static String firstNonEmpty(String... values) {
        if (values == null) return "";
        for (String value : values) {
            if (value != null && value.trim().length() > 0 && !"null".equalsIgnoreCase(value.trim())) {
                return value.trim();
            }
        }
        return "";
    }

    static final class SignedPayload {
        final String signatureHex;
        final String signatureEncoding;
        final String algorithm;
        final String payloadDigestHex;
        final String publicKeyHex;
        final String address;
        final String derivationPath;
        final String rHex;
        final String sHex;

        SignedPayload(
                String signatureHex,
                String signatureEncoding,
                String algorithm,
                String payloadDigestHex,
                String publicKeyHex,
                String address,
                String derivationPath,
                String rHex,
                String sHex
        ) {
            this.signatureHex = signatureHex;
            this.signatureEncoding = signatureEncoding;
            this.algorithm = algorithm;
            this.payloadDigestHex = payloadDigestHex;
            this.publicKeyHex = publicKeyHex;
            this.address = address;
            this.derivationPath = derivationPath;
            this.rHex = rHex;
            this.sHex = sHex;
        }
    }

    private static final class StarkSignature {
        final BigInteger r;
        final BigInteger s;

        StarkSignature(BigInteger r, BigInteger s) {
            this.r = r;
            this.s = s;
        }
    }

    private static final class StarkPoint {
        static final StarkPoint INFINITY = new StarkPoint(BigInteger.ZERO, BigInteger.ZERO, true);

        final BigInteger x;
        final BigInteger y;
        final boolean infinity;

        StarkPoint(BigInteger x, BigInteger y, boolean infinity) {
            this.x = x;
            this.y = y;
            this.infinity = infinity;
        }
    }
}
