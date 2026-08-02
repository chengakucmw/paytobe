package ai.agentwallet.hd;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

final class TransactionDossier {
    static final String TONE_SAFE = TruthPanel.TONE_SAFE;
    static final String TONE_INFO = TruthPanel.TONE_INFO;
    static final String TONE_CAUTION = TruthPanel.TONE_CAUTION;
    static final String TONE_DANGER = TruthPanel.TONE_DANGER;

    final String title;
    final String status;
    final String tone;
    final String agentName;
    final String source;
    final String riskTitle;
    final String riskBody;
    final List<EvidenceItem> evidenceItems;
    final List<Row> decisionRows;
    final List<Row> itemRows;
    final List<TraceStep> agentSteps;
    final List<Row> permissionRiskRows;
    final List<Row> paymentMappingRows;
    final List<TruthPanel.Section> truthSections;

    private TransactionDossier(
            String title,
            String status,
            String tone,
            String agentName,
            String source,
            String riskTitle,
            String riskBody,
            List<EvidenceItem> evidenceItems,
            List<Row> decisionRows,
            List<Row> itemRows,
            List<TraceStep> agentSteps,
            List<Row> permissionRiskRows,
            List<Row> paymentMappingRows,
            List<TruthPanel.Section> truthSections
    ) {
        this.title = title;
        this.status = status;
        this.tone = tone;
        this.agentName = agentName;
        this.source = source;
        this.riskTitle = riskTitle;
        this.riskBody = riskBody;
        this.evidenceItems = evidenceItems;
        this.decisionRows = decisionRows;
        this.itemRows = itemRows;
        this.agentSteps = agentSteps;
        this.permissionRiskRows = permissionRiskRows;
        this.paymentMappingRows = paymentMappingRows;
        this.truthSections = truthSections;
    }

    static TransactionDossier from(PaymentIntent intent) {
        PaymentRequest request = intent.request;
        String tone = dossierTone(intent);
        return new TransactionDossier(
                dossierTitle(intent, tone),
                dossierStatus(intent, tone),
                tone,
                firstNonEmpty(request.sourceAgentName, request.sourceDeviceLabel, request.sourceDeviceId, request.sourceType, "Agent"),
                firstNonEmpty(request.sourceChannel, request.sourceRuntime, request.payeeDomain, "local wallet"),
                riskTitle(intent, tone),
                riskBody(intent, tone),
                evidenceItems(intent, tone),
                decisionRows(intent),
                itemRows(intent),
                agentSteps(intent, tone),
                permissionRiskRows(intent, tone),
                paymentMappingRows(intent),
                TruthPanel.sections(request)
        );
    }

    private static String dossierTone(PaymentIntent intent) {
        PaymentRequest request = intent.request;
        if (intent.isExpired()) return TONE_DANGER;
        if ("danger".equals(request.riskLevel) || "blocked".equals(request.riskReviewStatus)
                || "blocked".equals(request.reviewState)
                || arrayLength(request.risk.optJSONArray("errors")) > 0
                || containsMismatch(request.risk.optJSONArray("errors"))
                || containsMismatch(request.riskFindings)) {
            return TONE_DANGER;
        }
        if (request.contextMissing || "missing_context".equals(request.riskReviewStatus)
                || "missing_context".equals(request.reviewState)
                || "needs_review".equals(request.reviewState)
                || "source_review_required".equals(request.reviewState)
                || arrayLength(request.missingContext) > 0
                || arrayLength(request.risk.optJSONArray("warnings")) > 0
                || arrayLength(request.riskFindings) > 0) {
            return TONE_CAUTION;
        }
        return TONE_SAFE;
    }

    private static String dossierTitle(PaymentIntent intent, String tone) {
        if (TONE_DANGER.equals(tone) && hasPayeeOrRecipientMismatch(intent.request)) return "Recipient conflict";
        if (TONE_DANGER.equals(tone)) return "Risk blocked";
        if (intent.request.contextMissing || arrayLength(intent.request.missingContext) > 0) return "Missing evidence";
        if (TONE_CAUTION.equals(tone)) return "Review sources";
        return "Complete evidence";
    }

