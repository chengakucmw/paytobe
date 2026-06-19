import XCTest
@testable import VelarumPay

final class PaymentRequestParsingTests: XCTestCase {
    // MARK: - C-1: Stellar memo type encoding (MEMO_ID vs MEMO_TEXT)
    //
    // Numeric exchange deposit memos MUST go out as MEMO_ID (uint64). The old code
    // encoded every non-empty memo as MEMO_TEXT, so a numeric tag silently failed
    // to credit the user at the exchange. These tests pin the union discriminant.

    func testNumericMemoEncodesAsMemoId() throws {
        var encoded = Data()
        try encoded.writeMemo("100200300", type: "id")
        // MEMO_ID = union discriminant 2, then an 8-byte big-endian uint64.
        XCTAssertEqual(Array(encoded.prefix(4)), [0, 0, 0, 2])
        XCTAssertEqual(encoded.count, 12)
        let value = encoded.suffix(8).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        XCTAssertEqual(value, 100_200_300)
    }

    func testTextMemoStillEncodesAsMemoText() throws {
        var encoded = Data()
        try encoded.writeMemo("ios-qa-1", type: "text")
        XCTAssertEqual(Array(encoded.prefix(4)), [0, 0, 0, 1]) // MEMO_TEXT
    }

    func testUntypedMemoStaysBackwardCompatibleAsText() throws {
        var encoded = Data()
        try encoded.writeMemo("hello")
        XCTAssertEqual(Array(encoded.prefix(4)), [0, 0, 0, 1]) // MEMO_TEXT (unchanged)
    }

    func testEmptyMemoEncodesAsMemoNoneRegardlessOfType() throws {
        var encoded = Data()
        try encoded.writeMemo("", type: "id")
        XCTAssertEqual(Array(encoded), [0, 0, 0, 0]) // MEMO_NONE
    }

    func testNonNumericIdMemoFailsClosed() {
        var encoded = Data()
        // Must throw rather than silently fall back to MEMO_TEXT (which would lose funds).
        XCTAssertThrowsError(try encoded.writeMemo("not-a-number", type: "id"))
    }

    func testNumericMemoParsesWithIdTypeAndLabel() throws {
        var payload = Self.stellarPaymentRequest()
        var payment = payload["payment"] as! [String: Any]
        payment["memo"] = "100200300"
        payment["memo_type"] = "id"
        payload["payment"] = payment
        let intent = try PaymentIntent.parse(payload)
        XCTAssertEqual(intent.memo, "100200300")
        XCTAssertEqual(intent.memoType, "id")
        XCTAssertEqual(intent.memoFieldTitle, "Memo (ID)")
    }

    func testStellarXLMFixtureParsesAsSignablePendingRequest() throws {
        let intent = try PaymentIntent.parse(Self.stellarPaymentRequest())

        XCTAssertEqual(intent.protocolName, paymentRequestProtocol)
        XCTAssertEqual(intent.id, "prq_ios_stellar_1")
        XCTAssertEqual(intent.transactionId, "txn_ios_stellar_1")
        XCTAssertTrue(intent.isStellarXLM)
        XCTAssertTrue(intent.isStandardPaymentRequest)
        XCTAssertTrue(intent.canSign)
        XCTAssertEqual(paymentReviewState(intent), "pending")
        XCTAssertTrue(isPaymentDetailSignable(intent))
        XCTAssertFalse(paymentRequiresWarningStepUp(intent))
        XCTAssertEqual(paymentRiskLabel(intent), "Low risk")
        XCTAssertEqual(paymentContextLabel(intent, state: paymentReviewState(intent)), "Ready")
        XCTAssertEqual(truthPanelSections(for: intent).count, 1)
    }

    func testMissingContextBlocksSigningAndRequestsContextRepair() throws {
        var payload = Self.stellarPaymentRequest()
        payload["request_id"] = "prq_ios_missing_context"
        payload["risk"] = [
            "level": "caution",
            "review_status": "missing_context",
            "signing_allowed": false,
            "warnings": [
                [
                    "code": "critical_field_missing_evidence",
                    "severity": "warning",
                    "field": "items",
                    "message": "Source checkout evidence is missing."
                ]
            ]
        ]
        payload["context"] = [
            "status": "missing",
            "transaction_id": "txn_ios_stellar_1",
            "has_snapshot": false,
            "warnings": [
                [
                    "code": "context_missing",
                    "message": "Transaction context was not received."
                ]
            ]
        ]
        payload["transaction_context_snapshot"] = [
            "transaction_id": "txn_ios_stellar_1",
            "snapshot_hash": "sha256:missing",
            "truth_fields": [],
            "evidence": [],
            "missing_context": [
                [
                    "field": "evidence.checkout_page",
                    "reason": "Checkout page evidence was not received.",
                    "severity": "review_required"
                ]
            ],
            "risk_findings": []
        ]

        let intent = try PaymentIntent.parse(payload)

        XCTAssertEqual(paymentReviewState(intent), "missing_context")
        XCTAssertFalse(intent.canSign)
        XCTAssertFalse(isPaymentDetailSignable(intent))
        XCTAssertEqual(paymentBlockedReason(intent), "Transaction context is missing or incomplete.")
        XCTAssertEqual(paymentContextLabel(intent, state: paymentReviewState(intent)), "Missing")
        XCTAssertTrue(paymentRiskMessages(intent).contains { $0.contains("Source checkout evidence is missing") })
    }

