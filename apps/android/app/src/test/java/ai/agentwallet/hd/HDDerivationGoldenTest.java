package ai.agentwallet.hd;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

/**
 * Cross-platform HD-derivation conformance test (Android side).
 *
 * The Android wallet must derive the SAME addresses as the canonical golden
 * vectors in tests/fixtures/hd-derivation-golden.json — the exact vectors the iOS
 * wallet (HDDerivationGoldenTests.swift) is also pinned to. Every value was computed
 * INDEPENDENTLY with the third-party bip_utils library (it depends on neither app
 * nor the Rust core). If Android key derivation ever drifts, Android and iOS would
 * compute DIFFERENT addresses from the same recovery phrase — funds would be sent to
 * an address the user does not control. This test fails the moment that happens.
 *
 * Stellar runs through the production path (HDWallet.restore, wired to the shared
 * Rust core); EVM and Solana exercise Android's native bitcoinj/bouncycastle
 * derivation — so this also locks those against the same independent oracle.
 */
public class HDDerivationGoldenTest {

    // {mnemonic, stellar_address, evm_address, solana_address}
    private static final String[][] VECTORS = {
        {
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
            "GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX",
            "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
            "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk"
        },
        {
            "legal winner thank year wave sausage worth useful legal winner thank yellow",
            "GAFOIIMIXWLSN66RYL32JHCI7AMKWZ3TYYSZTOXSTLPHJWPMZDERMXUO",
            "0x58A57ed9d8d624cBD12e2C467D34787555bB1b25",
            "BLeUXTx9thHGT7VJUtF9vHEmfMDgW1nnKZ9UVer2CoLX"
        },
        {
            "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
            "GBBWHEZC4L5ATI7RHDC7QEY5MMY7Z7BJUNA5VEI67GLGZQLBR3HJPKQI",
            "0x3061750d3dF69ef7B8d4407CB7f3F879Fd9d2398",
            "DeFBNaVhnpKkv1mG6vhCwQe3QzrGwMe1V5ust48PMQ9i"
        },
        {
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
            "GB3TCCIC6KLYKM72PX7KA6RNYC2BHC7DQYDMEAAN7PDMUZQD7UKJGSSY",
            "0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb",
            "3Cy3YNTFywCmxoxt8n7UH6hg6dLo5uACowX3CFceaSnx"
        }
    };

    @Test
    public void addressesMatchGoldenVectors() throws Exception {
        for (String[] v : VECTORS) {
            String mnemonic = v[0];
            HDWallet wallet = HDWallet.restore(mnemonic);
            assertEquals(
                "Android Stellar derivation drifted from the cross-platform golden vector (tests/fixtures/hd-derivation-golden.json)",
                v[1],
                wallet.stellar.address
            );
            assertEquals(
                "Android EVM derivation drifted from the cross-platform golden vector",
                v[2],
                wallet.evm.address
            );
            assertEquals(
                "Android Solana derivation drifted from the cross-platform golden vector",
                v[3],
                wallet.solana.address
            );
        }
    }
}
