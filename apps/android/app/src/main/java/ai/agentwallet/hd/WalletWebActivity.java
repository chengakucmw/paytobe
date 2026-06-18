package ai.agentwallet.hd;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.Executor;

/**
 * Hybrid host: renders the VelarumPay prototype (bundled in assets/web) inside a
 * WebView so the UI is pixel-identical to the design, and bridges real wallet
 * operations (balances, signing + mainnet broadcast, camera scan, wallet
 * lifecycle) to the existing native code. Private keys never leave native.
 */
public class WalletWebActivity extends FragmentActivity {
    private static final String START_URL = "file:///android_asset/web/index.html";
    private static final int REQUEST_SCAN = 7201;

    // Endpoints + Base USDC contract used to describe a local "Send" request. EVM
    // sends are signed against the shared, verified WalletNetworkStore RPCs by
    // PaymentExecutor, so only the non-EVM endpoints are pinned here.
    private static final String SOLANA_RPC = "https://api.mainnet-beta.solana.com";
    private static final String STELLAR_HORIZON = "https://horizon.stellar.org";
    private static final String BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

    private WebView webView;
    private HDWallet wallet;

    // L2: a scan result can arrive while the WebView is still (re)loading — e.g. the
    // OS destroys and recreates this Activity under memory pressure while the camera
    // Activity is in front. We hold the latest scan payload here and only hand it to
    // the page once its JS hook exists, and we persist it across recreation in
    // onSaveInstanceState so it is never dropped into a torn-down DOM.
    private static final String STATE_PENDING_SCAN = "pending_scan_payload";
    private String pendingScanPayload;
    private boolean webReady;