    private static String dossierStatus(PaymentIntent intent, String tone) {
        if (TONE_DANGER.equals(tone) && hasPayeeOrRecipientMismatch(intent.request)) return "Needs correction";
        if (TONE_DANGER.equals(tone)) return "Blocked";
        if (intent.request.contextMissing || arrayLength(intent.request.missingContext) > 0) return "Evidence missing";
        if (TONE_CAUTION.equals(tone)) return "Review sources";
        return "Complete dossier";
    }

    private static String riskTitle(PaymentIntent intent, String tone) {
        if (TONE_DANGER.equals(tone) && hasPayeeOrRecipientMismatch(intent.request)) return "Payee and recipient conflict";
        if (TONE_DANGER.equals(tone)) return "Approval is blocked";
        if (intent.request.contextMissing || arrayLength(intent.request.missingContext) > 0) return "Context bundle incomplete";
        if (TONE_CAUTION.equals(tone)) return "Sources need review";
        return "Evidence is complete";
    }

    private static String riskBody(PaymentIntent intent, String tone) {
        PaymentRequest request = intent.request;
        String firstError = firstRiskMessage(request.risk.optJSONArray("errors"), request.riskFindings);
        if (TONE_DANGER.equals(tone) && isUseful(firstError)) return firstError;
        if (TONE_DANGER.equals(tone)) return "A blocking risk rule prevents this Payment Request from being signed.";
        if (request.contextMissing || arrayLength(request.missingContext) > 0) {
            return "The payment facts are visible, but required evidence was not received.";
        }
        String firstWarning = firstRiskMessage(request.risk.optJSONArray("warnings"), request.riskFindings);
        if (TONE_CAUTION.equals(tone) && isUseful(firstWarning)) return firstWarning;
        if (TONE_CAUTION.equals(tone)) return "Some sources are observed, inferred, or missing enough proof for automatic trust.";
        return "The merchant, items, agent trace, risk checks, and payment mapping are available for review.";
    }

    private static List<EvidenceItem> evidenceItems(PaymentIntent intent, String dossierTone) {
        PaymentRequest request = intent.request;
        List<EvidenceItem> items = new ArrayList<>();
        if (isUseful(request.payeeName)) {
            items.add(new EvidenceItem(
                    request.payeeName,
                    request.payeeVerified ? "Verified merchant profile" : firstNonEmpty(request.payeeDomain, "Merchant profile"),
                    request.payeeVerified ? TONE_SAFE : TONE_INFO
            ));
        }
        for (DemoOrderMetadata.OrderItem orderItem : intent.demo.orderItems) {
            String meta = firstNonEmpty(
                    joinDisplay(orderItem.lineTotalUsd, isUseful(orderItem.lineTotalUsd) ? "USDC" : ""),
                    orderItem.description,
                    "Item evidence attached"
            );
            items.add(new EvidenceItem(orderItem.name, meta, isUseful(orderItem.imageUrl) ? TONE_INFO : TONE_CAUTION));
            if (items.size() >= 4) break;
        }
        if (isUseful(intent.demo.orderId)) {
            items.add(new EvidenceItem("Order receipt", firstNonEmpty(intent.demo.orderTotalUsd, intent.demo.orderId), TONE_SAFE));
        }
        for (int i = 0; i < request.evidence.length(); i++) {
            JSONObject evidence = request.evidence.optJSONObject(i);
            if (evidence == null) continue;
            items.add(new EvidenceItem(
                    firstNonEmpty(evidence.optString("title", ""), evidence.optString("type", ""), evidence.optString("evidence_id", ""), "Evidence"),
                    firstNonEmpty(evidence.optString("source_url", ""), evidence.optString("captured_at", ""), evidence.optString("hash", ""), "Source material attached"),
                    evidence.optJSONObject("signature") != null && evidence.optJSONObject("signature").optBoolean("verified", false) ? TONE_SAFE : TONE_INFO
            ));
        }
        if (!request.contextMissing && arrayLength(request.missingContext) == 0) {
            items.add(new EvidenceItem("Payment mapping", "Payee, amount, network, recipient, fee, and total are visible", TONE_SAFE));
        }
        if (items.isEmpty() || request.contextMissing || arrayLength(request.missingContext) > 0) {
            items.add(new EvidenceItem("Evidence not received", "Missing", TONE_DANGER));
            if (items.size() == 1) items.add(new EvidenceItem("Agent trace", "Partial or missing", TONE_CAUTION));
        }
        return items;
    }

