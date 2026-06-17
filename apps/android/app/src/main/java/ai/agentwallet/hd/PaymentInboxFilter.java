package ai.agentwallet.hd;

final class PaymentInboxFilter {
    static final String FILTER_PENDING = "pending";
    static final String FILTER_ALL = "all";
    static final String FILTER_FINAL = "final";

    private PaymentInboxFilter() {}

    static String effectiveState(String lifecycleStatus, String reviewState, String riskReviewStatus, String riskLevel, boolean expired) {
        String lifecycle = normalizeState(lifecycleStatus);
        String review = normalizeState(reviewState);
        if (expired && !isFinalState(lifecycle) && !"failed".equals(lifecycle)
                && !"broadcasting".equals(lifecycle) && !"signed_locally".equals(lifecycle)) {
            return "expired";
        }
        if (review.length() > 0 && !"pending".equals(review) && !"awaiting_signature".equals(review)) {
            return review;
        }
        if (isFinalState(lifecycle) || "failed".equals(lifecycle)
                || "broadcasting".equals(lifecycle) || "signed_locally".equals(lifecycle)) {
            return lifecycle;
        }
        String riskStatus = normalizeState(riskReviewStatus);
        String level = normalizeState(riskLevel);
        if ("blocked".equals(riskStatus) || "danger".equals(level)) return "blocked";
        if ("missing_context".equals(riskStatus)) return "missing_context";
        if ("network_disabled".equals(riskStatus)) return "network_disabled";
        if ("source_review_required".equals(riskStatus)) return "source_review_required";
        if ("needs_review".equals(riskStatus)) return "needs_review";
        return "pending";
    }

    static boolean matches(String filter, String state) {
        String cleanFilter = filter == null ? FILTER_PENDING : filter;
        if (FILTER_ALL.equals(cleanFilter)) return true;
        if (FILTER_FINAL.equals(cleanFilter)) return isFinalState(state);
        return isActiveAttentionState(state);
    }

    static boolean isActiveAttentionState(String state) {
        String value = normalizeState(state);
        return "pending".equals(value)
                || "awaiting_signature".equals(value)
                || "missing_context".equals(value)
                || "blocked".equals(value)
                || "network_disabled".equals(value)
                || "broadcasting".equals(value)
                || "failed".equals(value)
                || "needs_review".equals(value)
                || "source_review_required".equals(value)
                || "signed_locally".equals(value);
    }

    static boolean isFinalState(String state) {
        String value = normalizeState(state);
        return "confirmed".equals(value)
                || "rejected".equals(value)
                || "expired".equals(value)
                || "cancelled".equals(value);
    }

    static int compare(String stateA, long createdA, long expiresA, String stateB, long createdB, long expiresB) {
        int rankA = sortRank(stateA);
        int rankB = sortRank(stateB);
        if (rankA != rankB) return Integer.compare(rankA, rankB);
        if (rankA <= 4 && expiresA > 0L && expiresB > 0L && expiresA != expiresB) {
            return Long.compare(expiresA, expiresB);
        }
        return Long.compare(createdB, createdA);
    }

    static int sortRank(String state) {
        String value = normalizeState(state);
        if ("blocked".equals(value)) return 0;
        if ("network_disabled".equals(value)) return 1;
        if ("missing_context".equals(value)) return 2;
        if ("source_review_required".equals(value) || "needs_review".equals(value)) return 3;
        if ("pending".equals(value) || "awaiting_signature".equals(value)) return 4;
        if ("failed".equals(value)) return 5;
        if ("broadcasting".equals(value) || "signed_locally".equals(value)) return 6;
        if (isFinalState(value)) return 20;
        return 10;
    }

    static String label(String state) {
        String value = normalizeState(state);
        if ("missing_context".equals(value)) return "Missing context";
        if ("blocked".equals(value)) return "Risk blocked";
        if ("network_disabled".equals(value)) return "Network disabled";
        if ("needs_review".equals(value)) return "Needs review";
        if ("source_review_required".equals(value)) return "Source review";
        if ("signed_locally".equals(value)) return "Signed locally";
        if ("broadcasting".equals(value)) return "Broadcasting";
        if ("failed".equals(value)) return "Failed";
        if ("confirmed".equals(value)) return "Confirmed";
        if ("rejected".equals(value)) return "Rejected";
        if ("expired".equals(value)) return "Expired";
        if ("cancelled".equals(value)) return "Cancelled";
        return "Awaiting signature";
    }

    static String normalizeState(String state) {
        if (state == null) return "";
        String value = state.trim().toLowerCase().replace('-', '_').replace(' ', '_');
        if ("pending_user_approval".equals(value) || "awaiting_user_signature".equals(value)) return "pending";
        if ("broadcasted".equals(value)) return "broadcasting";
        if ("signed".equals(value)) return "signed_locally";
        return "null".equals(value) ? "" : value;
    }
}
