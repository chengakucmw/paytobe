import CryptoKit
import Foundation
import Security

/// A locally built, signed Stellar transaction envelope that has **not** yet been
/// broadcast. Produced by `StellarService.signXLM` and consumed by
/// `StellarService.broadcastXLM`, so the `signed` lifecycle state can be reported
/// to the relay as its own ordered step before submission (bug M13).
struct SignedStellarTransaction {
    let envelopeBase64: String
    let txHash: String
    let horizonURL: URL
    let createAccount: Bool
}

actor StellarService {
    private let testnetPassphrase = "Test SDF Network ; September 2015"
    private let publicPassphrase = "Public Global Stellar Network ; September 2015"
    private let fallbackMinimumCreateAccountStroops: Int64 = 10_000_000
    private let defaultMnemonicWordCount = 24
    private let supportedMnemonicWordCounts: Set<Int> = [12, 15, 18, 21, 24]
    private let stellarDerivationPath = "m/44'/148'/0'"

    func generateWallet() throws -> StellarWallet {
        let phrase = try generateMnemonic(wordCount: defaultMnemonicWordCount)
        return try wallet(fromMnemonic: phrase, backupVerified: false, source: "generated")
    }

    func restoreWallet(mnemonic: String, backupVerified: Bool) throws -> StellarWallet {
        try wallet(fromMnemonic: mnemonic, backupVerified: backupVerified, source: "imported")
    }

    /// When true (default), Stellar key derivation is delegated to the shared
    /// cross-platform Rust core (crates/velarum-wallet-core) instead of the native
    /// Swift path below. Both produce identical results — pinned by the golden
    /// vector (GB3J…QBYX) and the conformance tests — so this preserves behaviour.
    /// Set to false to instantly revert to the native implementation.
    static var useSharedCoreDerivation = true

    private func wallet(fromMnemonic mnemonic: String, backupVerified: Bool, source: String) throws -> StellarWallet {
        let words = try validatedMnemonicWords(mnemonic)
        let phrase = words.joined(separator: " ")

        if Self.useSharedCoreDerivation {
            do {
                let keys = try stellarDerive(mnemonic: phrase, passphrase: "", account: 0)
                return StellarWallet(
                    seedBase64: keys.secretSeed.base64EncodedString(),
                    publicKeyBase64: keys.publicKey.base64EncodedString(),
                    address: keys.address,
                    recoveryPhrase: phrase,
                    mnemonicWordCount: words.count,
                    backupVerified: backupVerified,
                    derivationPath: keys.derivationPath,
                    walletSource: source
                )
            } catch let error as FfiWalletError {
                // Preserve the app's error type/UX for any core-side validation failure.
                throw AppError.invalidResponse(error.localizedDescription)
            }
        }

        let seed = bip39Seed(mnemonic: phrase)
        let privateSeed = try slip10Ed25519Seed(seed: seed, path: [44, 148, 0])
        let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: privateSeed)
        let publicKey = privateKey.publicKey.rawRepresentation
        return StellarWallet(
            seedBase64: privateSeed.base64EncodedString(),
            publicKeyBase64: publicKey.base64EncodedString(),
            address: try StellarStrKey.encodePublicKey(publicKey),
            recoveryPhrase: phrase,
            mnemonicWordCount: words.count,
            backupVerified: backupVerified,
            derivationPath: stellarDerivationPath,
            walletSource: source
        )
    }

    private func generateMnemonic(wordCount: Int) throws -> String {
        guard wordCount == 24 else { throw AppError.invalidResponse("New wallets must use a 24-word recovery phrase.") }
        let entropy = try secureRandomData(count: 32)
        let words = try bip39Words()
        let checksum = Data(SHA256.hash(data: entropy))
        let entropyBits = entropy.count * 8
        let checksumBits = entropyBits / 32
        let totalBits = entropyBits + checksumBits
        var phrase: [String] = []
        for wordIndex in 0..<(totalBits / 11) {
            var index = 0
            for bitOffset in 0..<11 {
                let bitIndex = wordIndex * 11 + bitOffset
                index = (index << 1) | bit(at: bitIndex, entropy: entropy, checksum: checksum, entropyBits: entropyBits)
            }
            phrase.append(words[index])
        }
        return phrase.joined(separator: " ")
    }

    private func validatedMnemonicWords(_ mnemonic: String) throws -> [String] {
        let words = mnemonic
            .lowercased()
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)
        guard supportedMnemonicWordCounts.contains(words.count) else {
            throw AppError.invalidResponse("Recovery phrase must be 12, 15, 18, 21, or 24 words.")
        }
        let wordList = try bip39Words()
        let wordIndex = Dictionary(uniqueKeysWithValues: wordList.enumerated().map { ($0.element, $0.offset) })
        var bits: [Int] = []
        for word in words {
            guard let index = wordIndex[word] else {
                throw AppError.invalidResponse("Recovery phrase contains a word that is not in the BIP-39 English list.")
            }
            for shift in stride(from: 10, through: 0, by: -1) {
                bits.append((index >> shift) & 1)
            }
        }
        let entropyBits = bits.count * 32 / 33
        let checksumBits = bits.count - entropyBits
        var entropy = Data(repeating: 0, count: entropyBits / 8)
        for bitIndex in 0..<entropyBits where bits[bitIndex] == 1 {
            entropy[bitIndex / 8] |= UInt8(1 << (7 - (bitIndex % 8)))
        }
        let checksum = Data(SHA256.hash(data: entropy))
        for checksumIndex in 0..<checksumBits {
            let expected = bit(at: checksumIndex, data: checksum)
            guard bits[entropyBits + checksumIndex] == expected else {
                throw AppError.invalidResponse("Recovery phrase checksum is invalid.")
            }
        }
        return words
    }

    private func bip39Seed(mnemonic: String, passphrase: String = "") -> Data {
        let password = mnemonic.decomposedStringWithCompatibilityMapping
        let salt = ("mnemonic" + passphrase).decomposedStringWithCompatibilityMapping
        return pbkdf2HmacSHA512(password: password, salt: salt, iterations: 2048, keyLength: 64)
    }

    private func pbkdf2HmacSHA512(password: String, salt: String, iterations: Int, keyLength: Int) -> Data {
        let passwordKey = SymmetricKey(data: Data(password.utf8))
        let saltData = Data(salt.utf8)
        let hashLength = 64
        let blockCount = Int(ceil(Double(keyLength) / Double(hashLength)))
        var derived = Data()
        for block in 1...blockCount {
            var input = saltData
            input.append(contentsOf: [
                UInt8((block >> 24) & 0xff),
                UInt8((block >> 16) & 0xff),
                UInt8((block >> 8) & 0xff),
                UInt8(block & 0xff)
            ])
            var u = Data(HMAC<SHA512>.authenticationCode(for: input, using: passwordKey))
            var t = [UInt8](u)
            for _ in 1..<iterations {
                u = Data(HMAC<SHA512>.authenticationCode(for: u, using: passwordKey))
                let uBytes = [UInt8](u)
                for index in 0..<t.count {
                    t[index] ^= uBytes[index]
                }
            }
            derived.append(contentsOf: t)
        }
        return Data(derived.prefix(keyLength))
    }

    private func slip10Ed25519Seed(seed: Data, path: [UInt32]) throws -> Data {
        var i = hmacSHA512(key: Data("ed25519 seed".utf8), data: seed)
        var key = Data(i.prefix(32))
        var chainCode = Data(i.suffix(32))
        for child in path {
            var data = Data([0])
            data.append(key)
            data.append(uint32BigEndian(child | 0x8000_0000))
            i = hmacSHA512(key: chainCode, data: data)
            key = Data(i.prefix(32))
            chainCode = Data(i.suffix(32))
        }
        guard key.count == 32 else { throw AppError.invalidResponse("Invalid derived Stellar key.") }
        return key
    }

    private func hmacSHA512(key: Data, data: Data) -> Data {
        Data(HMAC<SHA512>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    private func uint32BigEndian(_ value: UInt32) -> Data {
        Data([
            UInt8((value >> 24) & 0xff),
            UInt8((value >> 16) & 0xff),
            UInt8((value >> 8) & 0xff),
            UInt8(value & 0xff)
        ])
    }

    private func bit(at bitIndex: Int, entropy: Data, checksum: Data, entropyBits: Int) -> Int {
        if bitIndex < entropyBits {
            return bit(at: bitIndex, data: entropy)
        }
        return bit(at: bitIndex - entropyBits, data: checksum)
    }

    private func bit(at bitIndex: Int, data: Data) -> Int {
        let byte = data[bitIndex / 8]
        return Int((byte >> UInt8(7 - (bitIndex % 8))) & 1)
    }

    private func secureRandomData(count: Int) throws -> Data {
        var data = Data(repeating: 0, count: count)
        let status = data.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else { throw AppError.keychain(status) }
        return data
    }

    private func bip39Words() throws -> [String] {
        guard let url = Bundle.main.url(forResource: "bip39_english", withExtension: "txt", subdirectory: "WebAssets") else {
            throw AppError.invalidResponse("BIP-39 English word list is missing from the app bundle.")
        }
        let text = try String(contentsOf: url, encoding: .utf8)
        let words = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard words.count == 2048 else { throw AppError.invalidResponse("BIP-39 English word list is invalid.") }
        return words
    }

    /// Builds and signs a Stellar transaction locally **without broadcasting it**,
    /// returning the signed envelope and its hash.
    ///
    /// Split out from `sendXLM` for bug M13 so the caller can report the `signed`
    /// lifecycle state to the relay as its own ordered step — right after the
    /// envelope exists and *before* it is submitted to Horizon.
    func signXLM(
        wallet: StellarWallet,
        horizonURL: String,
        testnet: Bool,
        destinationAddress: String,
        amountXLM: String,
        memo: String = "",
        memoType: String = ""
    ) async throws -> SignedStellarTransaction {
        let horizon = normalizeHorizonURL(horizonURL, testnet: testnet)
        // M-3: defense in depth at the signing boundary. The passphrase below
        // decides real money vs test money, so it MUST agree with the Horizon
        // host we are about to broadcast to. Refuse to sign if a recognized host
        // contradicts the testnet flag rather than emit a valid mainnet signature
        // for a transaction the caller labeled testnet (or vice versa).
        try assertNetworkConsistency(horizon: horizon, testnet: testnet)
        let sourceAddress = wallet.address
        let sequence = try await fetchSequence(horizonURL: horizon, accountId: sourceAddress) + 1
        _ = try StellarStrKey.decodePublicKey(destinationAddress) // H-3: reject muxed up front
        let amount = try xlmToStroops(amountXLM)
        let createAccount = try await fetchAccount(horizonURL: horizon, accountId: destinationAddress) == nil
        if createAccount {
            let minimum = await fetchMinimumCreateAccountBalanceStroops(horizonURL: horizon)
            if amount < minimum {
                throw AppError.invalidResponse(
                    "Recipient Stellar account is not activated. Send at least \(stroopsToXLM(minimum)) XLM to create it, or ask the recipient to activate the account first."
                )
            }
        }

        return try buildSignedEnvelope(
            wallet: wallet,
            horizon: horizon,
            testnet: testnet,
            destinationAddress: destinationAddress,
            amountXLM: amountXLM,
            sequence: sequence,
            createAccount: createAccount,
            memo: memo,
            memoType: memoType
        )
    }

    /// When true (default), the transaction is built + signed by the shared Rust
    /// core (crates/velarum-wallet-core); when false, by the native Swift path
    /// below. A cross-check test asserts the two produce byte-identical envelopes,
    /// so this preserves behaviour. Network I/O (sequence, create-account decision,
    /// broadcast) is always native. Set to false to revert.
    static var useSharedCoreSigning = true

    /// Pure (no network) build-and-sign of a Stellar payment / create-account.
    /// Split out of `signXLM` so the core and native paths can be cross-checked.
    func buildSignedEnvelope(
        wallet: StellarWallet,
        horizon: URL,
        testnet: Bool,
        destinationAddress: String,
        amountXLM: String,
        sequence: Int64,
        createAccount: Bool,
        memo: String,
        memoType: String
    ) throws -> SignedStellarTransaction {
        if Self.useSharedCoreSigning {
            do {
                let signed = try stellarSignPayment(
                    secretSeed: wallet.seed,
                    networkPassphrase: testnet ? testnetPassphrase : publicPassphrase,
                    sequence: sequence,
                    destinationAddress: destinationAddress,
                    amountXlm: amountXLM,
                    memo: memo,
                    memoType: memoType,
                    createAccount: createAccount
                )
                return SignedStellarTransaction(
                    envelopeBase64: signed.envelopeBase64,
                    txHash: signed.txHashHex,
                    horizonURL: horizon,
                    createAccount: createAccount
                )
            } catch let error as FfiWalletError {
                throw AppError.invalidResponse(error.localizedDescription)
            }
        }

        let destinationPublic = try StellarStrKey.decodePublicKey(destinationAddress)
        let amount = try xlmToStroops(amountXLM)
        let tx = try transactionXDR(
            sourcePublic: wallet.publicKey,
            destinationPublic: destinationPublic,
            sequence: sequence,
            amount: amount,
            createAccount: createAccount,
            memo: memo,
            memoType: memoType
        )
        let passphrase = testnet ? testnetPassphrase : publicPassphrase
        var signatureBase = Data(SHA256.hash(data: Data(passphrase.utf8)))
        signatureBase.appendInt32(2)
        signatureBase.append(tx)
        let txHashData = Data(SHA256.hash(data: signatureBase))
        let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: wallet.seed)
        let signature = try privateKey.signature(for: txHashData)
        let envelope = try envelopeXDR(tx: tx, sourcePublic: wallet.publicKey, signature: signature)
        return SignedStellarTransaction(
            envelopeBase64: envelope.base64EncodedString(),
            txHash: txHashData.hexString,
            horizonURL: horizon,
            createAccount: createAccount
        )
    }

    /// Broadcasts a previously signed Stellar transaction to Horizon and returns
    /// the network transaction hash.
    func broadcastXLM(
        _ signed: SignedStellarTransaction,
        progress: @escaping (String) async -> Void
    ) async throws -> String {
        await progress(signed.createAccount ? "Signed Stellar Create Account transaction" : "Signed Stellar payment transaction")
        let body = "tx=\(formEscape(signed.envelopeBase64))"
        var request = URLRequest(url: signed.horizonURL.appendingPathComponent("transactions"))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(body.utf8)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw AppError.invalidResponse("Missing Horizon response.") }
            guard (200..<300).contains(http.statusCode) else {
                throw AppError.invalidResponse(stellarErrorMessage(httpCode: http.statusCode, data: data))
            }
            let object = try jsonObject(data)
            return string(object, "hash", fallback: signed.txHash)
        } catch is CancellationError {
            throw AppError.invalidResponse("Stellar submission was cancelled.")
        } catch {
            if try await waitForTransaction(horizonURL: signed.horizonURL, txHash: signed.txHash) {
                return signed.txHash
            }
            throw error
        }
    }

    /// Convenience wrapper preserving the original sign-then-broadcast behavior
    /// for callers that do not need the intermediate `signed` checkpoint.
    func sendXLM(
        wallet: StellarWallet,
        horizonURL: String,
        testnet: Bool,
        destinationAddress: String,
        amountXLM: String,
        memo: String = "",
        memoType: String = "",
        progress: @escaping (String) async -> Void
    ) async throws -> String {
        let signed = try await signXLM(
            wallet: wallet,
            horizonURL: horizonURL,
            testnet: testnet,
            destinationAddress: destinationAddress,
            amountXLM: amountXLM,
            memo: memo,
            memoType: memoType
        )
        return try await broadcastXLM(signed, progress: progress)
    }

    func canReceiveAsset(horizonURL: String, testnet: Bool, destinationAddress: String, assetCode: String, assetIssuer: String) async throws {
        let horizon = normalizeHorizonURL(horizonURL, testnet: testnet)
        _ = try StellarStrKey.decodePublicKey(destinationAddress)
        guard let account = try await fetchAccount(horizonURL: horizon, accountId: destinationAddress) else {
            throw AppError.invalidResponse("Recipient Stellar account is not activated. Non-XLM Stellar assets require an existing account.")
        }
        guard !assetCode.uppercased().isEmpty, assetCode.uppercased() != "XLM" else { return }
        guard !assetIssuer.isEmpty else {
            throw AppError.invalidResponse("Stellar \(assetCode) issuer is required before checking recipient trustline.")
        }
        _ = try StellarStrKey.decodePublicKey(assetIssuer)
        let balances = account["balances"] as? [[String: Any]] ?? []
        let hasTrustline = balances.contains {
            string($0, "asset_code").caseInsensitiveCompare(assetCode) == .orderedSame
                && string($0, "asset_issuer").caseInsensitiveCompare(assetIssuer) == .orderedSame
        }
        if !hasTrustline {
            throw AppError.invalidResponse("Recipient Stellar account does not have a trustline for \(assetCode):\(assetIssuer).")
        }
    }

    private func fetchSequence(horizonURL: URL, accountId: String) async throws -> Int64 {
        guard let account = try await fetchAccount(horizonURL: horizonURL, accountId: accountId) else {
            throw AppError.invalidResponse("Source Stellar account is not activated on this network. Fund it with XLM before sending.")
        }
        guard let sequence = Int64(string(account, "sequence")) else {
            throw AppError.invalidResponse("Horizon account response did not include a valid sequence.")
        }
        return sequence
    }

    private func fetchAccount(horizonURL: URL, accountId: String) async throws -> [String: Any]? {
        let url = horizonURL.appendingPathComponent("accounts").appendingPathComponent(accountId)
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse else { throw AppError.invalidResponse("Missing Horizon response.") }
        if http.statusCode == 404 { return nil }
        guard (200..<300).contains(http.statusCode) else {
            throw AppError.invalidResponse(stellarErrorMessage(httpCode: http.statusCode, data: data))
        }
        return try jsonObject(data)
    }

    private func fetchMinimumCreateAccountBalanceStroops(horizonURL: URL) async -> Int64 {
        do {
            var components = URLComponents(url: horizonURL.appendingPathComponent("ledgers"), resolvingAgainstBaseURL: false)
            components?.queryItems = [
                URLQueryItem(name: "order", value: "desc"),
                URLQueryItem(name: "limit", value: "1")
            ]
            guard let url = components?.url else { return fallbackMinimumCreateAccountStroops }
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return fallbackMinimumCreateAccountStroops
            }
            let root = try jsonObject(data)
            let embedded = root["_embedded"] as? [String: Any] ?? [:]
            let records = embedded["records"] as? [[String: Any]] ?? []
            let baseReserve = int64(records.first ?? [:], "base_reserve_in_stroops")
            return baseReserve > 0 ? baseReserve * 2 : fallbackMinimumCreateAccountStroops
        } catch {
            return fallbackMinimumCreateAccountStroops
        }
    }

    private func waitForTransaction(horizonURL: URL, txHash: String) async throws -> Bool {
        for _ in 0..<8 {
            try await Task.sleep(nanoseconds: 1_500_000_000)
            let url = horizonURL.appendingPathComponent("transactions").appendingPathComponent(txHash)
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse else { continue }
            if http.statusCode == 404 { continue }
            guard (200..<300).contains(http.statusCode) else { continue }
            let object = try jsonObject(data)
            if bool(object, "successful") { return true }
        }
        return false
    }

    private func transactionXDR(sourcePublic: Data, destinationPublic: Data, sequence: Int64, amount: Int64, createAccount: Bool, memo: String, memoType: String = "") throws -> Data {
        var out = Data()
        try out.writeAccountId(sourcePublic)
        out.appendInt32(100)
        out.appendInt64(sequence)
        out.appendInt32(0)
        try out.writeMemo(memo, type: memoType)
        out.appendInt32(1)
        out.appendBool(false)
        if createAccount {
            out.appendInt32(0)
            try out.writeAccountId(destinationPublic)
            out.appendInt64(amount)
        } else {
            out.appendInt32(1)
            try out.writeMuxedAccount(destinationPublic)
            out.appendInt32(0)
            out.appendInt64(amount)
        }
        out.appendInt32(0)
        return out
    }

    private func envelopeXDR(tx: Data, sourcePublic: Data, signature: Data) throws -> Data {
        var out = Data()
        out.appendInt32(2)
        out.append(tx)
        out.appendInt32(1)
        guard sourcePublic.count >= 4 else { throw AppError.invalidResponse("Invalid source public key.") }
        out.append(sourcePublic.suffix(4))
        try out.writeOpaque(signature)
        return out
    }

    private func normalizeHorizonURL(_ value: String, testnet: Bool) -> URL {
        let clean = value.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if let url = URL(string: clean), !clean.isEmpty { return url }
        return URL(string: testnet ? "https://horizon-testnet.stellar.org" : "https://horizon.stellar.org")!
    }

    /// M-3: the signing passphrase (mainnet = real funds, testnet = test funds)
    /// must match the Horizon host the signed envelope will be broadcast to. If a
    /// *recognized* Stellar host contradicts the requested network, refuse to sign
    /// — that contradiction means the request misdeclared its network and signing
    /// would mint a valid signature on the wrong chain. Unrecognized custom hosts
    /// cannot be classified, so they are allowed through on the declared flag.
    private func assertNetworkConsistency(horizon: URL, testnet: Bool) throws {
        let host = (horizon.host ?? "").lowercased()
        let hostIsTestnet = host.contains("testnet")
        let hostIsMainnet = host == "horizon.stellar.org" || host.hasSuffix(".horizon.stellar.org")
        if hostIsTestnet && !testnet {
            throw AppError.invalidResponse("Network mismatch: this request is labeled Stellar mainnet, but its Horizon endpoint is testnet (\(host)). Refusing to sign.")
        }
        if hostIsMainnet && testnet {
            throw AppError.invalidResponse("Network mismatch: this request is labeled Stellar testnet, but its Horizon endpoint is mainnet (\(host)). Refusing to sign.")
        }
    }

    private func stellarErrorMessage(httpCode: Int, data: Data) -> String {
        guard let root = try? jsonObject(data) else {
            return "Stellar Horizon HTTP \(httpCode): \(String(data: data, encoding: .utf8) ?? "")"
        }
        let extras = root["extras"] as? [String: Any] ?? [:]
        let codes = extras["result_codes"] as? [String: Any] ?? [:]
        let transaction = string(codes, "transaction")
        let operations = codes["operations"] as? [String] ?? []
        let operation = operations.first ?? ""
        if operation == "op_no_destination" {
            return "Recipient Stellar account is not activated. Send XLM with Create Account first."
        }
        if operation == "op_no_trust" {
            return "Recipient Stellar account does not have the required trustline."
        }
        if operation == "op_underfunded" {
            return "Source Stellar account does not have enough spendable balance after fees and minimum reserve."
        }
        if operation == "op_low_reserve" {
            return "Amount is below the current Stellar minimum reserve required to create a new account."
        }
        if transaction == "tx_bad_seq" {
            return "Stellar sequence number changed before submission. Refresh and retry."
        }
        let detail = firstNonEmpty(string(root, "detail"), string(root, "title"))
        return "Stellar transaction failed \(operation) \(transaction) \(detail)"
    }

    private func jsonObject(_ data: Data) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw AppError.invalidResponse("Invalid JSON response.")
        }
        return object
    }

    private func formEscape(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private func xlmToStroops(_ text: String) throws -> Int64 {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = clean.split(separator: ".", omittingEmptySubsequences: false)
        guard !parts.isEmpty, (parts.count == 1 || parts.count == 2), let whole = Int64(parts[0]) else {
            throw AppError.invalidResponse("Invalid XLM amount.")
        }
        let fractional = parts.count == 2 ? String(parts[1]) : ""
        guard fractional.count <= 7, fractional.allSatisfy({ $0.isNumber }) else {
            throw AppError.invalidResponse("XLM supports at most 7 decimal places.")
        }
        let paddedFraction = fractional.padding(toLength: 7, withPad: "0", startingAt: 0)
        guard let stroopFraction = Int64(paddedFraction) else {
            throw AppError.invalidResponse("Invalid XLM amount.")
        }
        let amount = whole * 10_000_000 + stroopFraction
        guard amount > 0 else { throw AppError.invalidResponse("XLM amount must be greater than zero.") }
        return amount
    }

    private func stroopsToXLM(_ stroops: Int64) -> String {
        let whole = stroops / 10_000_000
        let fraction = abs(stroops % 10_000_000)
        let fractionText = String(format: "%07d", fraction).replacingOccurrences(of: "0+$", with: "", options: .regularExpression)
        return fractionText.isEmpty ? "\(whole)" : "\(whole).\(fractionText)"
    }
}

