package ai.agentwallet.hd;

final class PaymentInboxFilter {
    static final String FILTER_ALL = "all";
    static final String FILTER_PENDING = "pending";
    static final String FILTER_SIGNED = "signed";
    static final String FILTER_COMPLETED = "completed";
    // 兼容旧值（"final" 等同 "completed"，终态）。
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
        String cleanFilter = filter == null ? FILTER_ALL : filter;
        if (FILTER_ALL.equals(cleanFilter)) return true;
        if (FILTER_SIGNED.equals(cleanFilter)) return isSignedState(state);
        // "completed" 与旧的 "final" 同义：终态（confirmed/rejected/expired/cancelled）+ failed。
        if (FILTER_COMPLETED.equals(cleanFilter) || FILTER_FINAL.equals(cleanFilter)) return isCompletedState(state);
        // 其余（含 FILTER_PENDING）：签名前、需要用户关注的活跃态。
        return isActiveAttentionState(state);
    }

    /** Pending：签名前、需要用户关注的活跃态（不含已签名/广播中，也不含终态/失败）。 */
    static boolean isActiveAttentionState(String state) {
        String value = normalizeState(state);
        return "pending".equals(value)
                || "awaiting_signature".equals(value)
                || "missing_context".equals(value)
                || "blocked".equals(value)
                || "network_disabled".equals(value)
                || "needs_review".equals(value)
                || "source_review_required".equals(value);
    }

    /** Signed：已在本机签名但尚未落地（signed_locally + broadcasting）。 */
    static boolean isSignedState(String state) {
        String value = normalizeState(state);
        return "signed_locally".equals(value) || "broadcasting".equals(value);
    }

    /** Completed：终态（confirmed/rejected/expired/cancelled）+ failed（流程已结束）。 */
    static boolean isCompletedState(String state) {
        return isFinalState(state) || "failed".equals(normalizeState(state));
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

    /**
     * 状态药丸的语气：由「生命周期/有效状态」决定（区别于纯风险等级 riskLevel）。
     * 返回值供 UI 的 vpToneOf 直接消费：safe/caution/danger/expired/info。
     * 特别地，expired 必须独立于 info（蓝），确保收件箱/活动/详情里过期项呈灰+时钟。
     */
    static String toneForState(String state) {
        String value = normalizeState(state);
        if ("expired".equals(value)) return "expired";
        if ("confirmed".equals(value)) return "safe";
        if ("failed".equals(value) || "blocked".equals(value) || "rejected".equals(value)
                || "cancelled".equals(value)) {
            return "danger";
        }
        if ("missing_context".equals(value) || "network_disabled".equals(value)
                || "needs_review".equals(value) || "source_review_required".equals(value)) {
            return "caution";
        }
        if ("pending".equals(value) || "awaiting_signature".equals(value)) return "caution";
        // signed_locally / broadcasting / 其余 → 信息态。
        return "info";
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