    @Override
    @SuppressWarnings("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (savedInstanceState != null) {
            pendingScanPayload = savedInstanceState.getString(STATE_PENDING_SCAN);
        }
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        // Keep the bridge-enabled WebView locked to our bundled local assets.
        // Any web link opens in the external browser, never inside this WebView.
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                android.net.Uri url = request == null ? null : request.getUrl();
                if (url != null && "file".equalsIgnoreCase(url.getScheme())) return false;
                if (url != null) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, url));
                    } catch (Exception ignored) {
                    }
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                // The prototype's JS (and its scan hook) is loaded now. Flush any scan
                // result that arrived while the page was still loading, or that was
                // queued before this Activity was recreated.
                webReady = true;
                flushPendingScan();
            }
        });
        webView.addJavascriptInterface(new NativeBridge(), "VPNative");
        webView.addJavascriptInterface(new ScanBridge(), "VelarumPayNativeScan");
        setContentView(webView);
        ensureWalletLoaded();
        webView.loadUrl(START_URL);
    }

    @Override
    public void onBackPressed() {
        // Let the prototype handle in-app back navigation first.
        webView.evaluateJavascript(
                "(window.VelarumPrototypeBack && window.VelarumPrototypeBack())?'1':'0'",
                value -> {
                    if (!"\"1\"".equals(value)) finish();
                });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_SCAN && resultCode == RESULT_OK && data != null) {
            String payload = data.getStringExtra(QrScannerActivity.EXTRA_PAYLOAD);
            if (payload != null && payload.trim().length() > 0) {
                // Don't deliver straight away: if this Activity was recreated while the
                // scanner was in front, the WebView may not have finished reloading.
                // Queue the result and let flushPendingScan() hand it over once ready.
                pendingScanPayload = payload.trim();
                flushPendingScan();
            }
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        // Survive process death / recreation so a scan captured just before the OS
        // reclaimed this Activity is re-delivered after the WebView reloads.
        if (pendingScanPayload != null) {
            outState.putString(STATE_PENDING_SCAN, pendingScanPayload);
        }
    }

    // ---------------- helpers ----------------
    private synchronized void ensureWalletLoaded() {
        if (wallet != null) return;
        try {
            if (!SecureWalletStore.hasWallet(this)) return;
            String saved = SecureWalletStore.load(this);
            if (saved != null) wallet = HDWallet.parse(saved);
        } catch (Exception ignored) {
        }
    }

    private void callJs(String js) {
        if (webView == null) return;
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    // Deliver a queued scan result to the page, but only once its JS hook actually
    // exists. If the page just reloaded, the hook may not be defined for a few more
    // milliseconds, so we re-check a bounded number of times. The payload stays
    // queued until delivery is confirmed, so it can never be lost into a DOM that an
    // Activity recreation reset.
    private void flushPendingScan() {
        if (pendingScanPayload == null || webView == null || !webReady) return;
        deliverScan(pendingScanPayload, 0);
    }

    private void deliverScan(final String payload, final int attempt) {
        if (webView == null) return;
        final String js = "(function(){try{"
                + "if(typeof window.VelarumPrototypeScanResult==='function'){"
                + "window.VelarumPrototypeScanResult(" + jsString(payload) + ");return '1';}"
                + "}catch(e){}return '0';})()";
        webView.post(() -> webView.evaluateJavascript(js, value -> {
            if ("\"1\"".equals(value)) {
                // Only clear if it is still the same payload we set out to deliver.
                if (payload.equals(pendingScanPayload)) pendingScanPayload = null;
            } else if (attempt < 20) {
                // Hook not ready yet; retry shortly (≈ up to 3s total) without blocking.
                webView.postDelayed(() -> deliverScan(payload, attempt + 1), 150);
            }
        }));
    }

    private static String jsString(String value) {
        String v = value == null ? "" : value;
        StringBuilder out = new StringBuilder("'");
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (c == '\\') out.append("\\\\");
            else if (c == '\'') out.append("\\'");
            else if (c == '\n') out.append("\\n");
            else if (c == '\r') out.append("\\r");
            else if (c == '\t') out.append("\\t");
            else if (c == '\u2028') out.append("\\u2028");
            else if (c == '\u2029') out.append("\\u2029");
            else out.append(c);
        }
        return out.append("'").toString();
    }

    private JSONObject walletStateJson() {
        JSONObject out = new JSONObject();
        try {
            out.put("hasWallet", SecureWalletStore.hasWallet(this));
            out.put("backupVerified", SecureWalletStore.isBackupVerified(this));
            ensureWalletLoaded();
            if (wallet != null) {
                JSONObject addr = new JSONObject();
                addr.put("evm", wallet.evm.address);
                addr.put("solana", wallet.solana.address);
                addr.put("stellar", wallet.stellar.address);
                out.put("addresses", addr);
                JSONObject identity = new JSONObject();
                identity.put("walletId", shorten(wallet.evm.address));
                identity.put("walletName", "My Wallet");
                identity.put("avatar", "V");
                out.put("identity", identity);
            }
            JSONObject cached = BalanceStore.cached(this);
            JSONObject assets = cached.optJSONObject("assets");
            out.put("balances", assets == null ? new JSONObject() : assets);
        } catch (Exception ignored) {
        }
        return out;
    }

    private static String shorten(String address) {
        if (address == null || address.length() <= 12) return address == null ? "" : address;
        return address.substring(0, 6) + "..." + address.substring(address.length() - 4);
    }

    private void authenticate(String title, Runnable onSuccess, Runnable onFailure) {
        int authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG
                | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        BiometricManager manager = BiometricManager.from(this);
        if (manager.canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS) {
            if (onFailure != null) onFailure.run();
            return;
        }
        Executor executor = ContextCompat.getMainExecutor(this);
        BiometricPrompt prompt = new BiometricPrompt(this, executor, new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                onSuccess.run();
            }

            @Override
            public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                if (onFailure != null) onFailure.run();
            }
        });
        prompt.authenticate(new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle("Confirm to sign locally and broadcast")
                .setAllowedAuthenticators(authenticators)
                .build());
    }

    /**
     * Describes a manual "Send" as a {@link PaymentIntent} so it can flow through the
     * same RiskPolicy + PaymentExecutor pipeline as an inbox payment request (bug M9).
     *
     * <p>The strict (symbol, network) allow-list is preserved: every branch requires
     * BOTH the asset and the exact network to match, and anything unrecognized throws.
     * This guarantees a transfer can never silently go out on the wrong chain (e.g. ETH
     * on an L2) or as the wrong asset (e.g. USDC -> native ETH). EVM chain ids let
     * PaymentExecutor resolve the verified RPC from WalletNetworkStore.
     */
    private PaymentIntent buildLocalSendIntent(String symbol, String network, String to, String amount) throws Exception {
        String sym = symbol == null ? "" : symbol.trim().toUpperCase(java.util.Locale.US);
        String net = network == null ? "" : network.trim().toLowerCase(java.util.Locale.US);

        JSONObject payment = new JSONObject();
        payment.put("amount", amount);
        payment.put("to", to);

        if (sym.equals("XLM") && net.contains("stellar")) {
            payment.put("rail", "stellar_xlm");
            payment.put("network", "stellar");
            payment.put("asset", "XLM");
            payment.put("horizon_url", STELLAR_HORIZON);
        } else if (sym.equals("SOL") && net.contains("solana")) {
            // Use the registry's canonical network id + decimals so the Solana branch of
            // RiskPolicy (which runs TransferAssetRegistry.validateIntent) accepts it.
            payment.put("rail", "solana_sol");
            payment.put("network", "solana_mainnet");
            payment.put("asset", "SOL");
            payment.put("decimals", 9);
            payment.put("rpc_url", SOLANA_RPC);
        } else if (sym.equals("USDC") && net.equals("base")) {
            payment.put("rail", "base_usdc");
            payment.put("network", "base_mainnet");
            payment.put("asset", "USDC");
            payment.put("chain_id", 8453L);
            payment.put("token_contract", BASE_USDC);
            payment.put("decimals", 6);
        } else if (sym.equals("ETH") && net.equals("base")) {
            evmNativePayment(payment, "base_mainnet", "ETH", 8453L);
        } else if (sym.equals("ETH") && net.equals("ethereum")) {
            evmNativePayment(payment, "ethereum", "ETH", 1L);
        } else if ((sym.equals("POL") || sym.equals("MATIC")) && (net.equals("polygon") || net.contains("polygon pos"))) {
            evmNativePayment(payment, "polygon", sym, 137L);
        } else {
            throw new IllegalStateException(
                    (symbol == null ? "" : symbol) + " on " + (network == null ? "" : network)
                            + " is not supported for sending in this build. Supported: XLM on Stellar, "
                            + "SOL on Solana, ETH on Ethereum or Base, USDC on Base, POL on Polygon.");
        }

        JSONObject root = new JSONObject();
        root.put("request_id", "local-send-" + System.currentTimeMillis());
        root.put("status", PaymentIntent.STATUS_PENDING);
        root.put("payment", payment);
        return PaymentIntent.parse(root);
    }

    private static void evmNativePayment(JSONObject payment, String network, String asset, long chainId) throws Exception {
        payment.put("rail", "evm_native");
        payment.put("network", network);
        payment.put("asset", asset);
        payment.put("chain_id", chainId);
    }

    private static String joinMessages(java.util.List<String> messages) {
        StringBuilder out = new StringBuilder();
        for (String message : messages) {
            if (message == null || message.length() == 0) continue;
            if (out.length() > 0) out.append("; ");
            out.append(message);
        }
        return out.length() == 0 ? "This payment can't be sent right now." : out.toString();
    }

    private void emitSendResult(boolean ok, String txHash, String error, boolean backupRequired) {
        try {
            JSONObject r = new JSONObject();
            r.put("ok", ok);
            if (txHash != null) r.put("txHash", txHash);
            if (error != null) r.put("error", error);
            if (backupRequired) r.put("backupRequired", true);
            callJs("window.__vpOnSendResult && window.__vpOnSendResult(" + r + ")");
        } catch (Exception ignored) {
        }
    }

    private static String message(Exception e) {
        return e == null || e.getMessage() == null ? "Unexpected error" : e.getMessage();
    }

    // ---------------- JS bridges ----------------
    private final class ScanBridge {
        @JavascriptInterface
        public void startScan(String mode) {
            runOnUiThread(() -> startActivityForResult(new Intent(WalletWebActivity.this, QrScannerActivity.class), REQUEST_SCAN));
        }
    }

    private final class NativeBridge {
        @JavascriptInterface
        public boolean hasWallet() {
            return SecureWalletStore.hasWallet(WalletWebActivity.this);
        }

        @JavascriptInterface
        public String walletData() {
            return walletStateJson().toString();
        }

        @JavascriptInterface
        public void refreshBalances() {
            ensureWalletLoaded();
            if (wallet == null) return;
            final HDWallet current = wallet;
            new Thread(() -> {
                try {
                    JSONObject balances = BalanceFetcher.fetch(current);
                    BalanceStore.save(WalletWebActivity.this, balances);
                } catch (Exception ignored) {
                }
                callJs("window.__vpOnData && window.__vpOnData(" + walletStateJson() + ")");
            }).start();
        }

        @JavascriptInterface
        public void createWallet() {
            new Thread(() -> {
                try {
                    HDWallet created = HDWallet.create();
                    SecureWalletStore.save(WalletWebActivity.this, created.serialize(), false);
                    synchronized (WalletWebActivity.this) {
                        wallet = created;
                    }
                    callJs("window.__vpOnWalletCreated && window.__vpOnWalletCreated()");
                } catch (Exception e) {
                    callJs("window.__vpOnError && window.__vpOnError(" + jsString(message(e)) + ")");
                }
            }).start();
        }

        @JavascriptInterface
        public void importWallet(String phrase) {
            new Thread(() -> {
                try {
                    HDWallet restored = HDWallet.restore(phrase == null ? "" : phrase.trim());
                    SecureWalletStore.save(WalletWebActivity.this, restored.serialize(), true);
                    synchronized (WalletWebActivity.this) {
                        wallet = restored;
                    }
                    callJs("window.__vpOnWalletImported && window.__vpOnWalletImported()");
                } catch (Exception e) {
                    callJs("window.__vpOnError && window.__vpOnError(" + jsString("Invalid recovery phrase. " + message(e)) + ")");
                }
            }).start();
        }

        @JavascriptInterface
        public String mnemonicWords() {
            ensureWalletLoaded();
            JSONArray array = new JSONArray();
            try {
                if (wallet != null) {
                    for (String word : HDWallet.mnemonicWords(wallet.mnemonic)) array.put(word);
                }
            } catch (Exception ignored) {
            }
            return array.toString();
        }

        @JavascriptInterface
        public void confirmBackup() {
            SecureWalletStore.markBackupVerified(WalletWebActivity.this);
            callJs("window.__vpOnBackupDone && window.__vpOnBackupDone()");
        }

        @JavascriptInterface
        public void send(String json) {
            final String symbol;
            final String network;
            final String to;
            final String amount;
            try {
                JSONObject d = new JSONObject(json == null ? "{}" : json);
                symbol = d.optString("symbol", "");
                network = d.optString("network", "");
                to = d.optString("to", "").trim();
                amount = d.optString("amount", "").trim();
            } catch (Exception e) {
                emitSendResult(false, null, "Invalid transfer request.", false);
                return;
            }
            ensureWalletLoaded();
            if (wallet == null) {
                emitSendResult(false, null, "No wallet loaded.", false);
                return;
            }
            if (!SecureWalletStore.isBackupVerified(WalletWebActivity.this)) {
                emitSendResult(false, null, "Back up your recovery phrase first.", true);
                return;
            }
            if (to.length() == 0 || amount.length() == 0) {
                emitSendResult(false, null, "Enter a recipient and amount.", false);
                return;
            }

            // M9: the WebView "Send" used to sign + broadcast on its own, skipping the
            // daily limit, recipient whitelist, expiry and address checks - and never
            // recording the spend against the daily ledger. Route it through the SAME
            // pipeline as the native inbox flow so both entry points share one
            // "validate -> authenticate -> sign -> record" path.
            final PaymentIntent intent;
            try {
                intent = buildLocalSendIntent(symbol, network, to, amount);
            } catch (Exception e) {
                emitSendResult(false, null, message(e), false);
                return;
            }
            RiskPolicy.Result risk = RiskPolicy.evaluate(WalletWebActivity.this, intent);
            if (!risk.allowed) {
                emitSendResult(false, null, joinMessages(risk.errors), false);
                return;
            }

            runOnUiThread(() -> authenticate(
                    "Send " + symbol,
                    () -> new Thread(() -> {
                        try {
                            // PaymentExecutor re-runs RiskPolicy before signing (defence in
                            // depth) and broadcasts via the verified per-chain transfer.
                            String tx = PaymentExecutor.execute(WalletWebActivity.this, wallet, intent);
                            RiskPolicy.recordSuccessfulPayment(WalletWebActivity.this, intent);
                            try {
                                TransactionHistoryStore.record(WalletWebActivity.this,
                                        tx != null && tx.length() > 0 ? "tx:" + tx : "local:" + System.currentTimeMillis(),
                                        "Send " + symbol, symbol, amount, network, to, "broadcasted", tx);
                            } catch (Exception ignored) {
                            }
                            emitSendResult(true, tx, null, false);
                            refreshBalances();
                        } catch (Exception e) {
                            emitSendResult(false, null, message(e), false);
                        }
                    }).start(),
                    () -> emitSendResult(false, null, "Authentication was cancelled.", false)));
        }

        @JavascriptInterface
        public void copy(String text) {
            runOnUiThread(() -> {
                try {
                    android.content.ClipboardManager cm = (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    if (cm != null) cm.setPrimaryClip(android.content.ClipData.newPlainText("VelarumPay", text == null ? "" : text));
                } catch (Exception ignored) {
                }
            });
        }

        // Synchronous clipboard read for the "Paste" button. The read runs on the UI
        // thread (which has a Looper) and the JS-bridge thread waits briefly for it,
        // so the recipient field can be filled from the device clipboard.
        @JavascriptInterface
        public String readClipboard() {
            final String[] out = { "" };
            final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
            runOnUiThread(() -> {
                try {
                    android.content.ClipboardManager cm = (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    if (cm != null && cm.hasPrimaryClip()) {
                        android.content.ClipData clip = cm.getPrimaryClip();
                        if (clip != null && clip.getItemCount() > 0) {
                            CharSequence text = clip.getItemAt(0).coerceToText(WalletWebActivity.this);
                            out[0] = text == null ? "" : text.toString();
                        }
                    }
                } catch (Exception ignored) {
                } finally {
                    latch.countDown();
                }
            });
            try {
                latch.await(1, java.util.concurrent.TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            return out[0];
        }
    }
}