enum StellarStrKey {
    private static let publicVersion: UInt8 = 6 << 3
    private static let seedVersion: UInt8 = 18 << 3
    /// Strkey version byte for a muxed account (`M…`), per SEP-23: 12 << 3.
    private static let muxedVersion: UInt8 = 12 << 3

    /// Shown when a recipient hands over a muxed (`M…`) address (H-3). Muxed
    /// addresses are valid Stellar destinations, but this build cannot yet encode
    /// the `KEY_TYPE_MUXED_ED25519` payment body, so we say so plainly instead of
    /// claiming the address is malformed.
    static let muxedUnsupportedMessage =
        "This is a muxed Stellar address (it starts with \"M\"). VelarumPay does not support muxed addresses yet — ask the recipient for their standard \"G...\" address (plus a memo / ID if this is an exchange or custodial deposit)."

    static func encodePublicKey(_ data: Data) throws -> String {
        try encode(version: publicVersion, payload: data)
    }

    static func encodeSeed(_ data: Data) throws -> String {
        try encode(version: seedVersion, payload: data)
    }

    static func decodePublicKey(_ value: String) throws -> Data {
        // H-3: a muxed address (`M…`, SEP-23) is a *valid* Stellar destination, but
        // this build does not yet encode the KEY_TYPE_MUXED_ED25519 payment body.
        // Detect it explicitly and fail with a clear, actionable message rather than
        // the generic "Invalid Stellar public address", which wrongly implied the
        // address was malformed and left the user stuck. The fast prefix check
        // catches it even when the checksum is off; the decoded version byte is the
        // authoritative confirmation.
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.uppercased().hasPrefix("M") {
            throw AppError.invalidResponse(muxedUnsupportedMessage)
        }
        let decoded = try decode(value)
        if decoded.version == muxedVersion {
            throw AppError.invalidResponse(muxedUnsupportedMessage)
        }
        guard decoded.version == publicVersion, decoded.payload.count == 32 else {
            throw AppError.invalidResponse("Invalid Stellar public address.")
        }
        return decoded.payload
    }

