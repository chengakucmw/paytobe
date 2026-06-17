package ai.agentwallet.hd;

import org.bitcoinj.crypto.ChildNumber;
import org.bitcoinj.crypto.DeterministicKey;
import org.bitcoinj.crypto.HDKeyDerivation;
import org.bitcoinj.crypto.MnemonicCode;
import org.bouncycastle.asn1.sec.SECNamedCurves;
import org.bouncycastle.asn1.x9.X9ECParameters;
import org.bouncycastle.crypto.digests.KeccakDigest;
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.math.ec.ECPoint;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.List;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

final class HDWallet {
    private static final SecureRandom RNG = new SecureRandom();

    final String mnemonic;
    final byte[] seed;
    final EvmAccount evm;
    final EdAccount solana;
    final EdAccount stellar;

    private HDWallet(String mnemonic, byte[] seed, EvmAccount evm, EdAccount solana, EdAccount stellar) {
        this.mnemonic = mnemonic;
        this.seed = seed;
        this.evm = evm;
        this.solana = solana;
        this.stellar = stellar;
    }

    static HDWallet create() throws Exception {
        byte[] entropy = new byte[16];
        RNG.nextBytes(entropy);
        List<String> words = MnemonicCode.INSTANCE.toMnemonic(entropy);
        String mnemonic = join(words);
        byte[] seed = MnemonicCode.toSeed(words, "");
        return fromMnemonic(mnemonic, seed);
    }

    static HDWallet restore(String mnemonic) throws Exception {
        List<String> words = Arrays.asList(mnemonic.trim().toLowerCase().split("\\s+"));
        MnemonicCode.INSTANCE.check(words);
        byte[] seed = MnemonicCode.toSeed(words, "");
        return fromMnemonic(join(words), seed);
    }

    private static HDWallet fromMnemonic(String mnemonic, byte[] seed) throws Exception {
        DeterministicKey master = HDKeyDerivation.createMasterPrivateKey(seed);
        DeterministicKey evmKey = derive(master, 44, 60, 0, 0, 0);
        byte[] evmPrivate = evmKey.getPrivKeyBytes();
        EvmAccount evm = new EvmAccount(evmPrivate, evmAddress(evmPrivate), "m/44'/60'/0'/0/0");

        byte[] solSeed = deriveSlip10(seed, 44, 501, 0, 0);
        Ed25519PrivateKeyParameters solPriv = new Ed25519PrivateKeyParameters(solSeed, 0);
        byte[] solPub = solPriv.generatePublicKey().getEncoded();
        EdAccount solana = new EdAccount(solSeed, solPub, Base58.encode(solPub), "m/44'/501'/0'/0'");

        byte[] stellarSeed = deriveSlip10(seed, 44, 148, 0);
        Ed25519PrivateKeyParameters stellarPriv = new Ed25519PrivateKeyParameters(stellarSeed, 0);
        byte[] stellarPub = stellarPriv.generatePublicKey().getEncoded();
        EdAccount stellar = new EdAccount(stellarSeed, stellarPub, StellarStrKey.encodePublicKey(stellarPub), "m/44'/148'/0'");
        return new HDWallet(mnemonic, seed, evm, solana, stellar);
    }

    private static DeterministicKey derive(DeterministicKey master, int purpose, int coin, int account, int change, int index) {
        DeterministicKey key = master;
        key = HDKeyDerivation.deriveChildKey(key, new ChildNumber(purpose, true));
        key = HDKeyDerivation.deriveChildKey(key, new ChildNumber(coin, true));
        key = HDKeyDerivation.deriveChildKey(key, new ChildNumber(account, true));
        key = HDKeyDerivation.deriveChildKey(key, new ChildNumber(change, false));
        key = HDKeyDerivation.deriveChildKey(key, new ChildNumber(index, false));
        return key;
    }

    private static byte[] deriveSlip10(byte[] seed, int... path) throws Exception {
        byte[] i = hmacSha512("ed25519 seed".getBytes(StandardCharsets.US_ASCII), seed);
        byte[] key = Arrays.copyOfRange(i, 0, 32);
        byte[] chain = Arrays.copyOfRange(i, 32, 64);
        for (int child : path) {
            int hardened = child | 0x80000000;
            ByteBuffer data = ByteBuffer.allocate(37);
            data.put((byte) 0);
            data.put(key);
            data.putInt(hardened);
            i = hmacSha512(chain, data.array());
            key = Arrays.copyOfRange(i, 0, 32);
            chain = Arrays.copyOfRange(i, 32, 64);
        }
        return key;
    }

