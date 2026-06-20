import Foundation

final class RelayClient {
    struct Config: Equatable {
        var relayURL: String
        var deviceId: String
        var token: String

        // B9: match Android RelayClient's cleartext policy. Plain http/ws is allowed only to
        // local development hosts; every other host must use https/wss, so device tokens and
        // payment traffic are never sent in the clear at the app layer (ATS is a second line
        // of defence, not the only one).
        private static let cleartextDevHosts: Set<String> = [
            "localhost", "127.0.0.1", "::1", "0.0.0.0", "10.0.2.2", "10.0.3.2"
        ]

        private static func cleartextAllowed(_ urlString: String) -> Bool {
            guard let host = URLComponents(string: urlString)?.host?.lowercased() else { return false }
            if cleartextDevHosts.contains(host) { return true }
            return host.hasSuffix(".local")
        }

        var baseURL: URL? {
            let clean = relayURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard !clean.isEmpty else { return nil }
            if clean.lowercased().hasPrefix("http://"), !Config.cleartextAllowed(clean) { return nil }
            return URL(string: clean)
        }

        var websocketURL: URL? {
            var value = relayURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard !value.isEmpty, URL(string: value) != nil else { return nil }
            if value.hasPrefix("https://") {
                value = "wss://" + value.dropFirst("https://".count)
            } else if value.hasPrefix("http://") {
                guard Config.cleartextAllowed(value) else { return nil }
                value = "ws://" + value.dropFirst("http://".count)
            } else {
                return nil
            }
            guard var components = URLComponents(string: value + "/v1/ws/app") else { return nil }
            components.queryItems = [
                URLQueryItem(name: "device_id", value: deviceId),
                URLQueryItem(name: "token", value: token)
            ]
            return components.url
        }
    }

    struct PairingLookup: Equatable {
        var idOrCode: String
        var code: String
        var inputSource: String
    }

    private var webSocket: URLSessionWebSocketTask?
    private var connectionTask: Task<Void, Never>?
    private var shouldReconnect = false
    private var currentConfig: Config?
    private let session = URLSession(configuration: .default)

    func register(config: Config) async throws {
        _ = try await post(config: config, path: "/v1/devices/app", body: [
            "device_id": config.deviceId,
            "token": config.token
        ])
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
        do {
            let response = try await get(config: config, path: "/v1/payment-requests?device_id=\(urlEscape(config.deviceId))&token=\(urlEscape(config.token))")
            let items = response["items"] as? [[String: Any]] ?? []
            return try items.map { try PaymentIntent.parse($0) }.sorted { $0.createdAtMs > $1.createdAtMs }
        } catch {
            return try await syncLegacyIntents(config: config)
        }
    }

    private func syncLegacyIntents(config: Config) async throws -> [PaymentIntent] {
        let response = try await get(config: config, path: "/v1/payment-intents?device_id=\(urlEscape(config.deviceId))&token=\(urlEscape(config.token))")
        let items = response["items"] as? [[String: Any]] ?? []
        return try items.map { try PaymentIntent.parse($0) }.sorted { $0.createdAtMs > $1.createdAtMs }
    }

    func fetchIntent(config: Config, id: String) async throws -> PaymentIntent {
        do {
            let response = try await get(config: config, path: "/v1/payment-requests/\(urlEscape(id))?device_id=\(urlEscape(config.deviceId))&token=\(urlEscape(config.token))")
            guard let raw = response["payment_request"] as? [String: Any] else {
                throw AppError.invalidResponse("Relay response did not include payment_request.")
            }
            return try PaymentIntent.parse(raw)
        } catch {
            return try await fetchLegacyIntent(config: config, id: id)
        }
    }

    private func fetchLegacyIntent(config: Config, id: String) async throws -> PaymentIntent {
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
        if intent.isStandardPaymentRequest {
            _ = try await post(config: config, path: "/v1/payment-requests/\(urlEscape(intent.id))/status", body: body)
        } else {
            _ = try await post(config: config, path: "/v1/payment-intents/\(urlEscape(intent.id))/status", body: body)
        }
    }

    /// Opens the relay WebSocket and keeps it open. If the socket drops — which
    /// happens routinely when the app is backgrounded or the network changes —
    /// it reconnects automatically with exponential backoff until `disconnect()`
    /// is called. Calling `connect` again with the same config while already
    /// connected is a no-op, so it is safe to call on every foreground.
    @MainActor
    func connect(
        config: Config,
        onIntentId: @escaping (String) async -> Void,
        onMessage: @escaping (String) async -> Void
    ) {
        if let task = connectionTask, !task.isCancelled, shouldReconnect, currentConfig == config {
            return
        }
        let previous = connectionTask
        teardown()
        guard config.websocketURL != nil else {
            Task { await onMessage("Set Relay URL first.") }
            return
        }
        shouldReconnect = true
        currentConfig = config
        connectionTask = Task { [weak self] in
            // Let any prior supervisor fully unwind (teardown cancelled it) so a
            // superseded loop can never publish a stale socket alongside this one.
            await previous?.value
            await self?.maintainConnection(config: config, onIntentId: onIntentId, onMessage: onMessage)
        }
    }

