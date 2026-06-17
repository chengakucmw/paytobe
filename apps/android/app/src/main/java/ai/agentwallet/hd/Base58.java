package ai.agentwallet.hd;

import java.math.BigInteger;
import java.util.Arrays;

final class Base58 {
    private static final char[] ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".toCharArray();
    private static final int[] INDEXES = new int[128];
    private static final BigInteger BASE = BigInteger.valueOf(58);

    static {
        Arrays.fill(INDEXES, -1);
        for (int i = 0; i < ALPHABET.length; i++) INDEXES[ALPHABET[i]] = i;
    }

    private Base58() {}

    static String encode(byte[] input) {
        if (input.length == 0) return "";
        int zeros = 0;
        while (zeros < input.length && input[zeros] == 0) zeros++;
        BigInteger value = new BigInteger(1, input);
        StringBuilder sb = new StringBuilder();
        while (value.compareTo(BigInteger.ZERO) > 0) {
            BigInteger[] divRem = value.divideAndRemainder(BASE);
            value = divRem[0];
            sb.append(ALPHABET[divRem[1].intValue()]);
        }
        for (int i = 0; i < zeros; i++) sb.append(ALPHABET[0]);
        return sb.reverse().toString();
    }

    static byte[] decode(String input) {
        if (input.length() == 0) return new byte[0];
        BigInteger value = BigInteger.ZERO;
        for (char c : input.toCharArray()) {
            if (c >= 128 || INDEXES[c] < 0) throw new IllegalArgumentException("Invalid base58 character");
            value = value.multiply(BASE).add(BigInteger.valueOf(INDEXES[c]));
        }
        byte[] bytes = value.toByteArray();
        if (bytes.length > 0 && bytes[0] == 0) bytes = Arrays.copyOfRange(bytes, 1, bytes.length);
        int zeros = 0;
        while (zeros < input.length() && input.charAt(zeros) == ALPHABET[0]) zeros++;
        byte[] out = new byte[zeros + bytes.length];
        System.arraycopy(bytes, 0, out, zeros, bytes.length);
        return out;
    }

    static byte[] concat(byte[] a, byte[] b) {
        byte[] out = Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }
}
