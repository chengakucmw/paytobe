import XCTest
@testable import VelarumPay

// Cross-platform HD-derivation conformance test (iOS side).
//
// The iOS wallet must derive the SAME Stellar address as the canonical golden
// vector in tests/fixtures/hd-derivation-golden.json — the exact vector the
// Android wallet (HDDerivationGoldenTest.java) is also pinned to. The value was
// computed independently with the SEP-0005 reference (stellar-hd-wallet), so it
// depends on neither app. If iOS key derivation ever drifts, iOS and Android
// would compute DIFFERENT addresses from the same recovery phrase — funds would
// be sent to an address the user does not control. This test fails the moment
// that happens.
final class HDDerivationGoldenTests: XCTestCase {
    func testStellarAddressMatchesGoldenVector() async throws {
        let mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        let expected = "GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX"

        let wallet = try await StellarService().restoreWallet(mnemonic: mnemonic, backupVerified: true)

        XCTAssertEqual(
            wallet.address,
            expected,
            "iOS Stellar derivation drifted from the cross-platform golden vector (tests/fixtures/hd-derivation-golden.json)"
        )
    }
}