    private static byte[] hmacSha512(byte[] key, byte[] data) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA512");
        mac.init(new SecretKeySpec(key, "HmacSHA512"));
        return mac.doFinal(data);
    }

    private static String evmAddress(byte[] privateKey) {
        BigInteger d = new BigInteger(1, privateKey);
        X9ECParameters params = SECNamedCurves.getByName("secp256k1");
        ECPoint q = params.getG().multiply(d).normalize();
        byte[] x = toFixed32(q.getAffineXCoord().toBigInteger());
        byte[] y = toFixed32(q.getAffineYCoord().toBigInteger());
        byte[] hash = keccak256(Base58.concat(x, y));
        String lower = Hex.bytesToHex(Arrays.copyOfRange(hash, 12, 32));
        return checksumAddress(lower);
    }

    private static String checksumAddress(String lowerHexAddress) {
        String lower = lowerHexAddress.toLowerCase();
        byte[] hash = keccak256(lower.getBytes(StandardCharsets.US_ASCII));
        StringBuilder out = new StringBuilder("0x");
        for (int i = 0; i < lower.length(); i++) {
            char c = lower.charAt(i);
            if (c >= '0' && c <= '9') {
                out.append(c);
                continue;
            }
            int hashNibble = ((hash[i / 2] & 0xff) >> (i % 2 == 0 ? 4 : 0)) & 0x0f;
            out.append(hashNibble >= 8 ? Character.toUpperCase(c) : c);
        }
        return out.toString();
    }

    static byte[] keccak256(byte[] input) {
        KeccakDigest digest = new KeccakDigest(256);
        digest.update(input, 0, input.length);
        byte[] out = new byte[32];
        digest.doFinal(out, 0);
        return out;
    }

    private static byte[] toFixed32(BigInteger value) {
        byte[] raw = value.toByteArray();
        byte[] out = new byte[32];
        int srcPos = Math.max(0, raw.length - 32);
        int length = Math.min(raw.length, 32);
        System.arraycopy(raw, srcPos, out, 32 - length, length);
        return out;
    }

    private static String join(List<String> words) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < words.size(); i++) {
            if (i > 0) sb.append(' ');
            sb.append(words.get(i));
        }
        return sb.toString();
    }

    String serialize() {
        return "MNEMONIC=" + mnemonic + "\n"
                + "EVM_PRIVATE=" + Hex.bytesToHex(evm.privateKey) + "\n"
                + "EVM_ADDRESS=" + evm.address + "\n"
                + "SOLANA_SEED=" + Hex.bytesToHex(solana.privateSeed) + "\n"
                + "SOLANA_PUBLIC=" + Hex.bytesToHex(solana.publicKey) + "\n"
                + "SOLANA_ADDRESS=" + solana.address + "\n"
                + "STELLAR_SEED=" + Hex.bytesToHex(stellar.privateSeed) + "\n"
                + "STELLAR_PUBLIC=" + Hex.bytesToHex(stellar.publicKey) + "\n"
                + "STELLAR_ADDRESS=" + stellar.address;
    }

    static HDWallet parse(String data) throws Exception {
        return restore(get(data, "MNEMONIC"));
    }

    private static String get(String text, String key) {
        String prefix = key + "=";
        for (String line : text.split("\\n")) {
            if (line.startsWith(prefix)) return line.substring(prefix.length());
        }
        return "";
    }

    static final class EvmAccount {
        final byte[] privateKey;
        final String address;
        final String path;

        EvmAccount(byte[] privateKey, String address, String path) {
            this.privateKey = privateKey;
            this.address = address;
            this.path = path;
        }
    }

    static final class EdAccount {
        final byte[] privateSeed;
        final byte[] publicKey;
        final String address;
        final String path;

        EdAccount(byte[] privateSeed, byte[] publicKey, String address, String path) {
            this.privateSeed = privateSeed;
            this.publicKey = publicKey;
            this.address = address;
            this.path = path;
        }
    }
}
