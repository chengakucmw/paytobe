import XCTest
@testable import VelarumPay

// Conformance test for the SHARED Rust wallet core (crates/velarum-wallet-core),
// reached from iOS through the generated UniFFI bindings + VelarumWalletCore.xcframework.
//
// Proves two things on the real iOS toolchain:
//  1. iOS builds against and successfully calls the shared core, and
//  2. the core derives the SAME cross-platform golden Stellar address on iOS as
//     on Android and as the independent SEP-0005 reference
//     (tests/fixtures/hd-derivation-golden.json).
//
// The app's own StellarService is intentionally left unchanged for now; this test
// only exercises the shared core so integration is proven with zero production risk.
final class VelarumWalletCoreConformanceTests: XCTestCase {
    private let goldenMnemonic =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    private let goldenAddress = "GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX"
    private let testnetPassphrase = "Test SDF Network ; September 2015"

    func testCoreDerivesGoldenStellarAddress() throws {
        let keys = try stellarDerive(mnemonic: goldenMnemonic, passphrase: "", account: 0)
        XCTAssertEqual(
            keys.address,
            goldenAddress,
            "Shared Rust core derived a different Stellar address on iOS — cross-platform drift"
        )
        XCTAssertEqual(keys.derivationPath, "m/44'/148'/0'")
        XCTAssertEqual(keys.publicKey.count, 32)
        XCTAssertEqual(keys.secretSeed.count, 32)
    }

    func testCoreSignsDeterministically() throws {
        let keys = try stellarDerive(mnemonic: goldenMnemonic, passphrase: "", account: 0)
        let first = try stellarSignPayment(
            secretSeed: keys.secretSeed,
            networkPassphrase: testnetPassphrase,
            sequence: 7,
            destinationAddress: keys.address,
            amountXlm: "1.5",
            memo: "",
            memoType: "",
            createAccount: false
        )
        let second = try stellarSignPayment(
            secretSeed: keys.secretSeed,
            networkPassphrase: testnetPassphrase,
            sequence: 7,
            destinationAddress: keys.address,
            amountXlm: "1.5",
            memo: "",
            memoType: "",
            createAccount: false
        )
        XCTAssertEqual(first.envelopeBase64, second.envelopeBase64)
        XCTAssertEqual(first.txHashHex.count, 64)
    }

    func testCoreRejectsMuxedDestination() throws {
        let keys = try stellarDerive(mnemonic: goldenMnemonic, passphrase: "", account: 0)
        XCTAssertThrowsError(
            try stellarSignPayment(
                secretSeed: keys.secretSeed,
                networkPassphrase: testnetPassphrase,
                sequence: 1,
                destinationAddress: "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK",
                amountXlm: "1",
                memo: "",
                memoType: "",
                createAccount: false
            ),
            "muxed M… destination must be rejected (H-3)"
        )
    }
}