    private static List<Row> decisionRows(PaymentIntent intent) {
        PaymentRequest request = intent.request;
        List<Row> rows = new ArrayList<>();
        rows.add(new Row(
                "User intent",
                firstNonEmpty(
                        request.transactionContextSnapshot.optString("user_intent", ""),
                        request.context.optString("user_intent", ""),
                        intent.demo.agentPrompt,
                        intent.summary(),
                        "Payment Request created by agent"
                ),
                "Why this payment exists",
                TONE_INFO
        ));
        rows.add(new Row(
                "Merchant identity",
                firstNonEmpty(joinDisplay(request.payeeName, request.payeeDomain), request.payeeName, request.payeeDomain, "Unknown payee"),
                request.payeeVerified ? "Verified domain or profile attached" : "Identity is not verified by wallet",
                request.payeeVerified ? TONE_SAFE : TONE_CAUTION
        ));
        rows.add(new Row(
                "Decision state",
                firstNonEmpty(request.statusLabel, request.riskLabel, "Awaiting review"),
                "Payment facts stay separate from agent context",
                dossierTone(intent)
        ));
        rows.add(new Row(
                "User control point",
                "Agent can prepare a request; only the user wallet can sign.",
                "No agent, connector, or server receives signing authority",
                TONE_SAFE
        ));
        return rows;
    }

    private static List<Row> itemRows(PaymentIntent intent) {
        List<Row> rows = new ArrayList<>();
        for (DemoOrderMetadata.OrderItem item : intent.demo.orderItems) {
            rows.add(new Row(
                    item.quantity + "x " + item.name,
                    firstNonEmpty(item.lineTotalUsd, item.description, "Item attached"),
                    firstNonEmpty(item.note, item.url, item.imageUrl, "Evidence item"),
                    isUseful(item.imageUrl) ? TONE_INFO : TONE_CAUTION
            ));
        }
        addGenericItems(rows, firstArray(
                intent.request.transactionContextSnapshot.optJSONArray("items"),
                intent.request.context.optJSONArray("items"),
                intent.request.metadata.optJSONArray("items")
        ));
        if (rows.isEmpty() && (intent.request.contextMissing || arrayLength(intent.request.missingContext) > 0)) {
            rows.add(new Row("Items", "Evidence not received", "Missing", TONE_DANGER));
        }
        if (rows.isEmpty()) rows.add(new Row("Items", "No itemized evidence attached", "Payment facts remain visible", TONE_CAUTION));
        return rows;
    }

