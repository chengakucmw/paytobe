package ai.agentwallet.hd;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

final class TruthPanel {
    static final String TONE_SAFE = "safe";
    static final String TONE_INFO = "info";
    static final String TONE_CAUTION = "caution";
    static final String TONE_DANGER = "danger";

    private TruthPanel() {}

    static List<Section> sections(PaymentRequest request) {
        List<Section> sections = new ArrayList<>();
        if (request == null) return sections;

        JSONObject grouped = firstObject(
                request.raw.optJSONObject("truth_panel"),
                request.transactionContextSnapshot.optJSONObject("truth_panel"),
                request.context.optJSONObject("truth_panel")
        );
        Map<String, JSONObject> evidenceById = evidenceById(request.evidence);

        List<Row> verified = new ArrayList<>();
        List<Row> merchantClaims = new ArrayList<>();
        List<Row> merchantAi = new ArrayList<>();
        List<Row> userAi = new ArrayList<>();
        List<Row> missing = new ArrayList<>();

        if (grouped != null) {
            verified.addAll(rowsFromGrouped(
                    firstArray(grouped.optJSONArray("verified_facts"), grouped.optJSONArray("verified")),
                    evidenceById,
                    TONE_SAFE
            ));
            merchantClaims.addAll(rowsFromGrouped(
                    firstArray(grouped.optJSONArray("merchant_claims"), grouped.optJSONArray("merchantClaims")),
                    evidenceById,
                    TONE_INFO
            ));
            merchantAi.addAll(rowsFromGrouped(
                    firstArray(grouped.optJSONArray("merchant_ai_claims"), grouped.optJSONArray("merchantAi")),
                    evidenceById,
                    TONE_CAUTION
            ));
            userAi.addAll(rowsFromGrouped(
                    firstArray(grouped.optJSONArray("user_agent_inferences"), grouped.optJSONArray("userAi")),
                    evidenceById,
                    TONE_INFO
            ));
            missing.addAll(rowsFromGrouped(
                    firstArray(grouped.optJSONArray("missing_or_risky"), grouped.optJSONArray("missing")),
                    evidenceById,
                    TONE_CAUTION
            ));
            if (verified.isEmpty()) verified.addAll(paymentFactRows(request));
        } else {
            verified.addAll(paymentFactRows(request));
            for (int i = 0; i < request.truthFields.length(); i++) {
                JSONObject item = request.truthFields.optJSONObject(i);
                if (item == null) continue;
                Row row = rowFromTruthField(item, evidenceById);
                if (isMissingOrRisky(item, row)) {
                    missing.add(row.withTone(worstTone(row.tone, toneForStatus(item.optString("verification_status", "")))));
                } else if ("merchant_ai_claim".equals(item.optString("source_type", ""))) {
                    merchantAi.add(row.withTone(worstTone(row.tone, TONE_CAUTION)));
                } else if ("user_agent_inferred".equals(item.optString("source_type", ""))) {
                    userAi.add(row.withTone(worstTone(row.tone, TONE_CAUTION)));
                } else if (isMerchantClaim(item)) {
                    merchantClaims.add(row);
                } else {
                    verified.add(row.withTone(safeOnlyWhenVerified(row.tone, item.optString("verification_status", ""))));
                }
            }
        }

        missing.addAll(rowsFromMissingContext(request.missingContext));
        missing.addAll(rowsFromRiskArray(request.risk.optJSONArray("errors"), TONE_DANGER));
        missing.addAll(rowsFromRiskArray(request.risk.optJSONArray("warnings"), TONE_CAUTION));
        missing.addAll(rowsFromRiskArray(request.riskFindings, TONE_CAUTION));
        if (shouldShowContextNotReceived(request, grouped)) {
            missing.add(contextNotReceivedRow(request));
        }

        addSection(sections, "Verified facts", "payment and verified proof", TONE_SAFE, verified);
        addSection(sections, "Merchant claims", "website or API statements", TONE_INFO, merchantClaims);
        addSection(sections, "Merchant AI claims", "not signed terms", TONE_CAUTION, merchantAi);
        addSection(sections, "Your AI interpretation", "agent reasoning only", TONE_INFO, userAi);
        addSection(sections, "Missing or risky", "needs correction or acceptance", sectionToneForMissing(missing), missing);
        return sections;
    }