    func testBlockerRiskPreventsSignAction() throws {
        var payload = Self.stellarPaymentRequest()
        payload["request_id"] = "prq_ios_blocked"
        payload["risk"] = [
            "level": "danger",
            "review_status": "blocked",
            "signing_allowed": false,
            "errors": [
                [
                    "code": "recipient_mismatch",
                    "severity": "blocker",
                    "field": "payment.to",
                    "message": "Recipient does not match verified payee."
                ]
            ]
        ]
        payload["status_projection"] = [
            "lifecycle_status": "pending",
            "review_state": "blocked",
            "label": "Risk blocked",
            "tone": "danger",
            "group": "risk",
            "inbox_group": "risk",
            "is_final": false,
            "requires_attention": true,
            "signing_allowed": false
        ]

        let intent = try PaymentIntent.parse(payload)

        XCTAssertEqual(paymentReviewState(intent), "blocked")
        XCTAssertFalse(isPaymentDetailSignable(intent))
        XCTAssertEqual(paymentRiskLabel(intent), "Risk blocked")
        XCTAssertEqual(paymentRiskTone(intent), "danger")
        XCTAssertEqual(paymentBlockedReason(intent), "Recipient does not match verified payee.")
    }

    func testPairingLookupAcceptsShortCodeAndPairingURI() throws {
        let client = RelayClient()

        let shortCode = try client.pairingLookup(from: " 482913 ")
        XCTAssertEqual(shortCode.idOrCode, "482913")
        XCTAssertEqual(shortCode.code, "482913")
        XCTAssertEqual(shortCode.inputSource, "Short code")

        let uri = try client.pairingLookup(from: "velarumpay://pair?session=pair_ios_1&code=482913")
        XCTAssertEqual(uri.idOrCode, "pair_ios_1")
        XCTAssertEqual(uri.code, "482913")
        XCTAssertEqual(uri.inputSource, "QR URI")

        XCTAssertThrowsError(try client.pairingLookup(from: "https://example.com/pair?code=482913"))
    }

    func testPairingSessionFiltersSigningScopes() throws {
        let session = try PairingSession.parse([
            "pairing_session_id": "pair_ios_1",
            "pairing_code": "482913",
            "pairing_uri": "velarumpay://pair?session=pair_ios_1&code=482913",
            "status": "pending",
            "agent_identity": [
                "agent_id": "agt_ios_test",
                "agent_name": "iOS QA Agent",
                "runtime": "mcp",
                "device_label": "local test"
            ],
            "expires_at": "2027-12-31T23:59:00.000Z",
            "requested_scopes": [
                "payment.requests.create",
                "payment.requests.read",
                "wallet.sign",
                "seed.export",
                "transaction_contexts.create"
            ]
        ], inputSource: "QR URI")

        XCTAssertTrue(session.isPending)
        XCTAssertEqual(session.displayName, "iOS QA Agent")
        XCTAssertEqual(session.requestedScopes, [
            "payment.requests.create",
            "payment.requests.read",
            "transaction_contexts.create"
        ])
    }

    func testWalletNetworkValidatorParsesChainIdsAndRejectsUnsafeRPC() throws {
        XCTAssertEqual(try WalletNetworkValidator.parseFlexibleChainId("8453"), 8453)
        XCTAssertEqual(try WalletNetworkValidator.parseFlexibleChainId("0x14A34"), 84532)
        XCTAssertEqual(try WalletNetworkValidator.parseRPCChainId("0x2105"), 8453)

        XCTAssertThrowsError(try WalletNetworkValidator.buildVerifiedEVMConfig(
            name: "Unsafe",
            rpcURL: "http://example.com",
            chainId: "1",
            currencySymbol: "ETH",
            blockExplorerURL: "",
            source: WalletNetworkConfig.sourceUser,
            allowLocalURLs: false
        ))
    }

