import XCTest
@testable import Paytobe

final class ConnectInvitationTests: XCTestCase {
    func testCreateResponsePreservesOneTimeKeyAndFiltersSigningScopes() throws {
        let key = "Paytobe-connect:ck_" + String(repeating: "A", count: 43)
        let response: [String: Any] = [
            "connect_key": key,
            "connect_invitation": [
                "connect_invitation_id": "cinv_test",
                "status": "claimed",
                "pairing_session_id": "pair_test",
                "identity_assurance": "unverified",
                "expires_at": "2026-07-22T10:00:00.000Z",
                "agent_identity": [
                    "agent_id": "agentfood",
                    "agent_name": "AgentFood",
                    "runtime": "cloudflare-worker",
                    "source": "demo_website"
                ],
                "requested_scopes": ["payment.requests.create", "wallet.sign", "seed.read"]
            ]
        ]

        let invitation = try ConnectInvitation.parse(response)

        XCTAssertEqual(invitation.connectKey, key)
        XCTAssertEqual(invitation.agentName, "AgentFood")
        XCTAssertEqual(invitation.requestedScopes, ["payment.requests.create"])
        XCTAssertTrue(invitation.hasClaimedAgent)
        XCTAssertFalse(invitation.isTerminal)
    }
}