    private static List<Row> paymentFactRows(PaymentRequest request) {
        List<Row> rows = new ArrayList<>();
        String amount = joinDisplay(request.amount, request.asset);
        if (isUseful(amount)) {
            rows.add(new Row(
                    "Payment amount",
                    amount,
                    sourceLabel("payment_request_fact"),
                    statusLabel("payment_request_fact"),
                    "Parsed from Payment Request",
                    TONE_SAFE
            ));
        }
        String networkFee = request.network;
        if (isUseful(request.estimatedFee)) {
            networkFee = isUseful(networkFee) ? networkFee + " / " + request.estimatedFee : request.estimatedFee;
        }
        if (isUseful(networkFee)) {
            rows.add(new Row(
                    "Network and fee",
                    networkFee,
                    sourceLabel("wallet_derived"),
                    statusLabel("wallet_derived"),
                    "Wallet transaction preview",
                    TONE_SAFE
            ));
        }
        if (isUseful(request.recipient)) {
            rows.add(new Row(
                    "Recipient address",
                    shortAddress(request.recipient),
                    sourceLabel("payment_request_fact"),
                    statusLabel("payment_request_fact"),
                    "On-chain recipient is visible before signing",
                    request.payeeVerified ? TONE_SAFE : TONE_INFO
            ));
        }
        return rows;
    }

