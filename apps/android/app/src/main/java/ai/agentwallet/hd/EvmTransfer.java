package ai.agentwallet.hd;

import org.web3j.crypto.Credentials;
import org.web3j.crypto.RawTransaction;
import org.web3j.crypto.TransactionEncoder;
import org.web3j.protocol.Web3j;
import org.web3j.protocol.core.DefaultBlockParameterName;
import org.web3j.protocol.core.methods.request.Transaction;
import org.web3j.protocol.core.methods.response.EthEstimateGas;
import org.web3j.protocol.core.methods.response.EthGetTransactionCount;
import org.web3j.protocol.core.methods.response.EthGasPrice;
import org.web3j.protocol.core.methods.response.EthSendTransaction;
import org.web3j.protocol.http.HttpService;
import org.web3j.utils.Convert;
import org.web3j.utils.Numeric;

import java.math.BigDecimal;
import java.math.BigInteger;

import okhttp3.OkHttpClient;

final class EvmTransfer {
    private static final String ERC20_TRANSFER_SELECTOR = "a9059cbb";
    private static final BigInteger ERC20_FALLBACK_GAS = BigInteger.valueOf(100_000);
    private static final OkHttpClient HTTP = WalletHttp.oneShot();

    /** When true (default), EVM transactions are signed by the shared Rust core
     *  (byte-identical to web3j, verified by a cross-check test). Set false to revert. */
    static boolean USE_SHARED_CORE_SIGNING = true;

    private EvmTransfer() {}

    static String sendNative(
            String rpcUrl,
            long chainId,
            byte[] privateKey,
            String toAddress,
            String amountNative
    ) throws Exception {
        return sendNative(rpcUrl, chainId, privateKey, toAddress, amountNative, null);
    }

    static String sendNative(
            String rpcUrl,
            long chainId,
            byte[] privateKey,
            String toAddress,
            String amountNative,
            TransactionProgress progress
    ) throws Exception {
        Web3j web3j = Web3j.build(new HttpService(rpcUrl, HTTP));
        Credentials credentials = Credentials.create(Hex.bytesToHex(privateKey));
        EthGetTransactionCount nonceResp = web3j.ethGetTransactionCount(
                credentials.getAddress(),
                DefaultBlockParameterName.PENDING
        ).send();
        if (nonceResp.hasError()) throw new IllegalStateException(nonceResp.getError().getMessage());
        EthGasPrice gasResp = web3j.ethGasPrice().send();
        if (gasResp.hasError()) throw new IllegalStateException(gasResp.getError().getMessage());

        BigInteger nonce = nonceResp.getTransactionCount();
        BigInteger gasPrice = gasResp.getGasPrice();
        BigInteger gasLimit = BigInteger.valueOf(21_000);
        BigInteger value = Convert.toWei(new BigDecimal(amountNative), Convert.Unit.ETHER).toBigIntegerExact();
        String raw;
        if (USE_SHARED_CORE_SIGNING) {
            raw = WalletCoreBridge.signEvm(privateKey, chainId, AmountUnits.longValueExact(nonce),
                    gasPrice.toString(), AmountUnits.longValueExact(gasLimit), toAddress, value.toString(), "").rawTxHex;
        } else {
            RawTransaction tx = RawTransaction.createEtherTransaction(nonce, gasPrice, gasLimit, toAddress, value);
            byte[] signed = TransactionEncoder.signMessage(tx, chainId, credentials);
            raw = Numeric.toHexString(signed);
        }
        if (progress != null) progress.onGenerated("Signed EVM transaction");
        EthSendTransaction sent = web3j.ethSendRawTransaction(raw).send();
        if (sent.hasError()) throw new IllegalStateException(sent.getError().getMessage());
        return sent.getTransactionHash();
    }

    static String sendErc20(
            String rpcUrl,
            long chainId,
            byte[] privateKey,
            String tokenContract,
            String toAddress,
            String amount,
            int decimals
    ) throws Exception {
        return sendErc20(rpcUrl, chainId, privateKey, tokenContract, toAddress, amount, decimals, null);
    }

