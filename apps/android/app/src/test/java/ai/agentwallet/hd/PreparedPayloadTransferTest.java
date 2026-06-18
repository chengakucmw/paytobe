package ai.agentwallet.hd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class PreparedPayloadTransferTest {
    private static final String MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    @Test
    public void secp256k1PreparedPayloadSignerProducesDerSignature() throws Exception {
        HDWallet wallet = HDWallet.restore(MNEMONIC);
        TransferAssetRegistry.Asset asset = TransferAssetRegistry.find("dogecoin_doge", "dogecoin_mainnet", "DOGE", 0);

        PreparedPayloadTransfer.SignedPayload signed = PreparedPayloadTransfer.signForTest(
                wallet,
                asset,
                "01020304",
                "hex",
                false
        );

        assertNotNull(signed);
        assertEquals("secp256k1-sha256", signed.algorithm);
        assertEquals("der_hex", signed.signatureEncoding);
        assertTrue(signed.signatureHex.length() > 120);
        assertEquals(64, signed.rHex.length());
        assertEquals(64, signed.sHex.length());
        assertEquals("m/44'/3'/0'/0/0", signed.derivationPath);
    }

    @Test
    public void ed25519PreparedPayloadSignerProducesRawSignature() throws Exception {
        HDWallet wallet = HDWallet.restore(MNEMONIC);
        TransferAssetRegistry.Asset asset = TransferAssetRegistry.find("sui_sui", "sui_mainnet", "SUI", 0);

        PreparedPayloadTransfer.SignedPayload signed = PreparedPayloadTransfer.signForTest(
                wallet,
                asset,
                "hello prepared transfer",
                "utf8",
                false
        );

        assertNotNull(signed);
        assertEquals("ed25519", signed.algorithm);
        assertEquals("hex", signed.signatureEncoding);
        assertEquals(128, signed.signatureHex.length());
        assertEquals("m/44'/784'/0'/0'", signed.derivationPath);
    }

    @Test
    public void starkPreparedPayloadSignerProducesRsSignature() throws Exception {
        HDWallet wallet = HDWallet.restore(MNEMONIC);
        TransferAssetRegistry.Asset asset = TransferAssetRegistry.find("starknet_strk", "starknet_mainnet", "STRK", 0);

        PreparedPayloadTransfer.SignedPayload signed = PreparedPayloadTransfer.signForTest(
                wallet,
                asset,
                "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
                "hex",
                true
        );

        assertNotNull(signed);
        assertEquals("stark-ecdsa", signed.algorithm);
        assertEquals("stark_rs_hex", signed.signatureEncoding);
        assertEquals(128, signed.signatureHex.length());
        assertEquals(64, signed.rHex.length());
        assertEquals(64, signed.sHex.length());
        assertEquals("m/44'/9004'/0'/0/0", signed.derivationPath);
    }
}