    @MainActor
    func disconnect() {
        teardown()
        currentConfig = nil
    }

    @MainActor
    private func teardown() {
        shouldReconnect = false
        connectionTask?.cancel()
        connectionTask = nil
        webSocket?.cancel(with: .normalClosure, reason: nil)
        webSocket = nil
    }

    /// Supervises one logical connection: (re)open the socket, pump the receive
    /// loop, and on any drop wait with backoff before reopening — repeating
    /// until `disconnect()` flips `shouldReconnect` off or the task is cancelled.
    @MainActor
    private func maintainConnection(
        config: Config,
        onIntentId: @escaping (String) async -> Void,
        onMessage: @escaping (String) async -> Void
    ) async {
        var attempt = 0
        while shouldReconnect && !Task.isCancelled {
            guard let url = config.websocketURL else {
                await onMessage("Set Relay URL first.")
                return
            }
            let task = session.webSocketTask(with: url)
            webSocket = task
            task.resume()
            await onMessage(attempt == 0 ? "Relay connected" : "Relay reconnected")

            let result = await receiveLoop(task: task, onIntentId: onIntentId, onMessage: onMessage)

            if !shouldReconnect || Task.isCancelled { break }

            // A connection that delivered at least one message counts as healthy,
            // so the next drop restarts backoff from the shortest delay.
            attempt = result.receivedAny ? 1 : attempt + 1
            let delay = reconnectDelaySeconds(forAttempt: attempt)
            await onMessage("Relay disconnected. Reconnecting in \(Int(delay.rounded()))s…")
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }
    }

    /// Exponential backoff with light jitter, capped at 30 seconds.
    private func reconnectDelaySeconds(forAttempt attempt: Int) -> Double {
        let base = 1.0
        let maxDelay = 30.0
        let capped = min(maxDelay, base * pow(2.0, Double(max(0, attempt - 1))))
        let jitter = Double.random(in: 0...0.3) * capped
        return min(maxDelay, capped + jitter)
    }

    @MainActor
    private func receiveLoop(
        task: URLSessionWebSocketTask,
        onIntentId: @escaping (String) async -> Void,
        onMessage: @escaping (String) async -> Void
    ) async -> (receivedAny: Bool, reason: String) {
        var receivedAny = false
        while !Task.isCancelled {
            do {
                let message = try await task.receive()
                receivedAny = true
                switch message {
                case .string(let text):
                    guard let data = text.data(using: .utf8),
                          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                        await onMessage(text)
                        continue
                    }
                    if let requestId = paymentRequestId(from: object) {
                        await onIntentId(requestId)
                    } else {
                        await onMessage(text)
                    }
                case .data(let data):
                    await onMessage(String(data: data, encoding: .utf8) ?? "Binary relay message")
                @unknown default:
                    await onMessage("Unknown relay message")
                }
            } catch {
                // Surface the drop to the supervisor, which handles backoff +
                // reconnect. Returning here (instead of looping) was the H10 bug.
                return (receivedAny, error.localizedDescription)
            }
        }
        return (receivedAny, "cancelled")
    }

    private func get(config: Config, path: String) async throws -> [String: Any] {
        let url = try endpoint(config: config, path: path)
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
        var request = URLRequest(url: try endpoint(config: config, path: path))
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

    private func endpoint(config: Config, path: String) throws -> URL {
        guard let baseURL = config.baseURL, let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw AppError.invalidResponse("Set Relay URL first.")
        }
        return url
    }

    private func paymentRequestId(from object: [String: Any]) -> String? {
        let type = string(object, "type")
        let data = object["data"] as? [String: Any] ?? [:]
        let id = firstNonEmpty(
            string(object, "request_id"),
            string(object, "intent_id"),
            string(data, "request_id"),
            string(data, "intent_id")
        )
        guard !id.isEmpty else { return nil }
        if [
            "payment_intent",
            "payment_request",
            "payment_request.created",
            "payment_request.status",
            "payment_request_status"
        ].contains(type) {
            return id
        }
        return nil
    }

    func pairingLookup(from input: String) throws -> PairingLookup {
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
