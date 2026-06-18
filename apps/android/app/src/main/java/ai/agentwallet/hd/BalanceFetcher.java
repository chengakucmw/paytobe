package ai.agentwallet.hd;

import org.json.JSONArray;
import org.json.JSONObject;
import org.web3j.protocol.Web3j;
import org.web3j.protocol.core.DefaultBlockParameterName;
import org.web3j.protocol.core.methods.request.Transaction;
import org.web3j.protocol.core.methods.response.EthCall;
import org.web3j.protocol.core.methods.response.EthGetBalance;
import org.web3j.protocol.http.HttpService;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.time.Instant;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

final class BalanceFetcher {
    private static final String ETHEREUM_RPC_URL = "https://ethereum-rpc.publicnode.com";
    private static final String BASE_RPC_URL = "https://mainnet.base.org";
    private static final String POLYGON_RPC_URL = "https://polygon-bor-rpc.publicnode.com";
    private static final String SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
    private static final String STELLAR_HORIZON_URL = "https://horizon.stellar.org";
    private static final String BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    private static final String ERC20_BALANCE_OF = "70a08231";
    private static final OkHttpClient HTTP = WalletHttp.oneShot();
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");

    private BalanceFetcher() {}

    static JSONObject fetch(HDWallet wallet) throws Exception {
        JSONObject assets = new JSONObject();
        assets.put("eth", safe(() -> nativeEvm(wallet, ETHEREUM_RPC_URL, "Ethereum", "ETH")));
        assets.put("base_eth", safe(() -> baseEth(wallet)));
        assets.put("polygon_matic", safe(() -> nativeEvm(wallet, POLYGON_RPC_URL, "Polygon", "MATIC")));
        assets.put("base_usdc", safe(() -> baseUsdc(wallet)));
        assets.put("sol", safe(() -> sol(wallet)));
        assets.put("xlm", safe(() -> xlm(wallet)));
        return new JSONObject()
                .put("updated_at", Instant.now().toString())
                .put("assets", assets);
    }

    private static JSONObject baseEth(HDWallet wallet) throws Exception {
        return nativeEvm(wallet, BASE_RPC_URL, "Base", "ETH");
    }

    private static JSONObject nativeEvm(HDWallet wallet, String rpcUrl, String network, String symbol) throws Exception {
        Web3j web3j = Web3j.build(new HttpService(rpcUrl, HTTP));
        EthGetBalance response = web3j.ethGetBalance(wallet.evm.address, DefaultBlockParameterName.LATEST).send();
        if (response.hasError()) throw new IllegalStateException(response.getError().getMessage());
        return asset(network + " " + symbol, network, symbol, wallet.evm.address, formatUnits(response.getBalance(), 18), "ok");
    }

    private static JSONObject baseUsdc(HDWallet wallet) throws Exception {
        Web3j web3j = Web3j.build(new HttpService(BASE_RPC_URL, HTTP));
        String data = "0x" + ERC20_BALANCE_OF + leftPad(wallet.evm.address.substring(2).toLowerCase(), 64);
        EthCall response = web3j.ethCall(
                Transaction.createEthCallTransaction(wallet.evm.address, BASE_USDC, data),
                DefaultBlockParameterName.LATEST
        ).send();
        if (response.hasError()) throw new IllegalStateException(response.getError().getMessage());
        String hex = response.getValue();
        BigInteger units = new BigInteger(stripHex(hex.length() == 0 ? "0x0" : hex), 16);
        return asset("Base USDC", "Base", "USDC", wallet.evm.address, formatUnits(units, 6), "ok");
    }

    private static JSONObject sol(HDWallet wallet) throws Exception {
        JSONObject body = new JSONObject()
                .put("jsonrpc", "2.0")
                .put("id", 1)
                .put("method", "getBalance")
                .put("params", new JSONArray().put(wallet.solana.address));
        JSONObject response = post(SOLANA_RPC_URL, body);
        if (response.has("error")) throw new IllegalStateException(response.getJSONObject("error").toString());
        BigInteger lamports = BigInteger.valueOf(response.getJSONObject("result").getLong("value"));
        return asset("Solana", "Solana", "SOL", wallet.solana.address, formatUnits(lamports, 9), "ok");
    }

    private static JSONObject xlm(HDWallet wallet) throws Exception {
        Request request = new Request.Builder()
                .url(STELLAR_HORIZON_URL + "/accounts/" + wallet.stellar.address)
                .get()
                .build();
        try (Response response = HTTP.newCall(request).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (response.code() == 404) {
                return asset("Stellar", "Stellar", "XLM", wallet.stellar.address, "0", "inactive");
            }
            if (!response.isSuccessful()) throw new IllegalStateException("HTTP " + response.code() + ": " + text);
            JSONArray balances = new JSONObject(text).getJSONArray("balances");
            for (int i = 0; i < balances.length(); i++) {
                JSONObject item = balances.getJSONObject(i);
                if ("native".equals(item.optString("asset_type", ""))) {
                    return asset("Stellar", "Stellar", "XLM", wallet.stellar.address, trimDecimal(item.getString("balance")), "ok");
                }
            }
            return asset("Stellar", "Stellar", "XLM", wallet.stellar.address, "0", "ok");
        }
    }

    private static JSONObject safe(FetchCall call) {
        try {
            return call.run();
        } catch (Exception e) {
            JSONObject out = new JSONObject();
            try {
                out.put("balance", "--");
                out.put("status", "error");
                out.put("error", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            } catch (Exception ignored) {
            }
            return out;
        }
    }

    private static JSONObject asset(String name, String network, String symbol, String address, String balance, String status) throws Exception {
        return new JSONObject()
                .put("name", name)
                .put("network", network)
                .put("symbol", symbol)
                .put("address", address)
                .put("balance", balance)
                .put("status", status);
    }

    private static JSONObject post(String url, JSONObject body) throws Exception {
        Request request = new Request.Builder()
                .url(url)
                .post(RequestBody.create(body.toString(), JSON))
                .build();
        try (Response response = HTTP.newCall(request).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) throw new IllegalStateException("HTTP " + response.code() + ": " + text);
            return new JSONObject(text);
        }
    }

    private static String formatUnits(BigInteger units, int decimals) {
        BigDecimal value = new BigDecimal(units).movePointLeft(decimals);
        return trimDecimal(value.setScale(Math.min(decimals, 8), RoundingMode.DOWN).toPlainString());
    }

    private static String trimDecimal(String value) {
        if (!value.contains(".")) return value;
        return value.replaceAll("0+$", "").replaceAll("\\.$", "");
    }

    private static String leftPad(String value, int width) {
        StringBuilder out = new StringBuilder(width);
        for (int i = value.length(); i < width; i++) out.append('0');
        out.append(value);
        return out.toString();
    }

    private static String stripHex(String value) {
        String clean = value == null ? "" : value.trim();
        if (clean.startsWith("0x")) clean = clean.substring(2);
        return clean.length() == 0 ? "0" : clean;
    }

    private interface FetchCall {
        JSONObject run() throws Exception;
    }
}