    private static List<Row> rowsFromGrouped(JSONArray array, Map<String, JSONObject> evidenceById, String fallbackTone) {
        List<Row> rows = new ArrayList<>();
        if (array == null) return rows;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) continue;
            rows.add(rowFromTruthField(item, evidenceById).withTone(firstNonEmpty(item.optString("tone", ""), fallbackTone)));
        }
        return rows;
    }

    private static Row rowFromTruthField(JSONObject item, Map<String, JSONObject> evidenceById) {
        String sourceType = firstNonEmpty(item.optString("source_type", ""), item.optString("source", ""));
        String verification = firstNonEmpty(item.optString("verification_status", ""), item.optString("status", ""));
        String evidenceRef = firstNonEmpty(item.optString("evidence_ref", ""), item.optString("evidence_id", ""));
        String evidenceText = firstNonEmpty(
                item.optString("evidence", ""),
                item.optString("evidence_summary", ""),
                item.optString("reason", ""),
                item.optString("message", ""),
                evidenceLabel(evidenceRef, evidenceById),
                defaultEvidenceCopy(sourceType, verification)
        );
        return new Row(
                firstNonEmpty(item.optString("field", ""), item.optString("path", ""), item.optString("label", ""), "Context field"),
                valueString(item),
                sourceLabel(sourceType),
                statusLabel(verification),
                evidenceText,
                rowTone(sourceType, verification, item.optString("tone", ""))
        );
    }

    private static List<Row> rowsFromMissingContext(JSONArray array) {
        List<Row> rows = new ArrayList<>();
        if (array == null) return rows;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) {
                String value = array.optString(i, "");
                if (isUseful(value)) {
                    rows.add(new Row("Missing context", "Unavailable", "Missing", "Missing", value, TONE_DANGER));
                }
                continue;
            }
            rows.add(new Row(
                    firstNonEmpty(item.optString("field", ""), item.optString("path", ""), item.optString("code", ""), "Missing context"),
                    firstNonEmpty(item.optString("value", ""), item.optString("status", ""), "Unavailable"),
                    sourceLabel(firstNonEmpty(item.optString("source_type", ""), "missing")),
                    statusLabel(firstNonEmpty(item.optString("verification_status", ""), "missing")),
                    firstNonEmpty(item.optString("message", ""), item.optString("reason", ""), item.optString("evidence", ""), "Required context or evidence did not arrive."),
                    TONE_DANGER
            ));
        }
        return rows;
    }

    private static List<Row> rowsFromRiskArray(JSONArray array, String fallbackTone) {
        List<Row> rows = new ArrayList<>();
        if (array == null) return rows;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) {
                String value = array.optString(i, "");
                if (isUseful(value)) rows.add(new Row("Risk finding", fallbackTone.equals(TONE_DANGER) ? "Blocked" : "Needs review", "Risk policy", statusForTone(fallbackTone), value, fallbackTone));
                continue;
            }
            String code = item.optString("code", "");
            String severity = firstNonEmpty(item.optString("severity", ""), fallbackTone.equals(TONE_DANGER) ? "blocker" : "warning");
            String tone = toneForSeverity(severity, fallbackTone);
            String evidence = riskEvidence(code, item);
            rows.add(new Row(
                    firstNonEmpty(item.optString("field", ""), item.optString("path", ""), labelForRiskCode(code), "Risk finding"),
                    firstNonEmpty(item.optString("value", ""), valueForRiskCode(code, severity)),
                    "Risk policy",
                    statusForRiskCode(code, severity, tone),
                    evidence,
                    tone
            ));
        }
        return rows;
    }

    private static boolean shouldShowContextNotReceived(PaymentRequest request, JSONObject grouped) {
        if (grouped != null) return false;
        if (request.contextHasSnapshot || request.truthFields.length() > 0 || request.missingContext.length() > 0) return false;
        if (hasCode(request.risk.optJSONArray("warnings"), "context_missing")
                || hasCode(request.risk.optJSONArray("errors"), "context_missing")
                || hasCode(request.riskFindings, "context_missing")) {
            return false;
        }
        return request.contextMissing || !isUseful(request.contextStatus) || "missing".equals(request.contextStatus);
    }

    private static Row contextNotReceivedRow(PaymentRequest request) {
        String tone = request.contextMissing ? TONE_DANGER : TONE_CAUTION;
        return new Row(
                "Transaction Context",
                "Not received",
                "Missing",
                "Missing",
                "Payment Facts remain visible, but transaction context evidence was not received.",
                tone
        );
    }

    private static boolean isMissingOrRisky(JSONObject item, Row row) {
        String sourceType = item.optString("source_type", "");
        String verification = item.optString("verification_status", "");
        return "missing".equals(verification)
                || "conflicted".equals(verification)
                || "unknown".equals(sourceType)
                || TONE_DANGER.equals(row.tone);
    }

    private static boolean isMerchantClaim(JSONObject item) {
        String sourceType = item.optString("source_type", "");
        return "merchant_web_observed".equals(sourceType)
                || "merchant_api_response".equals(sourceType)
                || "merchant_signed_quote".equals(sourceType);
    }

    private static String safeOnlyWhenVerified(String tone, String verification) {
        if (TONE_SAFE.equals(tone) && !isStrongVerification(verification)) return TONE_INFO;
        return tone;
    }

    private static boolean isStrongVerification(String value) {
        return "signature_verified".equals(value)
                || "domain_verified".equals(value)
                || "address_verified".equals(value)
                || "api_authenticated".equals(value)
                || "payment_request_fact".equals(value)
                || "wallet_derived".equals(value);
    }

    private static String rowTone(String sourceType, String verification, String explicitTone) {
        if (isUseful(explicitTone)) return explicitTone;
        if ("conflicted".equals(verification) || "missing".equals(verification)) return TONE_DANGER;
        if ("merchant_ai_claim".equals(sourceType) || "ai_claim_only".equals(verification)
                || "user_agent_inferred".equals(sourceType) || "inferred_only".equals(verification)
                || "observed_only".equals(verification) || "unverified".equals(verification)
                || "unknown".equals(sourceType)) {
            return TONE_CAUTION;
        }
        if (isStrongVerification(verification) || "payment_request_fact".equals(sourceType) || "wallet_derived".equals(sourceType)) return TONE_SAFE;
        return TONE_INFO;
    }

    private static String sectionToneForMissing(List<Row> rows) {
        for (Row row : rows) {
            if (TONE_DANGER.equals(row.tone)) return TONE_DANGER;
        }
        return TONE_CAUTION;
    }

    private static String toneForStatus(String verification) {
        if ("conflicted".equals(verification) || "missing".equals(verification)) return TONE_DANGER;
        if ("ai_claim_only".equals(verification) || "inferred_only".equals(verification)
                || "observed_only".equals(verification) || "unverified".equals(verification)) return TONE_CAUTION;
        return TONE_INFO;
    }

    private static String toneForSeverity(String severity, String fallbackTone) {
        String value = severity == null ? "" : severity.toLowerCase();
        if (value.contains("block") || value.contains("error") || value.contains("danger")) return TONE_DANGER;
        if (value.contains("warn") || value.contains("review") || value.contains("caution")) return TONE_CAUTION;
        return fallbackTone;
    }

    private static String worstTone(String a, String b) {
        if (TONE_DANGER.equals(a) || TONE_DANGER.equals(b)) return TONE_DANGER;
        if (TONE_CAUTION.equals(a) || TONE_CAUTION.equals(b)) return TONE_CAUTION;
        if (TONE_INFO.equals(a) || TONE_INFO.equals(b)) return TONE_INFO;
        return TONE_SAFE;
    }

    private static String sourceLabel(String value) {
        if ("payment_request_fact".equals(value)) return "Payment fact";
        if ("wallet_derived".equals(value)) return "Wallet derived";
        if ("user_provided".equals(value)) return "You provided";
        if ("user_agent_inferred".equals(value)) return "Your AI inferred";
        if ("merchant_web_observed".equals(value)) return "Website observed";
        if ("merchant_ai_claim".equals(value)) return "Merchant AI said";
        if ("merchant_api_response".equals(value)) return "Merchant API";
        if ("merchant_signed_quote".equals(value)) return "Signed quote";
        if ("platform_verified".equals(value)) return "Velarum verified";
        if ("external_verified".equals(value)) return "Third-party verified";
        if ("unknown".equals(value)) return "Unknown source";
        if ("missing".equals(value)) return "Missing";
        return titleize(value, "Unknown source");
    }

    private static String statusLabel(String value) {
        if ("signature_verified".equals(value)) return "Signature verified";
        if ("domain_verified".equals(value)) return "Domain verified";
        if ("address_verified".equals(value)) return "Address verified";
        if ("api_authenticated".equals(value)) return "API authenticated";
        if ("observed_only".equals(value)) return "Observed only";
        if ("ai_claim_only".equals(value)) return "AI claim only";
        if ("inferred_only".equals(value)) return "Inferred only";
        if ("conflicted".equals(value)) return "Conflicted";
        if ("missing".equals(value)) return "Missing";
        if ("unverified".equals(value)) return "Unverified";
        if ("payment_request_fact".equals(value)) return "Payment request fact";
        if ("wallet_derived".equals(value)) return "Wallet derived";
        return titleize(value, "Unverified");
    }

    private static String statusForTone(String tone) {
        return TONE_DANGER.equals(tone) ? "Blocked" : "Needs review";
    }

    private static String statusForRiskCode(String code, String severity, String tone) {
        if ("context_amount_mismatch".equals(code) || "context_payee_mismatch".equals(code)
                || "context_asset_mismatch".equals(code) || "context_network_mismatch".equals(code)
                || code.contains("mismatch")) {
            return "Conflicted";
        }
        if ("context_missing".equals(code) || code.contains("missing")) return "Missing";
        if ("ai_only_critical_field".equals(code) || "merchant_ai_claim_only".equals(code)) return "AI claim only";
        if (TONE_DANGER.equals(tone)) return "Blocked";
        if (severity != null && severity.toLowerCase().contains("review")) return "Review required";
        return "Needs review";
    }

    private static String labelForRiskCode(String code) {
        if ("context_amount_mismatch".equals(code)) return "Amount match";
        if ("context_payee_mismatch".equals(code)) return "Payee match";
        if ("context_asset_mismatch".equals(code)) return "Asset match";
        if ("context_network_mismatch".equals(code)) return "Network match";
        if ("context_missing".equals(code)) return "Transaction Context";
        if ("ai_only_critical_field".equals(code)) return "AI-only critical field";
        if ("merchant_ai_claim_only".equals(code)) return "Merchant AI claim";
        return titleize(code, "Risk finding");
    }

    private static String valueForRiskCode(String code, String severity) {
        if ("context_missing".equals(code)) return "Not received";
        if (code != null && code.contains("mismatch")) return "Conflicted";
        if (code != null && code.contains("ai")) return "AI-only";
        return severity != null && severity.length() > 0 ? titleize(severity, "Needs review") : "Needs review";
    }

    private static String copyForRiskCode(String code) {
        if ("context_amount_mismatch".equals(code)) return "Payment amount conflicts with transaction context.";
        if ("context_payee_mismatch".equals(code)) return "Payee or recipient evidence conflicts with the Payment Request.";
        if ("context_asset_mismatch".equals(code)) return "Asset evidence conflicts with the Payment Request.";
        if ("context_network_mismatch".equals(code)) return "Network evidence conflicts with the Payment Request.";
        if ("context_missing".equals(code)) return "Required transaction context or evidence was not received.";
        if ("ai_only_critical_field".equals(code)) return "A critical field only comes from AI or observed text, so it cannot be treated as verified.";
        if ("merchant_ai_claim_only".equals(code)) return "This merchant promise only comes from merchant AI and is not a signed term.";
        return "Review this source before signing.";
    }

    private static String riskEvidence(String code, JSONObject item) {
        String evidence = firstNonEmpty(item.optString("message", ""), item.optString("reason", ""), copyForRiskCode(code));
        if ("context_missing".equals(code) && !evidence.toLowerCase().contains("received")) {
            evidence = evidence + " Transaction context was not received.";
        }
        return evidence;
    }

    private static String defaultEvidenceCopy(String sourceType, String verification) {
        if ("merchant_ai_claim".equals(sourceType) || "ai_claim_only".equals(verification)) return "No signed terms or verified evidence attached.";
        if ("user_agent_inferred".equals(sourceType) || "inferred_only".equals(verification)) return "Agent reasoning only; it does not prove merchant identity or payment terms.";
        if ("observed_only".equals(verification)) return "Observed source only; not verified by signed quote.";
        if ("missing".equals(verification)) return "Required evidence did not arrive.";
        return "Evidence reference was not attached.";
    }

    private static Map<String, JSONObject> evidenceById(JSONArray evidence) {
        Map<String, JSONObject> out = new HashMap<>();
        if (evidence == null) return out;
        for (int i = 0; i < evidence.length(); i++) {
            JSONObject item = evidence.optJSONObject(i);
            if (item == null) continue;
            putEvidence(out, item.optString("evidence_id", ""), item);
            putEvidence(out, item.optString("id", ""), item);
            putEvidence(out, item.optString("ref", ""), item);
        }
        return out;
    }

    private static void putEvidence(Map<String, JSONObject> out, String key, JSONObject value) {
        if (isUseful(key)) out.put(key, value);
    }

    private static String evidenceLabel(String evidenceRef, Map<String, JSONObject> evidenceById) {
        if (!isUseful(evidenceRef)) return "";
        JSONObject evidence = evidenceById.get(evidenceRef);
        if (evidence == null) return evidenceRef;
        return firstNonEmpty(evidence.optString("title", ""), evidence.optString("type", ""), evidenceRef);
    }

    private static void addSection(List<Section> sections, String title, String note, String tone, List<Row> rows) {
        if (rows == null || rows.isEmpty()) return;
        sections.add(new Section(title, note, tone, rows));
    }

    private static String valueString(JSONObject item) {
        Object value = item.opt("value");
        if (value == null) value = item.opt("display_value");
        if (value == null) value = "";
        String text = String.valueOf(value);
        if (isUseful(item.optString("currency", "")) && !text.contains(item.optString("currency", ""))) {
            text = text + " " + item.optString("currency", "");
        }
        return isUseful(text) ? text : "Unavailable";
    }

    private static JSONObject firstObject(JSONObject... values) {
        if (values == null) return null;
        for (JSONObject value : values) {
            if (value != null && value.length() > 0) return value;
        }
        return null;
    }

    private static JSONArray firstArray(JSONArray a, JSONArray b) {
        if (a != null) return a;
        return b;
    }

    private static boolean hasCode(JSONArray items, String code) {
        if (items == null) return false;
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item != null && code.equals(item.optString("code", ""))) return true;
        }
        return false;
    }

    private static String firstNonEmpty(String... values) {
        if (values == null) return "";
        for (String value : values) {
            if (isUseful(value)) return value.trim();
        }
        return "";
    }

    private static String titleize(String value, String fallback) {
        if (!isUseful(value)) return fallback;
        String clean = value.replace('_', ' ').replace('-', ' ').trim();
        if (clean.length() == 0) return fallback;
        return clean.substring(0, 1).toUpperCase() + clean.substring(1);
    }

    private static boolean isUseful(String value) {
        if (value == null) return false;
        String clean = value.trim();
        return clean.length() > 0 && !"null".equalsIgnoreCase(clean);
    }

    private static String joinDisplay(String first, String second) {
        if (!isUseful(first)) return isUseful(second) ? second : "";
        if (!isUseful(second)) return first;
        return first + " " + second;
    }

    private static String shortAddress(String value) {
        // Delegates to the shared AddressFormat (D9/Q5) — unified 10…8 form.
        return AddressFormat.medium(value);
    }

    static final class Section {
        final String title;
        final String note;
        final String tone;
        final List<Row> rows;

        Section(String title, String note, String tone, List<Row> rows) {
            this.title = title;
            this.note = note;
            this.tone = tone;
            this.rows = rows;
        }
    }

    static final class Row {
        final String field;
        final String value;
        final String source;
        final String status;
        final String evidence;
        final String tone;

        Row(String field, String value, String source, String status, String evidence, String tone) {
            this.field = field == null ? "" : field;
            this.value = value == null ? "" : value;
            this.source = source == null ? "" : source;
            this.status = status == null ? "" : status;
            this.evidence = evidence == null ? "" : evidence;
            this.tone = tone == null ? TONE_INFO : tone;
        }

        Row withTone(String tone) {
            return new Row(field, value, source, status, evidence, tone);
        }
    }
}
