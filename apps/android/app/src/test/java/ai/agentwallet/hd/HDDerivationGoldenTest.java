package ai.agentwallet.hd;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

/**
 * Cross-platform HD-derivation conformance test (Android side).
 *
 * The Android wallet must derive the SAME Stellar address as the canonical golden
 * vector in tests/fixtures/hd-derivation-golden.json — the exact vector the iOS
 * wallet (HDDerivationGoldenTests.swift) is also pinned to. The value was computed
 * independently with the SEP-0005 reference (stellar-hd-wallet), so it depends on
 * neither app. If Android key derivation ever drifts, Android and iOS would compute
 * DIFFERENT addresses from the same recovery phrase — funds would be sent to an
 * address the user does not control. This test fails the moment that happens.
 *
 * (The existing HDWalletTest only checks the address starts with "G"; this pins the
 * EXACT address so drift can no longer slip through.)
 */
public class HDDerivationGoldenTest {
    @Test
    public void stellarAddressMatchesGoldenVector() throws Exception {
        String mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        String expected = "GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX";

        HDWallet wallet = HDWallet.restore(mnemonic);

        assertEquals(
            "Android Stellar derivation drifted from the cross-platform golden vector (tests/fixtures/hd-derivation-golden.json)",
            expected,
            wallet.stellar.address
        );
    }
}
