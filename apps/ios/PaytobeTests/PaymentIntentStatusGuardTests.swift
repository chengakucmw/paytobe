import XCTest
@testable import Paytobe

/// iOS parity with Android's PaymentRequestStatusGuardTest. The inbox merge
/// (PaymentInbox.upsertIntent, the H12 fix) must never let a stale relay snapshot
/// downgrade a locally-advanced status — e.g. a late "pending" arriving after a
/// local "broadcasted" would make a paid request look actionable again and risk a
/// duplicate payment. That guard is driven entirely by `PaymentStatus.lifecycleRank`,
/// so these tests pin the rank truth table and the exact keep-the-higher-rank rule
/// the store applies. (Previously only Android pinned this; iOS had the logic but
/// no test.)
final class PaymentIntentStatusGuardTests: XCTestCase {

    /// Mirrors the merge decision in PaymentInbox.upsertIntent: keep whichever
    /// status is further along the lifecycle; a lower-ranked incoming status never
    /// overwrites a higher-ranked local one.
    private func kept(existing: String, incoming: String) -> String {
        PaymentStatus.lifecycleRank(existing) > PaymentStatus.lifecycleRank(incoming) ? existing : incoming
    }

    func testLifecycleRankIsTheExpectedMonotonicTable() {
        XCTAssertEqual(PaymentStatus.lifecycleRank("pending"), 0)
        XCTAssertEqual(PaymentStatus.lifecycleRank("signed"), 1)
        XCTAssertEqual(PaymentStatus.lifecycleRank("broadcasted"), 2)
        XCTAssertEqual(PaymentStatus.lifecycleRank("confirmed"), 3)
        XCTAssertEqual(PaymentStatus.lifecycleRank("failed"), 4)
        XCTAssertEqual(PaymentStatus.lifecycleRank("rejected"), 5)
        XCTAssertEqual(PaymentStatus.lifecycleRank("expired"), 6)
    }

    func testActiveLifecycleStrictlyIncreasesPendingToConfirmed() {
        // The "happy path" advance must be strictly increasing so each forward step
        // is applied and no forward step is ever treated as a downgrade.
        XCTAssertLessThan(PaymentStatus.lifecycleRank("pending"), PaymentStatus.lifecycleRank("signed"))
        XCTAssertLessThan(PaymentStatus.lifecycleRank("signed"), PaymentStatus.lifecycleRank("broadcasted"))
        XCTAssertLessThan(PaymentStatus.lifecycleRank("broadcasted"), PaymentStatus.lifecycleRank("confirmed"))
    }

    func testUnknownStatusRanksAtTheSafeFloor() {
        // A bogus / future / wrong-case status must rank at the pending floor (0) so
        // it can never outrank — and therefore never overwrite — a real local status.
        // (Callers normalize to lowercase first; an unrecognized rawValue is the
        // fail-safe case here.)
        XCTAssertEqual(PaymentStatus.lifecycleRank("paid"), 0)
        XCTAssertEqual(PaymentStatus.lifecycleRank(""), 0)
        XCTAssertEqual(PaymentStatus.lifecycleRank("BROADCASTED"), 0)
        XCTAssertEqual(PaymentStatus.lifecycleRank("🤖"), 0)
    }

    func testStaleSnapshotDoesNotDowngradeLocalBroadcasted() {
        // The core H12 case: local broadcasted must survive a relay-lagging pending.
        XCTAssertEqual(kept(existing: "broadcasted", incoming: "pending"), "broadcasted")
        XCTAssertEqual(kept(existing: "broadcasted", incoming: "signed"), "broadcasted")
    }

    func testTerminalStatusesAreNotRevived() {
        for terminal in ["confirmed", "failed", "rejected", "expired"] {
            XCTAssertEqual(kept(existing: terminal, incoming: "pending"), terminal, "\(terminal) revived to pending")
            XCTAssertEqual(kept(existing: terminal, incoming: "broadcasted"), terminal, "\(terminal) revived to broadcasted")
        }
    }

    func testLegalForwardAdvanceIsApplied() {
        XCTAssertEqual(kept(existing: "pending", incoming: "broadcasted"), "broadcasted")
        XCTAssertEqual(kept(existing: "broadcasted", incoming: "confirmed"), "confirmed")
        // Idempotent same-status merge keeps the status (no spurious change).
        XCTAssertEqual(kept(existing: "broadcasted", incoming: "broadcasted"), "broadcasted")
    }

    func testGarbageIncomingStatusCannotDowngrade() {
        // An unparseable incoming status (rank 0) must not clobber a real local one.
        XCTAssertEqual(kept(existing: "broadcasted", incoming: "paid"), "broadcasted")
        XCTAssertEqual(kept(existing: "confirmed", incoming: ""), "confirmed")
    }
}
