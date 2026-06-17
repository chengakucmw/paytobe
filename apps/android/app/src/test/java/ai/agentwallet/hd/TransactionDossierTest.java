package ai.agentwallet.hd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class TransactionDossierTest {
    @Test
    public void completeDossierShowsEvidenceTraceAndPaymentMapping() throws Exception {
        JSONObject raw = baseRequest();
        raw.put("payee", new JSONObject()
                .put("name", "Oaxaca Kitchen")
                .put("domain", "oaxaca.example")
                .put("verified", true));
        raw.put("order", new JSONObject()
                .put("id", "ord_123")
                .put("item_summary", "Dinner order under 30 USDC")
                .put("items", new JSONArray().put(new JSONObject()
                        .put("name", "Mole Negro Plate")
                        .put("quantity", 1)
                        .put("line_total_usd", "16.00")
                        .put("image_url", "https://example.test/mole.png"))));
        raw.put("transaction_context_snapshot", new JSONObject()
                .put("user_intent", "Order dinner from Oaxaca Kitchen and keep total under 30 USDC.")
                .put("evidence", new JSONArray().put(new JSONObject()
                        .put("evidence_id", "ev_receipt")
                        .put("title", "Order receipt")
                        .put("type", "receipt")))
                .put("agent_trace", new JSONArray().put(new JSONObject()
                        .put("title", "Built cart")
                        .put("body", "Selected items and calculated service fee.")
                        .put("tone", "info"))));

        TransactionDossier dossier = TransactionDossier.from(PaymentIntent.parse(raw));

        assertEquals("Complete evidence", dossier.title);
        assertEquals(TransactionDossier.TONE_SAFE, dossier.tone);
        assertNotNull(findEvidence(dossier, "Oaxaca Kitchen"));
        assertNotNull(findEvidence(dossier, "Payment mapping"));
        assertNotNull(findRow(dossier.paymentMappingRows, "Amount"));
        assertNotNull(findRow(dossier.paymentMappingRows, "Token"));
        assertNotNull(findRow(dossier.paymentMappingRows, "Network"));
        assertNotNull(findRow(dossier.paymentMappingRows, "Recipient"));
        assertNotNull(findRow(dossier.paymentMappingRows, "Network fee"));
        assertNotNull(findRow(dossier.paymentMappingRows, "Total"));
        assertTrue(hasStep(dossier, "Built cart"));
    }

    @Test
    public void missingEvidenceDossierShowsEvidenceNotReceived() throws Exception {
        JSONObject raw = baseRequest();
        raw.put("risk", new JSONObject()
                .put("review_status", "missing_context")
                .put("warnings", new JSONArray().put(new JSONObject()
                        .put("code", "context_missing")
                        .put("message", "Required transaction context is missing."))));
        raw.put("context", new JSONObject().put("status", "missing"));
        raw.put("transaction_context_snapshot", new JSONObject()
                .put("missing_context", new JSONArray().put(new JSONObject()
                        .put("field", "Item evidence")
                        .put("message", "Product photo, checkout page, and receipt did not arrive."))));

        TransactionDossier dossier = TransactionDossier.from(PaymentIntent.parse(raw));

        assertEquals("Missing evidence", dossier.title);
        assertEquals("Evidence missing", dossier.status);
        assertEquals(TransactionDossier.TONE_CAUTION, dossier.tone);
        assertNotNull(findEvidence(dossier, "Evidence not received"));
        TransactionDossier.Row itemEvidence = findRow(dossier.permissionRiskRows, "Item evidence");
        assertNotNull(itemEvidence);
        assertEquals("Evidence not received", itemEvidence.value);
        assertTrue(hasStep(dossier, "Approval paused"));
    }

    @Test
    public void mismatchedRecipientDossierExplainsBlockedMapping() throws Exception {
        JSONObject raw = baseRequest();
        raw.put("payee", new JSONObject()
                .put("name", "Canal House Hotel")
                .put("domain", "canal.example")
                .put("verified", true));
        raw.put("risk", new JSONObject()
                .put("level", "danger")
                .put("review_status", "blocked")
                .put("errors", new JSONArray().put(new JSONObject()
                        .put("code", "context_payee_mismatch")
                        .put("field", "payee.name")
                        .put("message", "Recipient differs from verified merchant address."))));

        TransactionDossier dossier = TransactionDossier.from(PaymentIntent.parse(raw));

        assertEquals("Recipient conflict", dossier.title);
        assertEquals("Needs correction", dossier.status);
        assertEquals(TransactionDossier.TONE_DANGER, dossier.tone);
        assertEquals("Payee and recipient conflict", dossier.riskTitle);
        TransactionDossier.Row conflict = findRow(dossier.permissionRiskRows, "payee.name");
        assertNotNull(conflict);
        assertEquals("Conflicted", conflict.value);
        assertNotNull(findRow(dossier.paymentMappingRows, "Recipient"));
        assertTrue(hasStep(dossier, "Blocked approval"));
    }

    private static JSONObject baseRequest() throws Exception {
        return new JSONObject()
                .put("protocol", PaymentRequest.PROTOCOL_PAYMENT_REQUEST)
                .put("request_id", "req_dossier_test")
                .put("status", "pending")
                .put("created_at_ms", System.currentTimeMillis())
                .put("expires_at_ms", System.currentTimeMillis() + 300_000L)
                .put("source", new JSONObject()
                        .put("agent_name", "AgentFood")
                        .put("runtime", "local")
                        .put("channel", "agentfood.eth"))
                .put("payee", new JSONObject()
                        .put("name", "Oaxaca Kitchen")
                        .put("domain", "oaxaca.example"))
                .put("payment", new JSONObject()
                        .put("rail", "evm_erc20")
                        .put("network", "base_mainnet")
                        .put("chain_id", 8453)
                        .put("asset", "USDC")
                        .put("amount", "24.00")
                        .put("to", "0x6e182544a17bc2206ad7095b61f884e7f2d1d40b")
                        .put("token_contract", RiskPolicy.BASE_USDC)
                        .put("decimals", 6)
                        .put("estimated_fee", "0.01"));
    }

    private static TransactionDossier.EvidenceItem findEvidence(TransactionDossier dossier, String title) {
        for (TransactionDossier.EvidenceItem item : dossier.evidenceItems) {
            if (title.equals(item.title)) return item;
        }
        return null;
    }

    private static TransactionDossier.Row findRow(Iterable<TransactionDossier.Row> rows, String label) {
        for (TransactionDossier.Row row : rows) {
            if (label.equals(row.label)) return row;
        }
        return null;
    }

    private static boolean hasStep(TransactionDossier dossier, String title) {
        for (TransactionDossier.TraceStep step : dossier.agentSteps) {
            if (title.equals(step.title)) return true;
        }
        return false;
    }
}
