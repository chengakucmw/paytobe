import Foundation

final class RelayClient {
    struct Config: Equatable {
        var relayURL: String
        var deviceId: String
        var token: String

        var baseURL: URL {
            let clean = relayURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            return URL(string: clean) ?? URL(string: "https://relay-agentfood.velarumai.com")!
        }

        var websocketURL: URL {
            var value = relayURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if URL(string: value) == nil {
                value = "https://relay-agentfood.velarumai.com"
            }
            if value.hasPrefix("https://") {
                value = "wss://" + value.dropFirst("https://".count)
            } else if value.hasPrefix("http://") {
                value = "ws://" + value.dropFirst("http://".count)
            }
            var components = URLComponents(string: value + "/v1/ws/app") ?? URLComponents(string: "wss://relay-agentfood.velarumai.com/v1/ws/app")!
            components.queryItems = [
                URLQueryItem(name: "device_id", value: deviceId),
                URLQueryItem(name: "token", value: token)
            ]
            return components.url!
        }
    }

    private struct PairingLookup {
        var idOrCode: String
        var code: String
        var inputSource: String
    }

    private var webSocket: URLSessionWebSocketTask?
    private let session = URLSession(configuration: .default)

    func register(config: Config) async throws {
        _ = try await post(config: config, path: "/v1/devices/app", body: [
            "device_id": config.deviceId,
            "token": config.token
        ])
    }

    func createDemoSession(config: Config, label: String, telegramBot: String, stellarAddress: String, evmAddress: String = "") async throws -> [String: Any] {
        let response = try await post(config: config, path: "/v1/demo/sessions", body: [
            "device_id": config.deviceId,
            "token": config.token,
            "label": label,
            "telegram_bot": telegramBot,
            "stellar_address": stellarAddress,
            "evm_address": evmAddress
        ])
        return response["session"] as? [String: Any] ?? response
    }

    func fetchPairingSession(config: Config, input: String) async throws -> PairingSession {
        let lookup = try pairingLookup(from: input)
        var path = "/v1/pairing/sessions/\(urlEscape(lookup.idOrCode))"
        if !lookup.code.isEmpty {
            path += "?code=\(urlEscape(lookup.code))"
        }
        let response = try await get(config: config, path: path)
        guard let raw = response["pairing_session"] as? [String: Any] else {
            throw AppError.invalidResponse("Pairing response did not include a session.")
        }
        return try PairingSession.parse(raw, inputSource: lookup.inputSource)
    }

    func approvePairing(config: Config, session: PairingSession, scopes: [String]) async throws -> AgentConnection {
        let response = try await post(config: config, path: "/v1/pairing/sessions/\(urlEscape(session.pairingSessionId))/approve", body: [
            "device_id": config.deviceId,
            "token": config.token,
            "pairing_code": session.pairingCode,
            "approved_scopes": scopes
        ])
        guard let raw = response["connection"] as? [String: Any] else {
            throw AppError.invalidResponse("Approve response did not include a connection.")
        }
        return try AgentConnection.parse(raw)
    }

    func rejectPairing(config: Config, session: PairingSession) async throws {
        _ = try await post(config: config, path: "/v1/pairing/sessions/\(urlEscape(session.pairingSessionId))/reject", body: [
            "device_id": config.deviceId,
            "token": config.token,
            "pairing_code": session.pairingCode
        ])
    }

    func syncConnections(config: Config) async throws -> [AgentConnection] {
        let response = try await get(config: config, path: "/v1/connections?device_id=\(urlEscape(config.deviceId))&token=\(urlEscape(config.token))")
        let items = response["items"] as? [[String: Any]] ?? []
        return try items.map { try AgentConnection.parse($0) }
    }

    func updateConnectionStatus(config: Config, connection: AgentConnection, status: String) async throws -> AgentConnection {
        let response = try await patch(config: config, path: "/v1/connections/\(urlEscape(connection.connectionId))", body: [
            "device_id": config.deviceId,
            "token": config.token,
            "status": status
        ])
        guard let raw = response["connection"] as? [String: Any] else {
            throw AppError.invalidResponse("Connection response did not include a connection.")
        }
        return try AgentConnection.parse(raw)
    }

    func revokeConnection(config: Config, connection: AgentConnection) async throws -> AgentConnection {
        let response = try await delete(config: config, path: "/v1/connections/\(urlEscape(connection.connectionId))", body: [
            "device_id": config.deviceId,
            "token": config.token
        ])
        guard let raw = response["connection"] as? [String: Any] else {
            throw AppError.invalidResponse("Revoke response did not include a connection.")
        }
        return try AgentConnection.parse(raw)
    }

    func sync(config: Config) async throws -> [PaymentIntent] {
        let response = try await get(config: config, path: "/v1/payment-intents?device_id=\(urlEscape(config.deviceId))&token=\(urlEscape(config.token))")
        let items = response["items"] as? [[String: Any]] ?? []
        return try items.map { try PaymentIntent.parse($0) }.sorted { $0.createdAtMs > $1.createdAtMs }
    }

