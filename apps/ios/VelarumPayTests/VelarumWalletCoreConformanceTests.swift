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

    /// Gate for the signing flip: the shared core must build + sign the exact same
    /// envelope (byte for byte) as the native Swift path, for representative inputs.
    func testCoreSigningMatchesNativeEnvelopeByteForByte() async throws {
        let service = StellarService()
        let wallet = try await service.restoreWallet(mnemonic: goldenMnemonic, backupVerified: true)
        let horizon = URL(string: "https://horizon-testnet.stellar.org")!
        // (amountXLM, memo, memoType, createAccount)
        let cases: [(String, String, String, Bool)] = [
            ("1.5", "", "", false),
            ("2.5", "exchange-note", "text", false),
            ("10", "100200300", "id", false),
            ("3", "", "", true),
        ]
        for (amount, memo, memoType, createAccount) in cases {
            StellarService.useSharedCoreSigning = false
            let native = try await service.buildSignedEnvelope(
                wallet: wallet, horizon: horizon, testnet: true,
                destinationAddress: wallet.address, amountXLM: amount,
                sequence: 42, createAccount: createAccount, memo: memo, memoType: memoType)
            StellarService.useSharedCoreSigning = true
            let core = try await service.buildSignedEnvelope(
                wallet: wallet, horizon: horizon, testnet: true,
                destinationAddress: wallet.address, amountXLM: amount,
                sequence: 42, createAccount: createAccount, memo: memo, memoType: memoType)
            // Apple's CryptoKit ed25519 signatures are RANDOMIZED (valid per RFC
            // 8032), while the core (dalek) is deterministic, so the 64-byte
            // signature legitimately differs. Equivalence is proven by an identical
            // transaction hash — i.e. the core signs the byte-identical transaction.
            XCTAssertEqual(native.txHash, core.txHash,
                "native vs shared-core TRANSACTION differs for amount=\(amount) memo=\(memo)/\(memoType) createAccount=\(createAccount)")
            // Both envelopes share everything up to the signature (same source key,
            // fee, seq, memo, op): confirm the non-signature prefix matches too.
            XCTAssertEqual(
                String(native.envelopeBase64.prefix(120)),
                String(core.envelopeBase64.prefix(120)),
                "envelope prefix (pre-signature) differs for amount=\(amount)")
        }
        StellarService.useSharedCoreSigning = true
    }

    /// iOS gains EVM + Solana via the shared core (Android already had them).
    func testCoreDerivesEvmAndSolanaAddresses() throws {
        let evm = try evmDerive(mnemonic: goldenMnemonic, passphrase: "")
        XCTAssertEqual(evm.address, "0x9858EfFD232B4033E47d90003D41EC34EcaEda94")
        XCTAssertEqual(evm.derivationPath, "m/44'/60'/0'/0/0")
        XCTAssertEqual(evm.privateKey.count, 32)

        let sol = try solanaDerive(mnemonic: goldenMnemonic, passphrase: "")
        XCTAssertEqual(sol.address, "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk")
        XCTAssertEqual(sol.derivationPath, "m/44'/501'/0'/0'")
        XCTAssertEqual(sol.publicKey.count, 32)
    }

    /// iOS gains EVM + Solana signing via the shared core (verified vs ethers.js / web3.js).
    func testCoreSignsEvmAndSolanaTransactions() throws {
        let evmKeys = try evmDerive(mnemonic: goldenMnemonic, passphrase: "")
        let evm = try evmSignTransaction(
            privateKey: evmKeys.privateKey, chainId: 1, nonce: 0,
            gasPriceWei: "20000000000", gasLimit: 21000,
            toAddress: "0x000000000000000000000000000000000000dEaD",
            valueWei: "1000000000000000000", dataHex: "")
        XCTAssertEqual(evm.rawTxHex, "0xf86c808504a817c80082520894000000000000000000000000000000000000dead880de0b6b3a76400008026a0d752eab9909ac7da6e7058d003b2c4f694cd8d28ce736a23eacbcd92eddb5b2ba07464ea202ccd1d049e2b3af256472775f0fbfa0a90fdeea357fa11785ac9de0f")

        let solKeys = try solanaDerive(mnemonic: goldenMnemonic, passphrase: "")
        let sol = try solanaSignTransfer(
            secretSeed: solKeys.secretSeed,
            toAddress: "11111111111111111111111111111112",
            lamports: 1_000_000_000,
            recentBlockhash: "11111111111111111111111111111111")
        XCTAssertEqual(sol.signatureBase58, "5P8bb3PVxxxYzqNShZtu93F9SumLwKvi25ThAbhYPS5Ssyp2aqrvX8rXnVcYteLTdcpCky8xQzcox6rKC3kH3NgA")
    }
}