    private static func encode(version: UInt8, payload: Data) throws -> String {
        guard payload.count == 32 else { throw AppError.invalidResponse("Invalid Stellar key length.") }
        var data = Data([version])
        data.append(payload)
        let crc = crc16XModem(data)
        data.append(UInt8(crc & 0xff))
        data.append(UInt8((crc >> 8) & 0xff))
        return Base32.encode(data)
    }

    private static func decode(_ value: String) throws -> (version: UInt8, payload: Data) {
        let data = try Base32.decode(value)
        guard data.count >= 3 else { throw AppError.invalidResponse("Invalid Stellar address.") }
        let body = data.dropLast(2)
        let expected = crc16XModem(Data(body))
        let actual = UInt16(data[data.count - 2]) | (UInt16(data[data.count - 1]) << 8)
        guard expected == actual else { throw AppError.invalidResponse("Invalid Stellar address checksum.") }
        return (data[0], Data(data.dropFirst().dropLast(2)))
    }

    private static func crc16XModem(_ data: Data) -> UInt16 {
        var crc: UInt16 = 0
        for byte in data {
            crc ^= UInt16(byte) << 8
            for _ in 0..<8 {
                if (crc & 0x8000) != 0 {
                    crc = (crc << 1) ^ 0x1021
                } else {
                    crc <<= 1
                }
            }
        }
        return crc
    }
}