    static String sendErc20(
            String rpcUrl,
            long chainId,
            byte[] privateKey,
            String tokenContract,
            String toAddress,
            String amount,
            int decimals,
            TransactionProgress progress
    ) throws Exception {
        Web3j web3j = Web3j.build(new HttpService(rpcUrl, HTTP));
        Credentials credentials = Credentials.create(Hex.bytesToHex(privateKey));
        String from = credentials.getAddress();
        String contract = normalizeAddress(tokenContract, "token contract");
        String to = normalizeAddress(toAddress, "recipient");

        EthGetTransactionCount nonceResp = web3j.ethGetTransactionCount(
                from,
                DefaultBlockParameterName.PENDING
        ).send();
        if (nonceResp.hasError()) throw new IllegalStateException(nonceResp.getError().getMessage());
        EthGasPrice gasResp = web3j.ethGasPrice().send();
        if (gasResp.hasError()) throw new IllegalStateException(gasResp.getError().getMessage());

        String data = erc20TransferData(to, tokenUnits(amount, decimals));
        BigInteger nonce = nonceResp.getTransactionCount();
        BigInteger gasPrice = gasResp.getGasPrice();
        BigInteger gasLimit = estimateErc20Gas(web3j, from, contract, data);

        String raw;
        if (USE_SHARED_CORE_SIGNING) {
            // ERC-20 is a legacy EVM transaction whose value is 0 and whose `data`
            // carries the transfer() call; the shared core signs the identical
            // EIP-155 RLP (byte-checked vs web3j in VelarumWalletCoreConformanceTest).
            raw = WalletCoreBridge.signEvm(privateKey, chainId, AmountUnits.longValueExact(nonce),
                    gasPrice.toString(), AmountUnits.longValueExact(gasLimit), contract, "0", data).rawTxHex;
        } else {
            RawTransaction tx = RawTransaction.createTransaction(
                    nonce,
                    gasPrice,
                    gasLimit,
                    contract,
                    BigInteger.ZERO,
                    data
            );
            byte[] signed = TransactionEncoder.signMessage(tx, chainId, credentials);
            raw = Numeric.toHexString(signed);
        }
        if (progress != null) progress.onGenerated("Signed ERC-20 transaction");
        EthSendTransaction sent = web3j.ethSendRawTransaction(raw).send();
        if (sent.hasError()) throw new IllegalStateException(sent.getError().getMessage());
        return sent.getTransactionHash();
    }

    /**
     * Read-only live fee estimate (no signing, no broadcast): {@code gasPrice × gasLimit} in wei.
     * Native transfers use the fixed 21000 gas; ERC-20 transfers estimate gas via the node
     * (same path the send uses). Returns null on any RPC error so the caller can fall back.
     */
    static BigInteger estimateFeeWei(
            String rpcUrl,
            String fromAddress,
            String tokenContract,
            String toAddress,
            String amount,
            int decimals,
            boolean erc20
    ) {
        try {
            Web3j web3j = Web3j.build(new HttpService(rpcUrl, HTTP));
            EthGasPrice gasResp = web3j.ethGasPrice().send();
            if (gasResp.hasError()) return null;
            BigInteger gasPrice = gasResp.getGasPrice();
            BigInteger gasLimit;
            if (erc20) {
                String from = normalizeAddress(fromAddress, "sender");
                String contract = normalizeAddress(tokenContract, "token contract");
                String to = normalizeAddress(toAddress, "recipient");
                String data = erc20TransferData(to, tokenUnits(amount, decimals));
                gasLimit = estimateErc20Gas(web3j, from, contract, data);
            } else {
                gasLimit = BigInteger.valueOf(21_000);
            }
            return gasPrice.multiply(gasLimit);
        } catch (Exception ignored) {
            VpLog.w("EvmTransfer", "fee estimate failed", ignored);
            return null;
        }
    }

    private static BigInteger estimateErc20Gas(Web3j web3j, String from, String contract, String data) {
        try {
            Transaction tx = Transaction.createFunctionCallTransaction(
                    from,
                    null,
                    null,
                    null,
                    contract,
                    BigInteger.ZERO,
                    data
            );
            EthEstimateGas estimate = web3j.ethEstimateGas(tx).send();
            if (!estimate.hasError() && estimate.getAmountUsed() != null && estimate.getAmountUsed().signum() > 0) {
                return estimate.getAmountUsed().multiply(BigInteger.valueOf(120)).divide(BigInteger.valueOf(100));
            }
        } catch (Exception ignored) {
            VpLog.w("EvmTransfer", "ERC-20 gas estimate failed; using fallback gas", ignored);
            return ERC20_FALLBACK_GAS;
        }
        return ERC20_FALLBACK_GAS;
    }

    private static String erc20TransferData(String toAddress, BigInteger amountUnits) {
        String cleanTo = toAddress.substring(2).toLowerCase();
        return "0x"
                + ERC20_TRANSFER_SELECTOR
                + leftPad(cleanTo, 64)
                + leftPad(amountUnits.toString(16), 64);
    }

    private static BigInteger tokenUnits(String amount, int decimals) {
        // Delegates to the shared AmountUnits (D9/Q4). Behaviour is unchanged.
        return AmountUnits.tokenUnits(amount, decimals);
    }

    private static String normalizeAddress(String address, String label) {
        String clean = address == null ? "" : address.trim();
        if (!clean.startsWith("0x")) clean = "0x" + clean;
        String hex = clean.substring(2);
        if (hex.length() != 40 || !hex.matches("[0-9a-fA-F]+")) {
            throw new IllegalArgumentException("Invalid EVM " + label + " address");
        }
        return "0x" + hex;
    }

    private static String leftPad(String value, int width) {
        if (value.length() > width) throw new IllegalArgumentException("Encoded value is too large");
        StringBuilder out = new StringBuilder(width);
        for (int i = value.length(); i < width; i++) out.append('0');
        out.append(value);
        return out.toString();
    }
}
