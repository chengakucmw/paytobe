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

    // Mainnet endpoints + Base USDC contract (mirror BalanceFetcher).
    private static final String ETHEREUM_RPC = "https://ethereum-rpc.publicnode.com";
    private static final String BASE_RPC = "https://mainnet.base.org";
    private static final String POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";
    private static final String SOLANA_RPC = "https://api.mainnet-beta.solana.com";
    private static final String STELLAR_HORIZON = "https://horizon.stellar.org";
    private static final String BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

    private WebView webView;
    private HDWallet wallet;

    @Override
    @SuppressWarnings("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
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
                callJs("window.VelarumPrototypeScanResult(" + jsString(payload.trim()) + ")");
            }
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

    private String broadcast(String symbol, String network, String to, String amount) throws Exception {
        String sym = symbol == null ? "" : symbol.trim().toUpperCase(java.util.Locale.US);
        String net = network == null ? "" : network.trim().toLowerCase(java.util.Locale.US);
        // Strict (symbol, network) allow-list. Every branch requires BOTH the asset
        // and the exact network to match, and anything unrecognized throws. This
        // guarantees a transfer can never silently broadcast on the wrong chain
        // (e.g. ETH on an L2) or as the wrong asset (e.g. USDC -> native ETH).
        if (sym.equals("XLM") && net.contains("stellar")) {
            return StellarTransfer.sendXlm(STELLAR_HORIZON, false, wallet.stellar.privateSeed, wallet.stellar.publicKey, to, amount);
        }
        if (sym.equals("SOL") && net.contains("solana")) {
            return SolanaTransfer.sendSol(SOLANA_RPC, wallet.solana.privateSeed, wallet.solana.publicKey, to, amount);
        }
        if (sym.equals("USDC") && net.equals("base")) {
            return EvmTransfer.sendErc20(BASE_RPC, 8453L, wallet.evm.privateKey, BASE_USDC, to, amount, 6);
        }
        if (sym.equals("ETH") && net.equals("base")) {
            return EvmTransfer.sendNative(BASE_RPC, 8453L, wallet.evm.privateKey, to, amount);
        }
        if (sym.equals("ETH") && net.equals("ethereum")) {
            return EvmTransfer.sendNative(ETHEREUM_RPC, 1L, wallet.evm.privateKey, to, amount);
        }
        if ((sym.equals("POL") || sym.equals("MATIC")) && (net.equals("polygon") || net.contains("polygon pos"))) {
            return EvmTransfer.sendNative(POLYGON_RPC, 137L, wallet.evm.privateKey, to, amount);
        }
        throw new IllegalStateException(
                (symbol == null ? "" : symbol) + " on " + (network == null ? "" : network)
                        + " is not supported for sending in this build. Supported: XLM on Stellar, "
                        + "SOL on Solana, ETH on Ethereum or Base, USDC on Base, POL on Polygon.");
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
            runOnUiThread(() -> authenticate(
                    "Send " + symbol,
                    () -> new Thread(() -> {
                        try {
                            String tx = broadcast(symbol, network, to, amount);
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