    func testWalletSecurityPolicyKeepsMnemonicEntryInSettingsSecurity() {
        XCTAssertFalse(WalletSecurityNavigationPolicy.allowsMnemonicEntry(surface: WalletSecurityNavigationPolicy.surfaceHome))
        XCTAssertFalse(WalletSecurityNavigationPolicy.allowsMnemonicEntry(surface: WalletSecurityNavigationPolicy.surfaceProfile))
        XCTAssertTrue(WalletSecurityNavigationPolicy.allowsMnemonicEntry(surface: WalletSecurityNavigationPolicy.surfaceSettingsSecurity))
        XCTAssertTrue(WalletSecurityNavigationPolicy.allowsMnemonicEntry(surface: "settings/security/recovery_phrase_backup"))
    }

    func testWalletSecurityPolicyRequiresVerifiedBackupBeforeSigning() {
        XCTAssertFalse(WalletSecurityNavigationPolicy.canCreateSignature(walletLoaded: false, backupVerified: true, paymentReady: true))
        XCTAssertFalse(WalletSecurityNavigationPolicy.canCreateSignature(walletLoaded: true, backupVerified: false, paymentReady: true))
        XCTAssertFalse(WalletSecurityNavigationPolicy.canCreateSignature(walletLoaded: true, backupVerified: true, paymentReady: false))
        XCTAssertTrue(WalletSecurityNavigationPolicy.canCreateSignature(walletLoaded: true, backupVerified: true, paymentReady: true))

        XCTAssertTrue(WalletSecurityNavigationPolicy.requiresBackupGate(walletLoaded: true, backupVerified: false, paymentReady: true))
        XCTAssertFalse(WalletSecurityNavigationPolicy.requiresBackupGate(walletLoaded: true, backupVerified: true, paymentReady: true))
    }

    private static func stellarPaymentRequest() -> [String: Any] {
        [
            "protocol": paymentRequestProtocol,
            "request_id": "prq_ios_stellar_1",
            "connection_id": "conn_ios_demo",
            "transaction_id": "txn_ios_stellar_1",
            "created_at": "2026-06-17T10:00:00.000Z",
            "expires_at": "2027-12-31T23:59:00.000Z",
            "idempotency_key": "ios-stellar-demo-payment-1",
            "status": "pending",
            "source": [
                "agent_id": "agt_ios_demo",
                "agent_name": "iOS QA Agent",
                "runtime": "mcp",
                "channel": "local"
            ],
            "payee": [
                "name": "Harbor Books",
                "domain": "harbor.example",
                "verified": true
            ],
            "payment": [
                "rail": "stellar_xlm",
                "network": "stellar_testnet",
                "asset": "XLM",
                "amount": "12.5000000",
                "to": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "memo": "ios-qa-1",
                "horizon_url": "https://horizon-testnet.stellar.org"
            ],
            "display": [
                "title": "Harbor Books payment",
                "summary": "XLM testnet request for iOS QA.",
                "primary_action": "Pay"
            ],
            "policy": [
                "requires_user_approval": true
            ],
            "risk": [
                "level": "safe",
                "review_status": "ready",
                "signing_allowed": true,
                "errors": [],
                "warnings": []
            ],
            "status_projection": [
                "lifecycle_status": "pending",
                "review_state": "pending",
                "label": "Awaiting signature",
                "tone": "safe",
                "group": "active",
                "inbox_group": "pending",
                "is_final": false,
                "requires_attention": true,
                "signing_allowed": true
            ],
            "transaction_context_snapshot": [
                "transaction_id": "txn_ios_stellar_1",
                "snapshot_hash": "sha256:ios-stellar-demo",
                "truth_fields": [
                    [
                        "field": "payment.amount",
                        "value": "12.5000000",
                        "currency": "XLM",
                        "source_type": "payment_request_fact",
                        "verification_status": "signature_verified",
                        "evidence_ref": "ev_ios_quote",
                        "confidence": "high",
                        "observed_at": "2026-06-17T10:00:00.000Z"
                    ]
                ],
                "evidence": [
                    [
                        "evidence_id": "ev_ios_quote",
                        "type": "signed_quote",
                        "title": "Signed checkout quote",
                        "captured_at": "2026-06-17T10:00:00.000Z",
                        "hash": "sha256:quote",
                        "signature": [
                            "verified": true
                        ]
                    ]
                ],
                "missing_context": [],
                "risk_findings": []
            ],
            "history": [],
            "metadata": [
                "type": "ios_qa"
            ]
        ]
    }
}
