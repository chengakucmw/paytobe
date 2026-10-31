// Stable Swift adapter for the Paytobe wallet-core C ABI.

import Foundation
import Paytobe_wallet_coreFFI

private let expectedWalletCoreAbiVersion: UInt32 = 1
private let maximumWalletCoreResponseBytes = 1_048_576

public enum FfiWalletError: Swift.Error, Equatable, Hashable, Foundation.LocalizedError {
    case Message(String)

    public var errorDescription: String? {
        switch self {
        case .Message(let message): return message
        }
    }
}

public struct FfiEvmKeys: Equatable, Hashable {
    public var address: String
    public var privateKey: Data
    public var derivationPath: String

    public init(address: String, privateKey: Data, derivationPath: String) {
        self.address = address
        self.privateKey = privateKey
        self.derivationPath = derivationPath
    }
}

public struct FfiEvmSignedTx: Equatable, Hashable {
    public var rawTxHex: String
    public var txHashHex: String

    public init(rawTxHex: String, txHashHex: String) {
        self.rawTxHex = rawTxHex
        self.txHashHex = txHashHex
    }
}

public struct FfiSignedStellarTransaction: Equatable, Hashable {
    public var envelopeBase64: String
    public var txHashHex: String
    public var createAccount: Bool

    public init(envelopeBase64: String, txHashHex: String, createAccount: Bool) {
        self.envelopeBase64 = envelopeBase64
        self.txHashHex = txHashHex
        self.createAccount = createAccount
    }
}

public struct FfiSolanaKeys: Equatable, Hashable {
    public var address: String
    public var publicKey: Data
    public var secretSeed: Data
    public var derivationPath: String

    public init(address: String, publicKey: Data, secretSeed: Data, derivationPath: String) {
        self.address = address
        self.publicKey = publicKey
        self.secretSeed = secretSeed
        self.derivationPath = derivationPath
    }
}

public struct FfiSolanaSignedTx: Equatable, Hashable {
    public var transactionBase64: String
    public var signatureBase58: String

    public init(transactionBase64: String, signatureBase58: String) {
        self.transactionBase64 = transactionBase64
        self.signatureBase58 = signatureBase58
    }
}

public struct FfiStellarKeys: Equatable, Hashable {
    public var address: String
    public var publicKey: Data
    public var secretSeed: Data
    public var derivationPath: String

    public init(address: String, publicKey: Data, secretSeed: Data, derivationPath: String) {
        self.address = address
        self.publicKey = publicKey
        self.secretSeed = secretSeed
        self.derivationPath = derivationPath
    }
}

private func walletCoreValue(method: String, request: [String: Any]) throws -> [String: Any] {
    guard Paytobe_wallet_core_abi_version() == expectedWalletCoreAbiVersion else {
        throw FfiWalletError.Message("Unsupported wallet-core ABI version.")
    }
    let methodData = Data(method.utf8)
    let requestData: Data
    do {
        requestData = try JSONSerialization.data(withJSONObject: request, options: [])
    } catch {
        throw FfiWalletError.Message("Could not encode wallet-core request: \(error.localizedDescription)")
    }

    let result = methodData.withUnsafeBytes { methodBytes in
        requestData.withUnsafeBytes { requestBytes in
            Paytobe_wallet_core_call(
                methodBytes.bindMemory(to: UInt8.self).baseAddress,
                methodData.count,
                requestBytes.bindMemory(to: UInt8.self).baseAddress,
                requestData.count
            )
        }
    }
    guard let result else {
        throw FfiWalletError.Message("Wallet core returned a null result handle.")
    }
    defer { Paytobe_wallet_core_result_free(result) }

    let length = Paytobe_wallet_core_result_len(result)
    guard length > 0, length <= maximumWalletCoreResponseBytes,
          let bytes = Paytobe_wallet_core_result_data(result) else {
        throw FfiWalletError.Message("Wallet core returned an invalid response buffer.")
    }
    let responseData = Data(bytes: bytes, count: length)
    let object: [String: Any]
    do {
        guard let decoded = try JSONSerialization.jsonObject(with: responseData) as? [String: Any] else {
            throw FfiWalletError.Message("Wallet core response was not a JSON object.")
        }
        object = decoded
    } catch let error as FfiWalletError {
        throw error
    } catch {
        throw FfiWalletError.Message("Could not decode wallet-core response: \(error.localizedDescription)")
    }

    guard object["ok"] as? Bool == true else {
        let details = object["error"] as? [String: Any]
        let message = details?["message"] as? String ?? "Wallet core rejected the request."
        throw FfiWalletError.Message(message)
    }
    guard let value = object["value"] as? [String: Any] else {
        throw FfiWalletError.Message("Wallet core response did not contain a value object.")
    }
    return value
}

private func requiredString(_ value: [String: Any], _ key: String) throws -> String {
    guard let result = value[key] as? String else {
        throw FfiWalletError.Message("Wallet core response is missing '\(key)'.")
    }
    return result
}

private func requiredData(_ value: [String: Any], _ key: String) throws -> Data {
    let encoded = try requiredString(value, key)
    guard let result = Data(base64Encoded: encoded) else {
        throw FfiWalletError.Message("Wallet core response contains invalid base64 in '\(key)'.")
    }
    return result
}

private func requiredBool(_ value: [String: Any], _ key: String) throws -> Bool {
    guard let result = value[key] as? Bool else {
        throw FfiWalletError.Message("Wallet core response is missing '\(key)'.")
    }
    return result
}

