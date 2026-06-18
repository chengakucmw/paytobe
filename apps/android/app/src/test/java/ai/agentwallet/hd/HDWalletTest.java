package ai.agentwallet.hd;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class HDWalletTest {
    @Test
    public void createDefaultsToTwentyFourWordMnemonic() throws Exception {
        HDWallet wallet = HDWallet.create();

        assertEquals(24, wallet.wordCount());
        assertEquals(HDWallet.DEFAULT_MNEMONIC_WORD_COUNT, wallet.wordCount());
    }

    @Test
    public void restoreAcceptsTwelveWordBip39Mnemonic() throws Exception {
        HDWallet wallet = HDWallet.restore("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");

        assertEquals(12, wallet.wordCount());
        assertTrue(wallet.evm.address.startsWith("0x"));
        assertTrue(wallet.stellar.address.startsWith("G"));
    }

    @Test
    public void restoreAcceptsTwentyFourWordBip39Mnemonic() throws Exception {
        HDWallet wallet = HDWallet.restore("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art");

        assertEquals(24, wallet.wordCount());
        assertTrue(wallet.solana.address.length() > 30);
    }
}
