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

final class EvmTransfer {
    private static final String ERC20_TRANSFER_SELECTOR = "a9059cbb";
    private static final BigInteger ERC20_FALLBACK_GAS = BigInteger.valueOf(100_000);

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
        Web3j web3j = Web3j.build(new HttpService(rpcUrl));
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
        RawTransaction tx = RawTransaction.createEtherTransaction(nonce, gasPrice, gasLimit, toAddress, value);
        byte[] signed = TransactionEncoder.signMessage(tx, chainId, credentials);
        String raw = Numeric.toHexString(signed);
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
        Web3j web3j = Web3j.build(new HttpService(rpcUrl));
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

        RawTransaction tx = RawTransaction.createTransaction(
                nonce,
                gasPrice,
                gasLimit,
                contract,
                BigInteger.ZERO,
                data
        );
        byte[] signed = TransactionEncoder.signMessage(tx, chainId, credentials);
        String raw = Numeric.toHexString(signed);
        if (progress != null) progress.onGenerated("Signed ERC-20 transaction");
        EthSendTransaction sent = web3j.ethSendRawTransaction(raw).send();
        if (sent.hasError()) throw new IllegalStateException(sent.getError().getMessage());
        return sent.getTransactionHash();
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
        if (decimals < 0 || decimals > 255) throw new IllegalArgumentException("Token decimals must be between 0 and 255");
        BigDecimal value = new BigDecimal(amount.trim()).movePointRight(decimals);
        BigInteger units = value.toBigIntegerExact();
        if (units.signum() <= 0) throw new IllegalArgumentException("Token amount must be greater than zero");
        return units;
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