public func stellarDerive(mnemonic: String, passphrase: String, account: UInt32) throws -> FfiStellarKeys {
    let value = try walletCoreValue(method: "stellar_derive", request: [
        "mnemonic": mnemonic,
        "passphrase": passphrase,
        "account": account,
    ])
    return try FfiStellarKeys(
        address: requiredString(value, "address"),
        publicKey: requiredData(value, "publicKey"),
        secretSeed: requiredData(value, "secretSeed"),
        derivationPath: requiredString(value, "derivationPath")
    )
}

public func stellarSignPayment(
    secretSeed: Data,
    networkPassphrase: String,
    sequence: Int64,
    destinationAddress: String,
    amountXlm: String,
    memo: String,
    memoType: String,
    createAccount: Bool
) throws -> FfiSignedStellarTransaction {
    let value = try walletCoreValue(method: "stellar_sign_payment", request: [
        "secretSeed": secretSeed.base64EncodedString(),
        "networkPassphrase": networkPassphrase,
        "sequence": String(sequence),
        "destinationAddress": destinationAddress,
        "amountXlm": amountXlm,
        "memo": memo,
        "memoType": memoType,
        "createAccount": createAccount,
    ])
    return try FfiSignedStellarTransaction(
        envelopeBase64: requiredString(value, "envelopeBase64"),
        txHashHex: requiredString(value, "txHashHex"),
        createAccount: requiredBool(value, "createAccount")
    )
}

public func stellarXlmToStroops(amount: String) throws -> Int64 {
    let value = try walletCoreValue(method: "stellar_xlm_to_stroops", request: ["amount": amount])
    guard let stroops = Int64(try requiredString(value, "stroops")) else {
        throw FfiWalletError.Message("Wallet core returned invalid stroops.")
    }
    return stroops
}

public func stellarAssertNetworkConsistency(host: String, testnet: Bool) throws {
    _ = try walletCoreValue(
        method: "stellar_assert_network_consistency",
        request: ["host": host, "testnet": testnet]
    )
}

public func evmDerive(mnemonic: String, passphrase: String) throws -> FfiEvmKeys {
    let value = try walletCoreValue(
        method: "evm_derive",
        request: ["mnemonic": mnemonic, "passphrase": passphrase]
    )
    return try FfiEvmKeys(
        address: requiredString(value, "address"),
        privateKey: requiredData(value, "privateKey"),
        derivationPath: requiredString(value, "derivationPath")
    )
}

public func evmSignTransaction(
    privateKey: Data,
    chainId: UInt64,
    nonce: UInt64,
    gasPriceWei: String,
    gasLimit: UInt64,
    toAddress: String,
    valueWei: String,
    dataHex: String
) throws -> FfiEvmSignedTx {
    let value = try walletCoreValue(method: "evm_sign_transaction", request: [
        "privateKey": privateKey.base64EncodedString(),
        "chainId": String(chainId),
        "nonce": String(nonce),
        "gasPriceWei": gasPriceWei,
        "gasLimit": String(gasLimit),
        "toAddress": toAddress,
        "valueWei": valueWei,
        "dataHex": dataHex,
    ])
    return try FfiEvmSignedTx(
        rawTxHex: requiredString(value, "rawTxHex"),
        txHashHex: requiredString(value, "txHashHex")
    )
}

public func solanaDerive(mnemonic: String, passphrase: String) throws -> FfiSolanaKeys {
    let value = try walletCoreValue(
        method: "solana_derive",
        request: ["mnemonic": mnemonic, "passphrase": passphrase]
    )
    return try FfiSolanaKeys(
        address: requiredString(value, "address"),
        publicKey: requiredData(value, "publicKey"),
        secretSeed: requiredData(value, "secretSeed"),
        derivationPath: requiredString(value, "derivationPath")
    )
}

public func solanaSignTransfer(
    secretSeed: Data,
    toAddress: String,
    lamports: UInt64,
    recentBlockhash: String
) throws -> FfiSolanaSignedTx {
    let value = try walletCoreValue(method: "solana_sign_transfer", request: [
        "secretSeed": secretSeed.base64EncodedString(),
        "toAddress": toAddress,
        "lamports": String(lamports),
        "recentBlockhash": recentBlockhash,
    ])
    return try FfiSolanaSignedTx(
        transactionBase64: requiredString(value, "transactionBase64"),
        signatureBase58: requiredString(value, "signatureBase58")
    )
}

public func solanaSignSplTransfer(
    secretSeed: Data,
    sourceTokenAccount: String,
    destinationTokenAccount: String,
    mintAddress: String,
    recipientWallet: String,
    amountBaseUnits: String,
    decimals: UInt8,
    recentBlockhash: String,
    createDestinationAta: Bool
) throws -> FfiSolanaSignedTx {
    let value = try walletCoreValue(method: "solana_sign_spl_transfer", request: [
        "secretSeed": secretSeed.base64EncodedString(),
        "sourceTokenAccount": sourceTokenAccount,
        "destinationTokenAccount": destinationTokenAccount,
        "mintAddress": mintAddress,
        "recipientWallet": recipientWallet,
        "amountBaseUnits": amountBaseUnits,
        "decimals": decimals,
        "recentBlockhash": recentBlockhash,
        "createDestinationAta": createDestinationAta,
    ])
    return try FfiSolanaSignedTx(
        transactionBase64: requiredString(value, "transactionBase64"),
        signatureBase58: requiredString(value, "signatureBase58")
    )
}
