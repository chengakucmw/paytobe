package ai.agentwallet.hd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

public final class TransferAssetRegistryTest {
    @Test
    public void registryHasThirtyAssetsWithXlmAndNoNearOrTron() {
        assertEquals(30, TransferAssetRegistry.ASSETS.size());
        assertNotNull(TransferAssetRegistry.find("stellar_xlm", "stellar_public", "XLM", 0));
        for (TransferAssetRegistry.Asset asset : TransferAssetRegistry.ASSETS) {
            String haystack = (asset.rail + " " + asset.network + " " + asset.symbol).toLowerCase();
            assertFalse(haystack.contains("near"));
            assertFalse(haystack.contains("tron"));
            assertFalse(haystack.contains("trx"));
            assertFalse(haystack.contains("trc20"));
            assertTrue(asset.signerImplemented);
        }
    }

    @Test
    public void unsupportedGuardBlocksTronAndNear() {
        assertTrue(TransferAssetRegistry.unsupportedReason(
                "tron_trx",
                "tron",
                "TRX",
                "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"
        ).contains("TRON"));
        assertTrue(TransferAssetRegistry.unsupportedReason(
                "near_native",
                "near",
                "NEAR",
                "alice.near"
        ).contains("NEAR"));
    }

    @Test
    public void paymentRequestInfersSolanaRailFromNetworkAndAsset() throws Exception {
        PaymentRequest request = PaymentRequest.parse(baseEnvelope()
                .put("payment", new JSONObject()
                        .put("network", "solana_mainnet")
                        .put("asset", "SOL")
                        .put("amount", "0.25")
                        .put("to", "11111111111111111111111111111111")
                        .put("decimals", 9)));

        assertEquals("solana_sol", request.rail);
        PaymentIntent intent = PaymentIntent.parse(request.toJson());
        assertTrue(intent.isSolanaSol());
        assertFalse(intent.requiresSignerAdapter());
    }

    @Test
    public void preparedPayloadAssetRequiresPayloadBeforeSigning() throws Exception {
        PaymentIntent intent = PaymentIntent.parse(baseEnvelope()
                .put("payment", new JSONObject()
                        .put("rail", "dogecoin_doge")
                        .put("network", "dogecoin_mainnet")
                        .put("asset", "DOGE")
                        .put("amount", "10.5")
                        .put("to", "D8BfE7n6R5m4K3j2H1g9F8e7D6c5B4a3Z")
                        .put("decimals", 8)));

        assertFalse(intent.requiresSignerAdapter());
        assertTrue(intent.requiresPreparedPayloadSigner());
        assertTrue(TransferAssetRegistry.validateIntent(intent).get(0).contains("prepared unsigned transaction payload"));

        PaymentIntent ready = PaymentIntent.parse(baseEnvelope()
                .put("request_id", "prq_registry_test_ready")
                .put("payment", new JSONObject()
                        .put("rail", "dogecoin_doge")
                        .put("network", "dogecoin_mainnet")
                        .put("asset", "DOGE")
                        .put("amount", "10.5")
                        .put("to", "D8BfE7n6R5m4K3j2H1g9F8e7D6c5B4a3Z")
                        .put("decimals", 8)
                        .put("signing_payload", "01020304")
                        .put("broadcast_url", "https://relay.example/dogecoin/submit")));
        assertTrue(TransferAssetRegistry.validateIntent(ready).isEmpty());
    }

    @Test
    public void allPreparedPayloadRailsAreClassifiedReviewOnly() {
        // Security regression guard for the blind-signing fix: every "prepared payload" asset must
        // stay classified so it routes to the review-only / blocked branch in RiskPolicy and
        // PaymentExecutor, never to a direct in-wallet signer. If any of these flips to
        // direct_broadcast, the wallet could blind-sign an opaque server payload again.
        String[] preparedRails = {
                "bitcoin_btc", "xrpl_xrp", "sui_sui", "aptos_apt", "ton_ton", "cardano_ada",
                "cosmos_atom", "polkadot_dot", "hedera_hbar", "starknet_strk", "algorand_algo",
                "tezos_xtz", "internet_computer_icp", "filecoin_fil", "litecoin_ltc",
                "bitcoin_cash_bch", "dogecoin_doge"
        };
        for (String rail : preparedRails) {
            TransferAssetRegistry.Asset asset = findByRail(rail);
            assertNotNull(rail + " must exist in the registry", asset);
            assertTrue(rail + " must be classified as prepared_payload (review-only)", asset.requiresPreparedPayload());
        }

        for (String rail : new String[] {"stellar_xlm", "solana_sol", "ethereum_eth", "base_usdc"}) {
            TransferAssetRegistry.Asset asset = findByRail(rail);
            assertNotNull(rail + " must exist in the registry", asset);
            assertFalse(rail + " must remain a direct in-wallet signer", asset.requiresPreparedPayload());
        }
    }

    private static TransferAssetRegistry.Asset findByRail(String rail) {
        for (TransferAssetRegistry.Asset asset : TransferAssetRegistry.ASSETS) {
            if (asset.rail.equals(rail)) return asset;
        }
        return null;
    }

    private static JSONObject baseEnvelope() throws Exception {
        return new JSONObject()
                .put("protocol", PaymentRequest.PROTOCOL_PAYMENT_REQUEST)
                .put("request_id", "prq_registry_test")
                .put("transaction_id", "txn_registry_test")
                .put("status", "pending")
                .put("created_at", "2026-06-17T00:00:00.000Z")
                .put("expires_at", "2026-06-17T00:05:00.000Z")
                .put("source", new JSONObject().put("agent_name", "RegistryTest"))
                .put("payee", new JSONObject().put("name", "Registry Test"))
                .put("risk", new JSONObject().put("signing_allowed", true));
    }
}
