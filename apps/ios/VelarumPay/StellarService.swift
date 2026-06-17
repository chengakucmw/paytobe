import CryptoKit
import Foundation

actor StellarService {
    private let testnetPassphrase = "Test SDF Network ; September 2015"
    private let publicPassphrase = "Public Global Stellar Network ; September 2015"
    private let fallbackMinimumCreateAccountStroops: Int64 = 10_000_000

    func generateWallet() throws -> StellarWallet {
        let privateKey = Curve25519.Signing.PrivateKey()
        let seed = privateKey.rawRepresentation
        let publicKey = privateKey.publicKey.rawRepresentation
        return StellarWallet(
            seedBase64: seed.base64EncodedString(),
            publicKeyBase64: publicKey.base64EncodedString(),
            address: try StellarStrKey.encodePublicKey(publicKey)
        )
    }

    func sendXLM(
        wallet: StellarWallet,
        horizonURL: String,
        testnet: Bool,
        destinationAddress: String,
        amountXLM: String,
        progress: @escaping (String) async -> Void
    ) async throws -> String {
        let horizon = normalizeHorizonURL(horizonURL, testnet: testnet)
        let sourceAddress = wallet.address
        let sequence = try await fetchSequence(horizonURL: horizon, accountId: sourceAddress) + 1
        let destinationPublic = try StellarStrKey.decodePublicKey(destinationAddress)
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

        let tx = try transactionXDR(
            sourcePublic: wallet.publicKey,
            destinationPublic: destinationPublic,
            sequence: sequence,
            amount: amount,
            createAccount: createAccount
        )
        let passphrase = testnet ? testnetPassphrase : publicPassphrase
        var signatureBase = Data(SHA256.hash(data: Data(passphrase.utf8)))
        signatureBase.appendInt32(2)
        signatureBase.append(tx)
        let txHashData = Data(SHA256.hash(data: signatureBase))
        let txHash = txHashData.hexString
        let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: wallet.seed)
        let signature = try privateKey.signature(for: txHashData)
        let envelope = try envelopeXDR(tx: tx, sourcePublic: wallet.publicKey, signature: signature)
        let envelope64 = envelope.base64EncodedString()
        await progress(createAccount ? "Signed Stellar Create Account transaction" : "Signed Stellar payment transaction")
        let body = "tx=\(formEscape(envelope64))"
        var request = URLRequest(url: horizon.appendingPathComponent("transactions"))
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
            return string(object, "hash", fallback: txHash)
        } catch is CancellationError {
            throw AppError.invalidResponse("Stellar submission was cancelled.")
        } catch {
            if try await waitForTransaction(horizonURL: horizon, txHash: txHash) {
                return txHash
            }
            throw error
        }
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

    private func transactionXDR(sourcePublic: Data, destinationPublic: Data, sequence: Int64, amount: Int64, createAccount: Bool) throws -> Data {
        var out = Data()
        try out.writeAccountId(sourcePublic)
        out.appendInt32(100)
        out.appendInt64(sequence)
        out.appendInt32(0)
        out.appendInt32(0)
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

    static func encodePublicKey(_ data: Data) throws -> String {
        try encode(version: publicVersion, payload: data)
    }

    static func encodeSeed(_ data: Data) throws -> String {
        try encode(version: seedVersion, payload: data)
    }

    static func decodePublicKey(_ value: String) throws -> Data {
        let decoded = try decode(value)
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

    mutating func appendBool(_ value: Bool) {
        appendInt32(value ? 1 : 0)
    }

    mutating func writeAccountId(_ publicKey: Data) throws {
        guard publicKey.count == 32 else { throw AppError.invalidResponse("Invalid Stellar account public key.") }
        appendInt32(0)
        append(publicKey)
    }

    mutating func writeMuxedAccount(_ publicKey: Data) throws {
        guard publicKey.count == 32 else { throw AppError.invalidResponse("Invalid Stellar account public key.") }
        appendInt32(0)
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
}
