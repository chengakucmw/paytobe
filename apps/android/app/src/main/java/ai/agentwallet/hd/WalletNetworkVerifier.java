package ai.agentwallet.hd;

import org.json.JSONObject;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

final class WalletNetworkVerifier {
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final OkHttpClient HTTP = WalletHttp.oneShot();

    private WalletNetworkVerifier() {}

    static Result verifyEvmRpc(String rpcUrl, long expectedChainId) throws Exception {
        JSONObject payload = new JSONObject()
                .put("jsonrpc", "2.0")
                .put("id", 1)
                .put("method", "eth_chainId")
                .put("params", new org.json.JSONArray());
        Request request = new Request.Builder()
                .url(rpcUrl)
                .post(RequestBody.create(payload.toString(), JSON))
                .build();
        try (Response response = HTTP.newCall(request).execute()) {
            String body = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) throw new IllegalStateException("RPC returned HTTP " + response.code());
            JSONObject json = new JSONObject(body);
            if (json.has("error")) throw new IllegalStateException(json.getJSONObject("error").optString("message", "RPC returned an error"));
            String rpcChainId = json.optString("result", "");
            long actual = WalletNetworkValidator.parseRpcChainId(rpcChainId);
            if (actual != expectedChainId) {
                throw new IllegalStateException("RPC chain ID " + actual + " does not match entered Chain ID " + expectedChainId);
            }
            return new Result(rpcChainId, actual);
        }
    }

    static final class Result {
        final String rpcChainId;
        final long decimalChainId;

        Result(String rpcChainId, long decimalChainId) {
            this.rpcChainId = rpcChainId;
            this.decimalChainId = decimalChainId;
        }
    }
}