    func fetchIntent(config: Config, id: String) async throws -> PaymentIntent {
        let response = try await get(config: config, path: "/v1/payment-intents/\(urlEscape(id))?device_id=\(urlEscape(config.deviceId))&token=\(urlEscape(config.token))")
        guard let raw = response["intent"] as? [String: Any] else {
            throw AppError.invalidResponse("Relay response did not include intent.")
        }
        return try PaymentIntent.parse(raw)
    }

    func updateStatus(config: Config, intent: PaymentIntent, status: String, txHash: String? = nil, error: String? = nil) async throws {
        var body: [String: Any] = [
            "device_id": config.deviceId,
            "token": config.token,
            "status": status
        ]
        if let txHash { body["tx_hash"] = txHash }
        if let error { body["error"] = error }
        _ = try await post(config: config, path: "/v1/payment-intents/\(urlEscape(intent.id))/status", body: body)
    }

    func connect(config: Config, onIntentId: @escaping (String) async -> Void, onMessage: @escaping (String) async -> Void) {
        disconnect()
        let task = session.webSocketTask(with: config.websocketURL)
        webSocket = task
        task.resume()
        Task {
            await receiveLoop(task: task, onIntentId: onIntentId, onMessage: onMessage)
        }
    }

    func disconnect() {
        webSocket?.cancel(with: .normalClosure, reason: nil)
        webSocket = nil
    }

    private func receiveLoop(
        task: URLSessionWebSocketTask,
        onIntentId: @escaping (String) async -> Void,
        onMessage: @escaping (String) async -> Void
    ) async {
        while true {
            do {
                let message = try await task.receive()
                switch message {
                case .string(let text):
                    guard let data = text.data(using: .utf8),
                          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                        await onMessage(text)
                        continue
                    }
                    if string(object, "type") == "payment_intent" {
                        await onIntentId(string(object, "intent_id"))
                    } else {
                        await onMessage(text)
                    }
                case .data(let data):
                    await onMessage(String(data: data, encoding: .utf8) ?? "Binary relay message")
                @unknown default:
                    await onMessage("Unknown relay message")
                }
            } catch {
                await onMessage("Relay disconnected: \(error.localizedDescription)")
                return
            }
        }
    }

    private func get(config: Config, path: String) async throws -> [String: Any] {
        let url = endpoint(config: config, path: path)
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse else { throw AppError.invalidResponse("Missing relay response.") }
        guard (200..<300).contains(http.statusCode) else {
            throw AppError.invalidResponse("Relay HTTP \(http.statusCode): \(String(data: data, encoding: .utf8) ?? "")")
        }
        return try decodeObject(data)
    }

    private func post(config: Config, path: String, body: [String: Any]) async throws -> [String: Any] {
        try await send(config: config, method: "POST", path: path, body: body)
    }

    private func patch(config: Config, path: String, body: [String: Any]) async throws -> [String: Any] {
        try await send(config: config, method: "PATCH", path: path, body: body)
    }

    private func delete(config: Config, path: String, body: [String: Any]) async throws -> [String: Any] {
        try await send(config: config, method: "DELETE", path: path, body: body)
    }

    private func send(config: Config, method: String, path: String, body: [String: Any]) async throws -> [String: Any] {
        var request = URLRequest(url: endpoint(config: config, path: path))
        request.httpMethod = method
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw AppError.invalidResponse("Missing relay response.") }
        guard (200..<300).contains(http.statusCode) else {
            throw AppError.invalidResponse("Relay HTTP \(http.statusCode): \(String(data: data, encoding: .utf8) ?? "")")
        }
        if data.isEmpty { return [:] }
        return try decodeObject(data)
    }

    private func decodeObject(_ data: Data) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw AppError.invalidResponse("Invalid relay JSON response.")
        }
        return object
    }

    private func endpoint(config: Config, path: String) -> URL {
        URL(string: path, relativeTo: config.baseURL)!.absoluteURL
    }

    private func pairingLookup(from input: String) throws -> PairingLookup {
        let clean = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.range(of: #"^[0-9]{6}$"#, options: .regularExpression) != nil {
            return PairingLookup(idOrCode: clean, code: clean, inputSource: "Short code")
        }
        guard let components = URLComponents(string: clean),
              components.scheme?.lowercased() == "velarumpay" else {
            throw AppError.invalidResponse("Enter a 6-digit short code or velarumpay://pair URI.")
        }
        guard components.host?.lowercased() == "pair" || components.path == "/pair" else {
            throw AppError.invalidResponse("Enter a 6-digit short code or velarumpay://pair URI.")
        }
        let items = components.queryItems ?? []
        let sessionId = firstNonEmpty(
            items.first(where: { $0.name == "session" })?.value ?? "",
            items.first(where: { $0.name == "pairing_session_id" })?.value ?? ""
        )
        let code = firstNonEmpty(
            items.first(where: { $0.name == "code" })?.value ?? "",
            items.first(where: { $0.name == "pairing_code" })?.value ?? ""
        )
        let idOrCode = firstNonEmpty(sessionId, code)
        guard !idOrCode.isEmpty else {
            throw AppError.invalidResponse("Pairing URI is missing session or code.")
        }
        return PairingLookup(idOrCode: idOrCode, code: code, inputSource: sessionId.isEmpty ? "Short code" : "QR URI")
    }

    private func urlEscape(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
