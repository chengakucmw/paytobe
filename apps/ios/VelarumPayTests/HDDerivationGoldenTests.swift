import XCTest
@testable import VelarumPay

// Cross-platform HD-derivation conformance test (iOS side).
//
// The iOS wallet must derive the SAME addresses as the canonical golden vectors
// in tests/fixtures/hd-derivation-golden.json — the exact vectors the Android
// wallet (HDDerivationGoldenTest.java) is also pinned to. Every value was computed
// INDEPENDENTLY with the third-party bip_utils library (it depends on neither app
// nor the Rust core), so a mismatch here is a real bug. If iOS key derivation ever
// drifts, iOS and Android would compute DIFFERENT addresses from the same recovery
// phrase — funds would be sent to an address the user does not control. This test
// fails the moment that happens.
//
// Stellar runs through the production path (StellarService.restoreWallet, which is
// wired to the shared Rust core); EVM and Solana run through the shared core's
// evmDerive / solanaDerive.
final class HDDerivationGoldenTests: XCTestCase {
    private struct Vector {
        let mnemonic: String
        let stellar: String
        let evm: String
        let solana: String
    }

    private let vectors: [Vector] = [
        Vector(
            mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
            stellar: "GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX",
            evm: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
            solana: "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk"
        ),
        Vector(
            mnemonic: "legal winner thank year wave sausage worth useful legal winner thank yellow",
            stellar: "GAFOIIMIXWLSN66RYL32JHCI7AMKWZ3TYYSZTOXSTLPHJWPMZDERMXUO",
            evm: "0x58A57ed9d8d624cBD12e2C467D34787555bB1b25",
            solana: "BLeUXTx9thHGT7VJUtF9vHEmfMDgW1nnKZ9UVer2CoLX"
        ),
        Vector(
            mnemonic: "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
            stellar: "GBBWHEZC4L5ATI7RHDC7QEY5MMY7Z7BJUNA5VEI67GLGZQLBR3HJPKQI",
            evm: "0x3061750d3dF69ef7B8d4407CB7f3F879Fd9d2398",
            solana: "DeFBNaVhnpKkv1mG6vhCwQe3QzrGwMe1V5ust48PMQ9i"
        ),
        Vector(
            mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
            stellar: "GB3TCCIC6KLYKM72PX7KA6RNYC2BHC7DQYDMEAAN7PDMUZQD7UKJGSSY",
            evm: "0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb",
            solana: "3Cy3YNTFywCmxoxt8n7UH6hg6dLo5uACowX3CFceaSnx"
        )
    ]

    func testStellarAddressesMatchGoldenVectors() async throws {
        for v in vectors {
            let wallet = try await StellarService().restoreWallet(mnemonic: v.mnemonic, backupVerified: true)
            XCTAssertEqual(
                wallet.address,
                v.stellar,
                "iOS Stellar derivation drifted from the cross-platform golden vector (tests/fixtures/hd-derivation-golden.json)"
            )
        }
    }

    func testEvmAddressesMatchGoldenVectors() throws {
        for v in vectors {
            let keys = try evmDerive(mnemonic: v.mnemonic, passphrase: "")
            XCTAssertEqual(
                keys.address,
                v.evm,
                "iOS EVM derivation drifted from the cross-platform golden vector"
            )
        }
    }

    func testSolanaAddressesMatchGoldenVectors() throws {
        for v in vectors {
            let keys = try solanaDerive(mnemonic: v.mnemonic, passphrase: "")
            XCTAssertEqual(
                keys.address,
                v.solana,
                "iOS Solana derivation drifted from the cross-platform golden vector"
            )
        }
    }
}
