package ai.agentwallet.hd;

import java.util.Arrays;

final class StellarStrKey {
    private static final char[] BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".toCharArray();
    private static final byte VERSION_PUBLIC_KEY = (byte) (6 << 3);
    private static final byte VERSION_SEED = (byte) (18 << 3);

    private StellarStrKey() {}

    static String encodePublicKey(byte[] publicKey32) {
        return encodeCheck(VERSION_PUBLIC_KEY, publicKey32);
    }

    static String encodeSeed(byte[] seed32) {
        return encodeCheck(VERSION_SEED, seed32);
    }

    static byte[] decodePublicKey(String address) {
        byte[] decoded = base32Decode(address);
        if (decoded.length != 35 || decoded[0] != VERSION_PUBLIC_KEY) {
            throw new IllegalArgumentException("Invalid Stellar public address");
        }
        byte[] withoutChecksum = Arrays.copyOfRange(decoded, 0, decoded.length - 2);
        int expected = crc16Xmodem(withoutChecksum);
        int actual = (decoded[decoded.length - 2] & 0xff) | ((decoded[decoded.length - 1] & 0xff) << 8);
        if (expected != actual) throw new IllegalArgumentException("Invalid Stellar checksum");
        return Arrays.copyOfRange(decoded, 1, 33);
    }

    private static String encodeCheck(byte versionByte, byte[] payload) {
        byte[] versioned = new byte[1 + payload.length];
        versioned[0] = versionByte;
        System.arraycopy(payload, 0, versioned, 1, payload.length);
        int crc = crc16Xmodem(versioned);
        byte[] full = Arrays.copyOf(versioned, versioned.length + 2);
        full[full.length - 2] = (byte) (crc & 0xff);
        full[full.length - 1] = (byte) ((crc >> 8) & 0xff);
        return base32NoPadding(full);
    }

    private static String base32NoPadding(byte[] data) {
        StringBuilder out = new StringBuilder((data.length * 8 + 4) / 5);
        int buffer = 0;
        int bitsLeft = 0;
        for (byte datum : data) {
            buffer = (buffer << 8) | (datum & 0xff);
            bitsLeft += 8;
            while (bitsLeft >= 5) {
                out.append(BASE32[(buffer >> (bitsLeft - 5)) & 31]);
                bitsLeft -= 5;
            }
        }
        if (bitsLeft > 0) out.append(BASE32[(buffer << (5 - bitsLeft)) & 31]);
        return out.toString();
    }

    private static byte[] base32Decode(String input) {
        String clean = input.trim().replace("=", "").toUpperCase();
        int buffer = 0;
        int bitsLeft = 0;
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        for (char c : clean.toCharArray()) {
            int value;
            if (c >= 'A' && c <= 'Z') value = c - 'A';
            else if (c >= '2' && c <= '7') value = c - '2' + 26;
            else throw new IllegalArgumentException("Invalid base32 character");
            buffer = (buffer << 5) | value;
            bitsLeft += 5;
            if (bitsLeft >= 8) {
                out.write((buffer >> (bitsLeft - 8)) & 0xff);
                bitsLeft -= 8;
            }
        }
        return out.toByteArray();
    }

    private static int crc16Xmodem(byte[] bytes) {
        int crc = 0x0000;
        for (byte b : bytes) {
            crc ^= (b & 0xff) << 8;
            for (int i = 0; i < 8; i++) {
                crc = (crc & 0x8000) != 0 ? (crc << 1) ^ 0x1021 : crc << 1;
                crc &= 0xffff;
            }
        }
        return crc & 0xffff;
    }
}