enum Base32 {
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

    static func encode(_ data: Data) -> String {
        var output = ""
        var buffer = 0
        var bitsLeft = 0
        for byte in data {
            buffer = (buffer << 8) | Int(byte)
            bitsLeft += 8
            while bitsLeft >= 5 {
                let index = (buffer >> (bitsLeft - 5)) & 31
                output.append(alphabet[index])
                bitsLeft -= 5
            }
        }
        if bitsLeft > 0 {
            let index = (buffer << (5 - bitsLeft)) & 31
            output.append(alphabet[index])
        }
        return output
    }

    static func decode(_ text: String) throws -> Data {
        let table = Dictionary(uniqueKeysWithValues: alphabet.enumerated().map { ($0.element, $0.offset) })
        var buffer = 0
        var bitsLeft = 0
        var out = Data()
        for char in text.uppercased() where char != "=" {
            guard let value = table[char] else { throw AppError.invalidResponse("Invalid base32 character.") }
            buffer = (buffer << 5) | value
            bitsLeft += 5
            if bitsLeft >= 8 {
                out.append(UInt8((buffer >> (bitsLeft - 8)) & 0xff))
                bitsLeft -= 8
            }
        }
        return out
    }
}

/// Decodes a Stellar MEMO_HASH / MEMO_RETURN value (exactly 32 bytes) from either
/// 64 hex characters or base64. Returns nil if the result is not exactly 32 bytes.
private func stellarMemoHash32(_ value: String) -> Data? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.count == 64, let hex = stellarHexData(trimmed), hex.count == 32 {
        return hex
    }
    if let decoded = Data(base64Encoded: trimmed), decoded.count == 32 {
        return decoded
    }
    return nil
}

