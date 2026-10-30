import XCTest
@testable import Paytobe

/// Client-side risk backstop. iOS must not sign solely on the relay-supplied verdict; it
/// independently re-enforces the daily spend cap and the unverified-recipient cap in exact
/// Decimal (never Double), mirroring Android's RiskPolicy. These tests pin that truth table
/// and the exact-decimal boundaries.
final class LocalRiskPolicyTests: XCTestCase {

    func testUnderBothCapsIsAllowedButWarnsOnUnverifiedRecipient() {
        let result = LocalRiskPolicy.evaluateXLM(amount: "50", spentTodayXLM: 0, recipientWhitelisted: false)
        XCTAssertTrue(result.allowed)
        XCTAssertTrue(result.warnings.contains { $0.contains("not been verified") })
    }

    func testAmountAboveUnverifiedCapIsBlocked() {
        let result = LocalRiskPolicy.evaluateXLM(amount: "150", spentTodayXLM: 0, recipientWhitelisted: false)
        XCTAssertFalse(result.allowed)
        XCTAssertTrue(result.errors.contains { $0.contains("unverified recipient is blocked") })
    }

    func testWhitelistedRecipientBypassesUnverifiedCap() {
        let result = LocalRiskPolicy.evaluateXLM(amount: "150", spentTodayXLM: 0, recipientWhitelisted: true)
        XCTAssertTrue(result.allowed)
    }

    func testDailyLimitExceededIsBlocked() {
        // 950 already spent + 60 = 1010 > 1000 daily cap.
        let result = LocalRiskPolicy.evaluateXLM(amount: "60", spentTodayXLM: 950, recipientWhitelisted: true)
        XCTAssertFalse(result.allowed)
        XCTAssertTrue(result.errors.contains { $0.contains("Daily XLM limit exceeded") })
    }

    func testExactlyAtCapsIsAllowed() {
        // The caps are strict "greater than", so hitting the cap exactly is allowed.
        let unverified = LocalRiskPolicy.evaluateXLM(amount: "100", spentTodayXLM: 0, recipientWhitelisted: false)
        XCTAssertTrue(unverified.allowed)
        let daily = LocalRiskPolicy.evaluateXLM(amount: "1000", spentTodayXLM: 0, recipientWhitelisted: true)
        XCTAssertTrue(daily.allowed)
    }

    func testExactDecimalBoundaryIsNotRoundedAway() {
        // 1000.0000001 must exceed 1000 exactly — a Double would round this away.
        let result = LocalRiskPolicy.evaluateXLM(amount: "1000.0000001", spentTodayXLM: 0, recipientWhitelisted: true)
        XCTAssertFalse(result.allowed)
        XCTAssertTrue(result.errors.contains { $0.contains("Daily XLM limit exceeded") })
    }

    func testInvalidOrNonPositiveAmountsFailClosed() {
        for bad in ["", "   ", "abc", "0", "-5", ".5", "5.", "1e3", "12abc"] {
            let result = LocalRiskPolicy.evaluateXLM(amount: bad, spentTodayXLM: 0, recipientWhitelisted: true)
            XCTAssertFalse(result.allowed, "amount \"\(bad)\" must be blocked")
            XCTAssertTrue(result.errors.contains { $0.contains("amount is invalid") }, "amount \"\(bad)\"")
        }
    }

    func testParseAmountAcceptsCleanDecimalsOnly() {
        XCTAssertEqual(LocalRiskPolicy.parseAmount("0"), Decimal(0))
        // 12.5 == 125/10 exactly, expressed locale-independently.
        XCTAssertEqual(LocalRiskPolicy.parseAmount("12.5"), Decimal(125) / Decimal(10))
        XCTAssertEqual(LocalRiskPolicy.parseAmount("12.5").map(LocalRiskPolicy.plainString), "12.5")
        XCTAssertNil(LocalRiskPolicy.parseAmount(".5"))
        XCTAssertNil(LocalRiskPolicy.parseAmount("5."))
        XCTAssertNil(LocalRiskPolicy.parseAmount("1,000"))
        XCTAssertNil(LocalRiskPolicy.parseAmount("12abc"))
    }
}
