import XCTest
@testable import Paytobe

/// iOS parity with Android's PaymentRequestExpiryTest. A payment request whose
/// server payload carries no `expires_at` (or a drifted / unparseable one) must NOT
/// be force-expired by a local default — it stays valid until the server says
/// otherwise (the L-5 "no expiry" sentinel, expiresAtMs <= 0). An explicit server
/// expiry, ISO-8601 or epoch-millis, is honoured. This mirrors the Android test so
/// both wallets pin the same lifecycle rule.
final class PaymentRequestExpiryTests: XCTestCase {

    func testMissingExpiryNeverExpires() throws {
        var payload = Self.base()
        payload["expires_at"] = nil          // no server expiry at all
        payload["expires_at_ms"] = nil

        let intent = try PaymentIntent.parse(payload)
        XCTAssertEqual(intent.expiresAtMs, 0, "no expiry must map to the 0 sentinel")
        XCTAssertFalse(intent.hasExpiry, "a request with no expiry has no expiry window")
        XCTAssertFalse(intent.isExpired, "a request with no expiry must not be marked expired")
    }

    func testUnparseableExpiryNeverExpires() throws {
        var payload = Self.base()
        payload["expires_at"] = "soon-ish"   // present but not a valid timestamp
        payload["expires_at_ms"] = nil

        let intent = try PaymentIntent.parse(payload)
        XCTAssertFalse(intent.hasExpiry, "an unparseable expiry must fall back to the no-expiry sentinel")
        XCTAssertFalse(intent.isExpired)
    }

    func testExplicitFutureIsoExpiryIsHonouredAndNotExpired() throws {
        var payload = Self.base()
        payload["expires_at"] = "2099-01-01T00:00:00.000Z"

        let intent = try PaymentIntent.parse(payload)
        XCTAssertTrue(intent.hasExpiry)
        XCTAssertFalse(intent.isExpired)
    }

    func testExplicitPastIsoExpiryIsExpired() throws {
        var payload = Self.base()
        payload["expires_at"] = "2000-01-01T00:00:00.000Z"

        let intent = try PaymentIntent.parse(payload)
        XCTAssertTrue(intent.hasExpiry)
        XCTAssertTrue(intent.isExpired)
    }

    func testEpochMillisExpiryIsHonoured() throws {
        var past = Self.base()
        past["expires_at"] = nil
        past["expires_at_ms"] = 1_000            // ~1970, firmly in the past
        let pastIntent = try PaymentIntent.parse(past)
        XCTAssertTrue(pastIntent.hasExpiry)
        XCTAssertTrue(pastIntent.isExpired)

        var future = Self.base()
        future["expires_at"] = nil
        future["expires_at_ms"] = 4_102_444_800_000   // year 2100
        let futureIntent = try PaymentIntent.parse(future)
        XCTAssertTrue(futureIntent.hasExpiry)
        XCTAssertFalse(futureIntent.isExpired)
    }

    // A complete, known-good payment-request payload (same shape the parsing tests
    // already accept). Only the expiry fields are varied per test, so a failure
    // points at expiry handling rather than at unrelated parsing.
    private static func base() -> [String: Any] {
        [
            "protocol": paymentRequestProtocol,
            "request_id": "prq_ios_expiry_1",
            "connection_id": "conn_ios_demo",
            "transaction_id": "txn_ios_expiry_1",
            "created_at": "2026-06-17T10:00:00.000Z",
            "expires_at": "2027-12-31T23:59:00.000Z",
            "idempotency_key": "ios-expiry-demo-payment-1",
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
            "history": []
        ]
    }
}