    private static void addGenericItems(List<Row> rows, JSONArray array) {
        if (array == null) return;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) continue;
            String quantity = item.optString("quantity", "");
            String title = firstNonEmpty(item.optString("name", ""), item.optString("title", ""), item.optString("item_id", ""), "Item");
            if (isUseful(quantity)) title = quantity + "x " + title;
            rows.add(new Row(
                    title,
                    firstNonEmpty(item.optString("line_total", ""), item.optString("price", ""), item.optString("summary", ""), "Item context"),
                    firstNonEmpty(item.optString("evidence", ""), item.optString("source", ""), item.optString("url", ""), "Context item"),
                    TONE_INFO
            ));
        }
    }

    private static List<TraceStep> agentSteps(PaymentIntent intent, String dossierTone) {
        List<TraceStep> steps = new ArrayList<>();
        addTraceSteps(steps, firstArray(
                intent.request.transactionContextSnapshot.optJSONArray("agent_trace"),
                intent.request.transactionContextSnapshot.optJSONArray("ai_task_trace"),
                intent.request.transactionContextSnapshot.optJSONArray("agent_steps"),
                intent.request.context.optJSONArray("agent_trace"),
                intent.request.context.optJSONArray("ai_task_trace"),
                intent.request.context.optJSONArray("agent_steps")
        ));
        if (steps.isEmpty() && isUseful(intent.demo.agentPrompt)) {
            steps.add(new TraceStep("Read user intent", intent.demo.agentPrompt, TONE_INFO));
        }
        if (steps.isEmpty() && intent.demo.hasOrderDetails()) {
            steps.add(new TraceStep("Built transaction context", firstNonEmpty(intent.demo.itemSummary, "Order evidence attached"), TONE_INFO));
        }
        if (steps.isEmpty()) {
            steps.add(new TraceStep("Created Payment Request", "Agent prepared a request for wallet review.", TONE_INFO));
        }
        steps.add(new TraceStep("Checked permission", "Agent can request payment, but cannot sign on the user's behalf.", TONE_SAFE));
        if (TONE_DANGER.equals(dossierTone)) {
            steps.add(new TraceStep("Blocked approval", "A blocking risk check prevents signing.", TONE_DANGER));
        } else if (intent.request.contextMissing || arrayLength(intent.request.missingContext) > 0) {
            steps.add(new TraceStep("Approval paused", "Evidence not received, so signing stays unavailable.", TONE_CAUTION));
        } else {
            steps.add(new TraceStep("Prepared Payment Request", "Final chain action is shown in Payment mapping.", TONE_SAFE));
        }
        return steps;
    }

    private static void addTraceSteps(List<TraceStep> steps, JSONArray array) {
        if (array == null) return;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) {
                String text = array.optString(i, "");
                if (isUseful(text)) steps.add(new TraceStep("Agent step", text, TONE_INFO));
                continue;
            }
            steps.add(new TraceStep(
                    firstNonEmpty(item.optString("title", ""), item.optString("step", ""), item.optString("name", ""), "Agent step"),
                    firstNonEmpty(item.optString("body", ""), item.optString("summary", ""), item.optString("message", ""), item.optString("status", ""), "Recorded in transaction context"),
                    toneFromValue(item.optString("tone", ""), item.optString("status", ""))
            ));
        }
    }

    private static List<Row> permissionRiskRows(PaymentIntent intent, String dossierTone) {
        PaymentRequest request = intent.request;
        List<Row> rows = new ArrayList<>();
        rows.add(new Row("Agent permission", "Request payments only", "Signing on behalf is not grantable", TONE_SAFE));
        rows.add(new Row("Local signing", "Required on this device", "User approval remains the signing boundary", TONE_SAFE));
        rows.add(new Row("Risk state", firstNonEmpty(request.riskLabel, request.statusLabel, "Ready"), riskBody(intent, dossierTone), dossierTone));
        addRiskRows(rows, request.risk.optJSONArray("errors"), TONE_DANGER);
        addRiskRows(rows, request.risk.optJSONArray("warnings"), TONE_CAUTION);
        addRiskRows(rows, request.riskFindings, TONE_CAUTION);
        addMissingRows(rows, request.missingContext);
        if (request.contextMissing && !hasLabel(rows, "Transaction Context")) {
            rows.add(new Row("Transaction Context", "Evidence not received", "Required context or evidence did not arrive.", TONE_DANGER));
        }
        return rows;
    }

    private static void addRiskRows(List<Row> rows, JSONArray array, String fallbackTone) {
        if (array == null) return;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) {
                String text = array.optString(i, "");
                if (isUseful(text)) rows.add(new Row("Risk finding", fallbackTone.equals(TONE_DANGER) ? "Blocked" : "Needs review", text, fallbackTone));
                continue;
            }
            String code = item.optString("code", "");
            String severity = item.optString("severity", "");
            rows.add(new Row(
                    firstNonEmpty(item.optString("field", ""), item.optString("path", ""), titleize(code, "Risk finding")),
                    valueForRisk(code, severity, fallbackTone),
                    firstNonEmpty(item.optString("message", ""), item.optString("reason", ""), "Risk check requires review"),
                    toneFromValue(item.optString("tone", ""), firstNonEmpty(severity, fallbackTone))
            ));
        }
    }

    private static void addMissingRows(List<Row> rows, JSONArray array) {
        if (array == null) return;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) {
                String text = array.optString(i, "");
                if (isUseful(text)) rows.add(new Row("Missing context", "Evidence not received", text, TONE_DANGER));
                continue;
            }
            rows.add(new Row(
                    firstNonEmpty(item.optString("field", ""), item.optString("path", ""), item.optString("code", ""), "Missing context"),
                    "Evidence not received",
                    firstNonEmpty(item.optString("message", ""), item.optString("reason", ""), "Required evidence did not arrive."),
                    TONE_DANGER
            ));
        }
    }

    private static List<Row> paymentMappingRows(PaymentIntent intent) {
        PaymentRequest request = intent.request;
        List<Row> rows = new ArrayList<>();
        rows.add(new Row("Amount", firstNonEmpty(request.amount, intent.amount, "Unknown"), "Payment Request amount", TONE_SAFE));
        rows.add(new Row("Token", firstNonEmpty(request.asset, intent.asset, "Unknown token"), firstNonEmpty(request.tokenContract, request.assetIssuer, "Native or request asset"), TONE_SAFE));
        rows.add(new Row("Network", firstNonEmpty(request.network, intent.network, "Unknown network"), request.chainId > 0 ? "Chain ID " + request.chainId : "Network from request", TONE_SAFE));
        rows.add(new Row("Recipient", shortAddress(firstNonEmpty(request.recipient, intent.to, "Unknown recipient")), "Final on-chain recipient", request.recipient.length() > 0 ? TONE_SAFE : TONE_DANGER));
        rows.add(new Row("Network fee", firstNonEmpty(request.estimatedFee, intent.estimatedFee, "Not estimated"), "Wallet preview", isUseful(request.estimatedFee) || isUseful(intent.estimatedFee) ? TONE_INFO : TONE_CAUTION));
        rows.add(new Row("Total", appendToken(firstNonEmpty(request.total, request.amount, intent.amount, "Unknown"), firstNonEmpty(request.asset, intent.asset, "")), "Amount plus fee when available", TONE_SAFE));
        return rows;
    }

    private static boolean hasPayeeOrRecipientMismatch(PaymentRequest request) {
        return containsCode(request.risk.optJSONArray("errors"), "payee_mismatch")
                || containsCode(request.risk.optJSONArray("errors"), "context_payee_mismatch")
                || containsMismatch(request.risk.optJSONArray("errors"))
                || containsMismatch(request.riskFindings);
    }

    private static boolean containsMismatch(JSONArray array) {
        if (array == null) return false;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            String text = item == null ? array.optString(i, "") : firstNonEmpty(item.optString("code", ""), item.optString("message", ""), item.optString("reason", ""));
            if (text.toLowerCase().contains("mismatch") || text.toLowerCase().contains("conflict")) return true;
        }
        return false;
    }

    private static boolean containsCode(JSONArray array, String code) {
        if (array == null) return false;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item != null && code.equals(item.optString("code", ""))) return true;
        }
        return false;
    }

    private static String firstRiskMessage(JSONArray primary, JSONArray fallback) {
        String value = firstRiskMessage(primary);
        return isUseful(value) ? value : firstRiskMessage(fallback);
    }

    private static String firstRiskMessage(JSONArray array) {
        if (array == null) return "";
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item != null) {
                return firstNonEmpty(item.optString("message", ""), item.optString("reason", ""), item.optString("code", ""));
            }
            String value = array.optString(i, "");
            if (isUseful(value)) return value;
        }
        return "";
    }

    private static boolean hasLabel(List<Row> rows, String label) {
        for (Row row : rows) {
            if (label.equals(row.label)) return true;
        }
        return false;
    }

    private static JSONArray firstArray(JSONArray... arrays) {
        if (arrays == null) return null;
        for (JSONArray array : arrays) {
            if (array != null && array.length() > 0) return array;
        }
        return null;
    }

    private static int arrayLength(JSONArray array) {
        return array == null ? 0 : array.length();
    }

    private static String valueForRisk(String code, String severity, String fallbackTone) {
        String lower = code == null ? "" : code.toLowerCase();
        if (lower.contains("missing")) return "Evidence not received";
        if (lower.contains("mismatch") || lower.contains("conflict")) return "Conflicted";
        if (lower.contains("ai")) return "AI-only";
        if (isUseful(severity)) return titleize(severity, fallbackTone.equals(TONE_DANGER) ? "Blocked" : "Needs review");
        return fallbackTone.equals(TONE_DANGER) ? "Blocked" : "Needs review";
    }

    private static String toneFromValue(String explicitTone, String status) {
        if (TONE_DANGER.equals(explicitTone) || TONE_CAUTION.equals(explicitTone)
                || TONE_SAFE.equals(explicitTone) || TONE_INFO.equals(explicitTone)) return explicitTone;
        String lower = status == null ? "" : status.toLowerCase();
        if (lower.contains("block") || lower.contains("danger") || lower.contains("error") || lower.contains("missing") || lower.contains("conflict")) return TONE_DANGER;
        if (lower.contains("warn") || lower.contains("review") || lower.contains("caution") || lower.contains("partial")) return TONE_CAUTION;
        if (lower.contains("safe") || lower.contains("verified") || lower.contains("ready") || lower.contains("success")) return TONE_SAFE;
        return TONE_INFO;
    }

    private static String appendToken(String value, String token) {
        if (!isUseful(token) || value.toLowerCase().contains(token.toLowerCase())) return value;
        return value + " " + token;
    }

    private static String joinDisplay(String left, String right) {
        if (!isUseful(left)) return isUseful(right) ? right : "";
        if (!isUseful(right)) return left;
        return left + " " + right;
    }

    private static String shortAddress(String value) {
        // Delegates to the shared AddressFormat (D9/Q5) — unified 10…8 form.
        return AddressFormat.medium(value);
    }

    private static String titleize(String value, String fallback) {
        if (!isUseful(value)) return fallback;
        String clean = value.replace('_', ' ').replace('-', ' ').trim();
        if (clean.length() == 0) return fallback;
        return clean.substring(0, 1).toUpperCase() + clean.substring(1);
    }

    private static String firstNonEmpty(String... values) {
        if (values == null) return "";
        for (String value : values) {
            if (isUseful(value)) return value.trim();
        }
        return "";
    }

    private static boolean isUseful(String value) {
        if (value == null) return false;
        String clean = value.trim();
        return clean.length() > 0 && !"null".equalsIgnoreCase(clean);
    }

    static final class EvidenceItem {
        final String title;
        final String meta;
        final String tone;

        EvidenceItem(String title, String meta, String tone) {
            this.title = title == null ? "" : title;
            this.meta = meta == null ? "" : meta;
            this.tone = tone == null ? TONE_INFO : tone;
        }
    }

    static final class Row {
        final String label;
        final String value;
        final String detail;
        final String tone;

        Row(String label, String value, String detail, String tone) {
            this.label = label == null ? "" : label;
            this.value = value == null ? "" : value;
            this.detail = detail == null ? "" : detail;
            this.tone = tone == null ? TONE_INFO : tone;
        }
    }

    static final class TraceStep {
        final String title;
        final String body;
        final String tone;

        TraceStep(String title, String body, String tone) {
            this.title = title == null ? "" : title;
            this.body = body == null ? "" : body;
            this.tone = tone == null ? TONE_INFO : tone;
        }
    }
}
