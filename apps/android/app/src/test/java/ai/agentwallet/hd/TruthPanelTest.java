package ai.agentwallet.hd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.List;

public final class TruthPanelTest {
    @Test
    public void paymentFactsRenderBeforeSourceGroups() throws Exception {
        PaymentRequest request = PaymentRequest.parse(baseRequest());

        List<TruthPanel.Section> sections = TruthPanel.sections(request);

        assertFalse(sections.isEmpty());
        assertEquals("Verified facts", sections.get(0).title);
        assertTrue(hasRow(sections.get(0), "Payment amount"));
        assertNotNull(findSection(sections, "Missing or risky"));
    }

    @Test
    public void groupedTruthPanelKeepsPrototypeSectionOrder() throws Exception {
        JSONObject raw = baseRequest();
        raw.put("context", new JSONObject().put("status", "ready").put("has_snapshot", true));
        raw.put("truth_panel", new JSONObject()
                .put("verified_facts", new JSONArray().put(row("Payment amount", "99.00 USDC", "Payment fact", "Payment request fact", "Parsed from Payment Request", "safe")))
                .put("merchant_claims", new JSONArray().put(row("Course access", "Lifetime access", "Website observed", "Observed only", "Landing page snapshot", "caution")))
                .put("merchant_ai_claims", new JSONArray().put(row("Refund policy", "7-day refund", "Merchant AI said", "AI claim only", "No signed terms", "caution")))
                .put("user_agent_inferences", new JSONArray().put(row("Recommendation", "Best fit", "Your AI inferred", "Inferred only", "Agent comparison", "caution")))
                .put("missing_or_risky", new JSONArray().put(row("Signed quote", "Not received", "Missing", "Missing", "Ask agent to fetch quote", "danger"))));

        List<TruthPanel.Section> sections = TruthPanel.sections(PaymentRequest.parse(raw));

        assertEquals("Verified facts", sections.get(0).title);
        assertEquals("Merchant claims", sections.get(1).title);
        assertEquals("Merchant AI claims", sections.get(2).title);
        assertEquals("Your AI interpretation", sections.get(3).title);
        assertEquals("Missing or risky", sections.get(4).title);
    }

    @Test
    public void aiOnlyRefundClaimIsNeverSafe() throws Exception {
        JSONObject raw = baseRequest();
        raw.put("context", new JSONObject().put("status", "ready").put("has_snapshot", true));
        raw.put("transaction_context_snapshot", new JSONObject()
                .put("truth_fields", new JSONArray().put(new JSONObject()
                        .put("field", "refund_policy")
                        .put("value", "7-day refund")
                        .put("source_type", "merchant_ai_claim")
                        .put("verification_status", "ai_claim_only")
                        .put("evidence_ref", "ev_ai_chat")))
                .put("evidence", new JSONArray().put(new JSONObject()
                        .put("evidence_id", "ev_ai_chat")
                        .put("title", "Merchant AI chat"))));

        List<TruthPanel.Section> sections = TruthPanel.sections(PaymentRequest.parse(raw));
        TruthPanel.Section merchantAi = findSection(sections, "Merchant AI claims");

        assertNotNull(merchantAi);
        assertEquals("refund_policy", merchantAi.rows.get(0).field);
        assertEquals("Merchant AI said", merchantAi.rows.get(0).source);
        assertEquals("AI claim only", merchantAi.rows.get(0).status);
        assertEquals(TruthPanel.TONE_CAUTION, merchantAi.rows.get(0).tone);
        assertFalse(hasRow(findSection(sections, "Verified facts"), "refund_policy"));
    }

    @Test
    public void missingContextShowsNotReceivedRow() throws Exception {
        JSONObject raw = baseRequest();
        raw.put("risk", new JSONObject()
                .put("review_status", "missing_context")
                .put("warnings", new JSONArray().put(new JSONObject()
                        .put("code", "context_missing")
                        .put("message", "Required transaction context is missing."))));

        TruthPanel.Section missing = findSection(TruthPanel.sections(PaymentRequest.parse(raw)), "Missing or risky");

        assertNotNull(missing);
        assertTrue(hasRow(missing, "Transaction Context"));
        assertTrue(hasEvidenceContaining(missing, "not received"));
    }

    @Test
    public void contextMismatchRiskIsDanger() throws Exception {
        JSONObject raw = baseRequest();
        raw.put("context", new JSONObject().put("status", "ready").put("has_snapshot", true));
        raw.put("risk", new JSONObject()
                .put("level", "danger")
                .put("review_status", "blocked")
                .put("errors", new JSONArray().put(new JSONObject()
                        .put("code", "context_payee_mismatch")
                        .put("field", "payee.name")
                        .put("message", "Payee profile does not match recipient address."))));

        TruthPanel.Section missing = findSection(TruthPanel.sections(PaymentRequest.parse(raw)), "Missing or risky");

        assertNotNull(missing);
        assertEquals(TruthPanel.TONE_DANGER, missing.tone);
        assertEquals(TruthPanel.TONE_DANGER, missing.rows.get(0).tone);
        assertEquals("Conflicted", missing.rows.get(0).status);
    }

    private static JSONObject baseRequest() throws Exception {
        return new JSONObject()
                .put("protocol", PaymentRequest.PROTOCOL_PAYMENT_REQUEST)
                .put("request_id", "req_truth_test")
                .put("status", "pending")
                .put("source", new JSONObject()
                        .put("agent_name", "LearnScout")
                        .put("runtime", "local"))
                .put("payee", new JSONObject()
                        .put("name", "NovaCourse Lab")
                        .put("domain", "novacourse.example"))
                .put("payment", new JSONObject()
                        .put("rail", "evm_erc20")
                        .put("network", "base_mainnet")
                        .put("chain_id", 8453)
                        .put("asset", "USDC")
                        .put("amount", "99.00")
                        .put("to", "0x6e182544a17bc2206ad7095b61f884e7f2d1d40b")
                        .put("token_contract", RiskPolicy.BASE_USDC)
                        .put("decimals", 6)
                        .put("estimated_fee", "0.01"));
    }

    private static JSONObject row(String field, String value, String source, String status, String evidence, String tone) throws Exception {
        return new JSONObject()
                .put("field", field)
                .put("value", value)
                .put("source", source)
                .put("status", status)
                .put("evidence", evidence)
                .put("tone", tone);
    }

    private static TruthPanel.Section findSection(List<TruthPanel.Section> sections, String title) {
        for (TruthPanel.Section section : sections) {
            if (title.equals(section.title)) return section;
        }
        return null;
    }

    private static boolean hasRow(TruthPanel.Section section, String field) {
        if (section == null) return false;
        for (TruthPanel.Row row : section.rows) {
            if (field.equals(row.field)) return true;
        }
        return false;
    }

    private static boolean hasEvidenceContaining(TruthPanel.Section section, String needle) {
        if (section == null) return false;
        String lowerNeedle = needle.toLowerCase();
        for (TruthPanel.Row row : section.rows) {
            if (row.evidence.toLowerCase().contains(lowerNeedle)) return true;
        }
        return false;
    }
}
