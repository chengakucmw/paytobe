package ai.agentwallet.hd;

interface TransactionProgress {
    void onGenerated(String detail) throws Exception;
}