private func stellarHexData(_ hex: String) -> Data? {
    let chars = Array(hex)
    guard chars.count % 2 == 0 else { return nil }
    var data = Data(capacity: chars.count / 2)
    var index = 0
    while index < chars.count {
        guard let high = chars[index].hexDigitValue, let low = chars[index + 1].hexDigitValue else { return nil }
        data.append(UInt8(high << 4 | low))
        index += 2
    }
    return data
}

extension Data {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }

    mutating func appendInt32(_ value: Int32) {
        append(UInt8((value >> 24) & 0xff))
        append(UInt8((value >> 16) & 0xff))
        append(UInt8((value >> 8) & 0xff))
        append(UInt8(value & 0xff))
    }

    mutating func appendInt64(_ value: Int64) {
        for shift in stride(from: 56, through: 0, by: -8) {
            append(UInt8((value >> Int64(shift)) & 0xff))
        }
    }

    /// XDR `uint64`, big-endian. Used by MEMO_ID (C-1): exchange deposit tags are
    /// unsigned 64-bit integers, so they must not go through the signed Int64 path.
    mutating func appendUInt64(_ value: UInt64) {
        for shift in stride(from: 56, through: 0, by: -8) {
            append(UInt8((value >> UInt64(shift)) & 0xff))
        }
    }

    mutating func appendBool(_ value: Bool) {
        appendInt32(value ? 1 : 0)
    }

    mutating func writeAccountId(_ publicKey: Data) throws {
        guard publicKey.count == 32 else { throw AppError.invalidResponse("Invalid Stellar account public key.") }
        appendInt32(0)
        append(publicKey)
    }

    /// Writes the XDR `MuxedAccount` union for a payment destination.
    ///
    /// H-3: this deliberately emits only the `KEY_TYPE_ED25519` arm (discriminant
    /// `0` + 32-byte ed25519 key), which is the correct encoding for a standard
    /// `G…` address. It does NOT produce a true muxed account
    /// (`KEY_TYPE_MUXED_ED25519`, discriminant `0x100` + 8-byte id + key): `M…`
    /// destinations are rejected upstream in `StellarStrKey.decodePublicKey`, so by
    /// the time we reach here the key is always a plain 32-byte ed25519 public key.
    /// The name previously implied muxed support that did not exist; this contract
    /// is now explicit, so real muxed support can be added deliberately (decode
    /// `M…`, emit discriminant `0x100`) and verified on testnet before use.
    mutating func writeMuxedAccount(_ publicKey: Data) throws {
        guard publicKey.count == 32 else { throw AppError.invalidResponse("Invalid Stellar account public key.") }
        appendInt32(0) // CryptoKeyType.KEY_TYPE_ED25519
        append(publicKey)
    }

    mutating func writeOpaque(_ value: Data) throws {
        appendInt32(Int32(value.count))
        append(value)
        let padding = (4 - (value.count % 4)) % 4
        if padding > 0 {
            append(contentsOf: Array(repeating: UInt8(0), count: padding))
        }
    }

    /// Writes a Stellar Memo union, honouring the memo's declared **type**.
    ///
    /// C-1 fix: most centralized exchanges require a numeric `MEMO_ID` (uint64)
    /// deposit memo. The previous code encoded every non-empty memo as
    /// `MEMO_TEXT`, so a numeric exchange tag like "100200300" went out as the
    /// *text* "100200300"; the exchange matches deposits on MEMO_ID and never
    /// credited the user — a silent loss of funds. We now branch on the type and
    /// FAIL CLOSED on a malformed id/hash rather than silently downgrading to
    /// text. An empty memo is always MEMO_NONE (byte-identical to the old no-memo
    /// behaviour) and an empty/"text" type keeps the original MEMO_TEXT path, so
    /// existing transactions and tests are unaffected.
    mutating func writeMemo(_ memo: String, type memoType: String = "") throws {
        let text = memo.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            appendInt32(0) // MEMO_NONE
            return
        }
        switch memoType.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "", "text":
            let bytes = Data(text.utf8)
            guard bytes.count <= 28 else {
                throw AppError.invalidResponse(
                    "Stellar text memo must be 28 bytes or fewer (this one is \(bytes.count)). Shorten it, or confirm the exchange wants a numeric ID memo instead.")
            }
            appendInt32(1) // MEMO_TEXT
            try writeOpaque(bytes)
        case "id":
            guard let memoId = UInt64(text) else {
                throw AppError.invalidResponse(
                    "Stellar numeric memo (MEMO_ID) must be a whole number from 0 to 18446744073709551615. Got \"\(text)\".")
            }
            appendInt32(2) // MEMO_ID
            appendUInt64(memoId)
        case "hash", "return":
            guard let hash = stellarMemoHash32(text) else {
                throw AppError.invalidResponse(
                    "Stellar \(memoType.lowercased()) memo must be exactly 32 bytes, encoded as 64 hex characters or base64.")
            }
            appendInt32(memoType.lowercased() == "hash" ? 3 : 4) // MEMO_HASH / MEMO_RETURN
            append(hash) // Hash is a fixed opaque[32]; 32 is already 4-byte aligned.
        default:
            throw AppError.invalidResponse(
                "Unsupported Stellar memo type \"\(memoType)\". Use \"text\", \"id\", \"hash\", or \"return\".")
        }
    }
}
