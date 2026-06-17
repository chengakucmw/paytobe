package ai.agentwallet.hd;

import android.Manifest;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import org.json.JSONObject;

import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.ConcurrentHashMap;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

public class MainActivity extends FragmentActivity {
    static final String EXTRA_OPEN_PAYMENT_INTENT_ID = "ai.agentwallet.hd.OPEN_PAYMENT_INTENT_ID";
    private static final int REQUEST_NOTIFICATIONS = 4101;
    private static final int REQUEST_SCAN = 4102;
    private static final String TAB_WALLET = "wallet";
    private static final String TAB_MESSAGES = "messages";
    private static final String TAB_HISTORY = "history";
    private static final String TAB_SETTINGS = "settings";
    private static final int BG = Color.rgb(232, 240, 233);
    private static final int SURFACE = Color.WHITE;
    private static final int SOFT = Color.rgb(238, 245, 239);
    private static final int SUNKEN = Color.rgb(242, 247, 243);
    private static final int LINE = Color.rgb(226, 233, 228);
    private static final int LINE_STRONG = Color.rgb(205, 214, 207);
    private static final int INK = Color.rgb(22, 32, 26);
    private static final int INK_SOFT = Color.rgb(46, 58, 51);
    private static final int MUTED = Color.rgb(91, 106, 96);
    private static final int FADED = Color.rgb(126, 140, 131);
    private static final int GREEN = Color.rgb(62, 123, 79);
    private static final int GREEN_DARK = Color.rgb(44, 87, 57);
    private static final int GREEN_SOFT = Color.rgb(224, 237, 227);
    private static final int GOLD = Color.rgb(191, 169, 78);
    private static final int BLUE = Color.rgb(61, 122, 168);
    private static final int BLUE_SOFT = Color.rgb(227, 238, 245);
    private static final int RED = Color.rgb(178, 58, 51);
    private static final int RED_SOFT = Color.rgb(248, 230, 227);
    private static final int AMBER_SOFT = Color.rgb(244, 239, 216);
    private static final int DARK = Color.rgb(14, 20, 17);
    private static final String ENCRYPTED_LOCAL_KEYRING = "Encrypted local keyring";
    private static final int CHAIN_ETH = Color.rgb(98, 126, 234);
    private static final int CHAIN_SOL = Color.rgb(20, 241, 149);
    private static final int CHAIN_STELLAR = Color.rgb(27, 31, 42);
    private static final int CHAIN_BASE = Color.rgb(0, 82, 255);
    private static final int CHAIN_POLYGON = Color.rgb(130, 71, 229);
    private static final OkHttpClient IMAGE_HTTP = new OkHttpClient();

    private LinearLayout content;
    private TextView status;
    private TextView headerTitle;
    private TextView headerSubtitle;
    private View headerDetailGap;
    private View headerSubtitleGap;
    private Button tabWallet;
    private Button tabMessages;
    private Button tabHistory;
    private Button tabSettings;
    private AlertDialog activeSheet;
    private String activeTab = TAB_WALLET;
    private String inboxFilter = PaymentInboxFilter.FILTER_PENDING;
    private boolean balanceRefreshInFlight;
    private HDWallet wallet;
    private RelayClient relayClient;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Map<String, Bitmap> imageCache = new ConcurrentHashMap<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            getWindow().setNavigationBarDividerColor(LINE);
        }
        setContentView(screen());
        PaymentNotifications.ensureChannels(this);
        requestNotificationPermissionIfNeeded();
        updateStatus();
        autoLoadSavedWallet();
        startRelayPushService();
        syncInboxSilently();
        handleAppIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleAppIntent(intent);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_SCAN && resultCode == RESULT_OK && data != null) {
            handleScannedPayload(data.getStringExtra(QrScannerActivity.EXTRA_PAYLOAD));
        }
    }

    private View screen() {
        LinearLayout root = vertical();
        root.setBackgroundColor(BG);

        LinearLayout header = vertical();
        header.setPadding(dp(20), statusBarHeight() + dp(12), dp(20), dp(14));
        LinearLayout top = row();
        LinearLayout brand = vertical();
        brand.addView(text("AgentWallet", 18, INK, true));
        brand.addView(text("Local signing wallet", 12, MUTED, false));
        top.addView(brand, new LinearLayout.LayoutParams(0, -2, 1));
        LinearLayout headerActions = row();
        status = pill("", GREEN, GREEN_SOFT, Color.TRANSPARENT);
        status.setTextSize(11);
        headerActions.addView(status);
        Button scan = compactButton("Scan", this::openScanner);
        LinearLayout.LayoutParams scanLp = new LinearLayout.LayoutParams(-2, dp(34));
        scanLp.leftMargin = dp(8);
        headerActions.addView(scan, scanLp);
        top.addView(headerActions);
        header.addView(top);
        root.addView(header);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(false);
        content = vertical();
        content.setPadding(dp(20), 0, dp(20), dp(22));
        scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        root.addView(bottomTabs());
        renderActiveTab();
        updateTabButtons();
        return root;
    }

    private void autoLoadSavedWallet() {
        if (!SecureWalletStore.hasWallet(this) || wallet != null) return;
        try {
            String saved = SecureWalletStore.load(this);
            if (saved == null) return;
            wallet = HDWallet.parse(saved);
            renderPublicWallet();
            updateStatus();
            refreshBalances();
        } catch (Exception e) {
            toast("Saved wallet could not be loaded");
        }
    }

    private View bottomTabs() {
        LinearLayout shell = vertical();
        shell.setPadding(dp(12), dp(8), dp(12), dp(12));
        shell.setBackgroundColor(BG);
        LinearLayout tabs = row();
        tabs.setPadding(dp(4), dp(4), dp(4), dp(4));
        tabs.setBackground(round(SURFACE, dp(26), LINE, 1));
        tabWallet = tabButton("Wallet", () -> switchTab(TAB_WALLET));
        tabMessages = tabButton("Inbox", () -> switchTab(TAB_MESSAGES));
        tabHistory = tabButton("History", () -> switchTab(TAB_HISTORY));
        tabSettings = tabButton("Settings", () -> switchTab(TAB_SETTINGS));
        tabs.addView(tabWallet, new LinearLayout.LayoutParams(0, dp(48), 1));
        tabs.addView(tabMessages, new LinearLayout.LayoutParams(0, dp(48), 1));
        tabs.addView(tabHistory, new LinearLayout.LayoutParams(0, dp(48), 1));
        tabs.addView(tabSettings, new LinearLayout.LayoutParams(0, dp(48), 1));
        shell.addView(tabs);
        return shell;
    }

    private Button tabButton(String label, Runnable action) {
        Button b = button(label, MUTED, Color.TRANSPARENT, Color.TRANSPARENT, action);
        b.setTextSize(12);
        return b;
    }

    private void switchTab(String tab) {
        activeTab = tab;
        renderActiveTab();
        updateTabButtons();
    }

    private void renderActiveTab() {
        if (content == null) return;
        updateHeader();
        if (TAB_MESSAGES.equals(activeTab)) {
            renderMessagesTab();
        } else if (TAB_HISTORY.equals(activeTab)) {
            renderHistoryTab();
        } else if (TAB_SETTINGS.equals(activeTab)) {
            renderSettingsTab();
        } else {
            renderWalletTab();
        }
    }

    private void updateTabButtons() {
        setTabSelected(tabWallet, TAB_WALLET.equals(activeTab));
        setTabSelected(tabMessages, TAB_MESSAGES.equals(activeTab));
        setTabSelected(tabHistory, TAB_HISTORY.equals(activeTab));
        setTabSelected(tabSettings, TAB_SETTINGS.equals(activeTab));
    }

    private void setTabSelected(Button tab, boolean selected) {
        if (tab == null) return;
        tab.setTextColor(selected ? Color.WHITE : MUTED);
        tab.setTypeface(Typeface.DEFAULT, selected ? Typeface.BOLD : Typeface.NORMAL);
        tab.setBackground(round(selected ? GREEN : Color.TRANSPARENT, dp(22), selected ? GREEN : Color.TRANSPARENT, selected ? 1 : 0));
    }

    private void updateHeader() {
        if (headerTitle == null || headerSubtitle == null) return;
        boolean walletTab = TAB_WALLET.equals(activeTab);
        int walletVisibility = walletTab ? View.GONE : View.VISIBLE;
        if (headerDetailGap != null) headerDetailGap.setVisibility(walletVisibility);
        if (headerSubtitleGap != null) headerSubtitleGap.setVisibility(walletVisibility);
        headerTitle.setVisibility(walletVisibility);
        headerSubtitle.setVisibility(walletVisibility);
        if (walletTab) return;
        headerTitle.setText(headerTitleFor(activeTab));
        headerSubtitle.setText(headerSubtitleFor(activeTab));
    }

    private String headerTitleFor(String tab) {
        if (TAB_MESSAGES.equals(tab)) return "Inbox";
        if (TAB_HISTORY.equals(tab)) return "History";
        if (TAB_SETTINGS.equals(tab)) return "Settings";
        return "Wallet";
    }

    private String headerSubtitleFor(String tab) {
        if (TAB_MESSAGES.equals(tab)) return "Review agent payment requests before anything is signed.";
        if (TAB_HISTORY.equals(tab)) return "Broadcasted and confirmed transfers from this device.";
        if (TAB_SETTINGS.equals(tab)) return "Wallet recovery, relay connection, and demo controls.";
        return "Multi-chain balances, local signing, and receive addresses.";
    }

    private void renderWalletTab() {
        content.removeAllViews();
        if (wallet == null) {
            content.addView(walletSetupCard());
            return;
        }
        content.addView(portfolioCard());
        addGap(content, 14);
        content.addView(walletQuickActionsCard());
        addGap(content, 14);
        content.addView(receiveAddressesCard());
        addGap(content, 14);
        content.addView(warning("This app signs transactions locally. Always test with testnets first. Mainnet transactions move real funds and cannot be reversed."));
        addGap(content, 14);
        content.addView(transferLauncherCard());
    }

    private void renderMessagesTab() {
        content.removeAllViews();
        content.addView(paymentInboxCard());
    }

    private void renderHistoryTab() {
        content.removeAllViews();
        LinearLayout card = card();
        card.setPadding(dp(20), dp(20), dp(20), dp(20));
        card.setBackground(round(SURFACE, dp(24), LINE, 1));
        card.addView(pill("Ledger", BLUE, BLUE_SOFT, Color.TRANSPARENT));
        addGap(card, 12);
        card.addView(text("History", 28, INK, true));
        addGap(card, 6);
        card.addView(text("Local record of amount changes broadcast or confirmed from this phone.", 14, MUTED, false));
        addGap(card, 14);
        boolean hasItems = false;
        try {
            for (JSONObject item : TransactionHistoryStore.list(this)) {
                hasItems = true;
                card.addView(historyRow(
                        item.optString("title", "Transfer"),
                        item.optString("amount", ""),
                        item.optString("asset", ""),
                        item.optString("network", ""),
                        item.optString("to", ""),
                        item.optString("status", ""),
                        item.optString("tx_hash", ""),
                        item.optLong("created_at_ms", 0L)
                ));
                addGap(card, 10);
            }
            for (PaymentIntent intent : PaymentInboxStore.list(this)) {
                if (!isAmountHistoryStatus(intent.status)) continue;
                hasItems = true;
                card.addView(historyRow(
                        intent.title(),
                        intent.amount,
                        intent.asset,
                        intent.network,
                        intent.to,
                        intent.status,
                        intent.txHash,
                        intent.createdAt
                ));
                addGap(card, 10);
            }
        } catch (Exception e) {
            card.addView(warning("History read failed: " + e.getMessage()));
            hasItems = true;
        }
        if (!hasItems) {
            card.addView(warning("No amount changes yet. Pay an Inbox request or use Advanced send to create history."));
        }
        content.addView(card);
    }

    private View historyRow(String title, String amount, String asset, String network, String to, String statusValue, String txHash, long timestampMs) {
        LinearLayout row = vertical();
        row.setPadding(dp(14), dp(14), dp(14), dp(14));
        row.setBackground(round(SOFT, dp(18), LINE, 1));
        LinearLayout top = row();
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.addView(text(title == null || title.length() == 0 ? "Transfer" : title, 16, INK, true), new LinearLayout.LayoutParams(0, -2, 1));
        String amountLine = amount == null || amount.length() == 0 ? "" : "-" + amount + (asset == null || asset.length() == 0 ? "" : " " + asset);
        if (amountLine.length() > 0) top.addView(text(amountLine, 14, GREEN_DARK, true));
        row.addView(top);
        addGap(row, 6);
        row.addView(pill((network == null ? "" : network) + " / " + (statusValue == null ? "" : statusValue), statusColor(statusValue), SURFACE, Color.TRANSPARENT));
        addGap(row, 8);
        row.addView(text(formatTimestamp(timestampMs), 12, MUTED, false));
        if (to != null && to.length() > 0) row.addView(text("To " + shortAddress(to), 12, MUTED, false));
        if (txHash != null && txHash.length() > 0) {
            row.addView(text("Tx " + shortAddress(txHash), 12, BLUE, true));
            row.setOnClickListener(v -> copy("Transaction hash", txHash));
        }
        return row;
    }

    private boolean isAmountHistoryStatus(String statusValue) {
        return PaymentIntent.STATUS_BROADCASTED.equals(statusValue)
                || PaymentIntent.STATUS_CONFIRMED.equals(statusValue);
    }

    private String formatTimestamp(long timestampMs) {
        if (timestampMs <= 0L) return "Unknown time";
        return new java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault()).format(new java.util.Date(timestampMs));
    }

    private void renderSettingsTab() {
        content.removeAllViews();
        LinearLayout card = card();
        card.addView(sectionEyebrow("Control center"));
        addGap(card, 8);
        card.addView(text("Settings", 26, INK, true));
        addGap(card, 6);
        card.addView(text("Wallet recovery, relay connection, and local security controls.", 14, MUTED, false));
        addGap(card, 12);
        LinearLayout r1 = row();
        r1.addView(primaryButton("Generate", this::generateWallet), weight());
        r1.addView(outlineButton("Load", this::loadWallet), weightLeft());
        card.addView(r1);
        addGap(card, 10);
        LinearLayout r2 = row();
        r2.addView(primaryButton("Back Up Wallet", this::backupWalletSheet), weight());
        r2.addView(outlineButton("Restore", this::restoreSheet), weightLeft());
        card.addView(r2);
        addGap(card, 10);
        card.addView(dangerButton("Clear Saved Wallet", this::clearWallet), new LinearLayout.LayoutParams(-1, dp(48)));
        content.addView(card);
        addGap(content, 14);
        content.addView(relayConnectionCard());
        addGap(content, 14);
        content.addView(agentConnectionsCard());
    }

    private View relayConnectionCard() {
        LinearLayout card = card();
        card.addView(sectionEyebrow("Agent relay"));
        addGap(card, 8);
        card.addView(text("Connection", 24, INK, true));
        addGap(card, 6);
        card.addView(text("Relay, device, and demo binding details for Telegram payment requests.", 14, MUTED, false));
        addGap(card, 12);
        card.addView(field("Relay URL", PaymentInboxStore.relayUrl(this), false));
        card.addView(field("Device ID", PaymentInboxStore.deviceId(this), true));
        String demoSessionId = PaymentInboxStore.demoSessionId(this);
        if (demoSessionId.length() > 0) card.addView(field("Demo Session", demoSessionId, true));
        String telegramBot = PaymentInboxStore.telegramBot(this);
        if (telegramBot.length() > 0) card.addView(field("Telegram Bot", telegramBot, false));
        addGap(card, 12);
        LinearLayout actions = row();
        actions.addView(outlineButton("Relay Settings", this::relaySettingsSheet), weight());
        actions.addView(outlineButton("Connect Push", this::connectRelay), weightLeft());
        card.addView(actions);
        addGap(card, 10);
        card.addView(outlineButton("Sync Inbox", this::syncInbox), new LinearLayout.LayoutParams(-1, dp(48)));
        return card;
    }

    private View agentConnectionsCard() {
        LinearLayout card = card();
        card.addView(sectionEyebrow("Agent pairing"));
        addGap(card, 8);
        card.addView(text("Connected agents", 24, INK, true));
        addGap(card, 6);
        card.addView(text("Pair local agents, review requested scopes, and revoke access. Pairing never grants signing permission.", 14, MUTED, false));
        addGap(card, 12);
        LinearLayout actions = row();
        actions.addView(primaryButton("Enter Code", this::connectAgentSheet), weight());
        actions.addView(outlineButton("Scan QR", this::openScanner), weightLeft());
        card.addView(actions);
        addGap(card, 10);
        card.addView(outlineButton("Sync Connections", this::syncConnections), new LinearLayout.LayoutParams(-1, dp(48)));
        List<AgentConnection> connections = AgentConnectionStore.list(this);
        addGap(card, 14);
        if (connections.isEmpty()) {
            card.addView(warning("No agents connected. Scan a pairing QR or enter the short code shown by a trusted local agent."));
        } else {
            for (AgentConnection connection : connections) {
                addGap(card, 10);
                card.addView(agentConnectionRow(connection));
            }
        }
        return card;
    }

    private View agentConnectionRow(AgentConnection connection) {
        LinearLayout row = vertical();
        row.setPadding(dp(14), dp(14), dp(14), dp(14));
        row.setBackground(round(SOFT, dp(18), LINE, 1));
        LinearLayout top = row();
        top.addView(text(connection.displayName(), 17, INK, true), new LinearLayout.LayoutParams(0, -2, 1));
        top.addView(pill(connection.status, statusColor(connection.status), SURFACE, Color.TRANSPARENT));
        row.addView(top);
        addGap(row, 6);
        row.addView(text(joinDisplay(connection.runtime, connection.deviceLabel), 12, MUTED, false));
        addGap(row, 6);
        row.addView(text(connection.scopeSummary(), 12, INK_SOFT, false));
        row.setOnClickListener(v -> agentConnectionDetailSheet(connection));
        return row;
    }

    private View walletSetupCard() {
        LinearLayout card = card();
        card.addView(pill("Local only", GREEN, GREEN_SOFT, Color.TRANSPARENT));
        addGap(card, 12);
        card.addView(text("Set Up Wallet", 30, INK, true));
        addGap(card, 6);
        card.addView(text("Create, load, or restore a wallet before receiving and signing payments.", 15, MUTED, false));
        addGap(card, 16);
        LinearLayout r1 = row();
        r1.addView(primaryButton("Generate", this::generateWallet), weight());
        r1.addView(outlineButton("Load", this::loadWallet), weightLeft());
        card.addView(r1);
        addGap(card, 12);
        card.addView(outlineButton("Restore Wallet", this::restoreSheet), new LinearLayout.LayoutParams(-1, dp(48)));
        addGap(card, 14);
        card.addView(warning("Your receive addresses appear here after a wallet is loaded."));
        return card;
    }

    private void generateWallet() {
        try {
            wallet = HDWallet.create();
            SecureWalletStore.save(this, wallet.serialize());
            renderPublicWallet();
            updateStatus();
            refreshBalances();
            toast("HD wallet generated and encrypted locally");
        } catch (Exception e) {
            error("Generate failed", e);
        }
    }

    private void loadWallet() {
        try {
            String saved = SecureWalletStore.load(this);
            if (saved == null) {
                toast("No saved wallet");
                return;
            }
            wallet = HDWallet.parse(saved);
            renderPublicWallet();
            updateStatus();
            refreshBalances();
            toast("Wallet loaded");
        } catch (Exception e) {
            error("Load failed", e);
        }
    }

    private void restoreSheet() {
        LinearLayout body = sheetBase("Restore Wallet");
        EditText input = input("Enter BIP39 mnemonic");
        input.setMinLines(3);
        input.setSingleLine(false);
        body.addView(input);
        addGap(body, 12);
        body.addView(primaryButton("Restore", () -> {
            try {
                wallet = HDWallet.restore(input.getText().toString());
                SecureWalletStore.save(this, wallet.serialize());
                renderPublicWallet();
                updateStatus();
                refreshBalances();
                toast("Wallet restored");
            } catch (Exception e) {
                error("Restore failed", e);
            }
        }));
        showSheet(body);
    }

    private void clearWallet() {
        SecureWalletStore.clear(this);
        BalanceStore.clear(this);
        wallet = null;
        renderActiveTab();
        updateStatus();
        toast("Saved wallet cleared");
    }

    private void revealSecrets() {
        backupWalletSheet();
    }

    private void renderPublicWallet() {
        activeTab = TAB_WALLET;
        renderActiveTab();
        updateTabButtons();
    }

    private View publicCard() {
        LinearLayout card = card();
        card.addView(text("Derived accounts", 19, INK, true));
        addGap(card, 10);
        card.addView(field("Mnemonic type", "BIP39 English - 12 words", false));
        card.addView(field("EVM path", wallet.evm.path, false));
        card.addView(field("EVM address", wallet.evm.address, true));
        card.addView(field("EVM networks", "Ethereum, Base, Polygon, and EVM-compatible chains", false));
        card.addView(field("Solana path", wallet.solana.path, false));
        card.addView(field("Solana address", wallet.solana.address, true));
        card.addView(field("Stellar path", wallet.stellar.path, false));
        card.addView(field("Stellar address", wallet.stellar.address, true));
        return card;
    }

    private View portfolioCard() {
        JSONObject balances = BalanceStore.cached(this);
        LinearLayout card = card();
        card.setPadding(dp(20), dp(20), dp(20), dp(20));
        card.setBackground(round(GREEN_DARK, dp(24), GREEN_DARK, 0));
        card.addView(pill("Encrypted on this device", GREEN_DARK, GREEN_SOFT, Color.TRANSPARENT));
        addGap(card, 14);
        card.addView(text("Wallet Accounts", 30, Color.WHITE, true));
        addGap(card, 6);
        card.addView(text("Balances refresh from public endpoints. Tap an asset row to view its receive QR and address details.", 14, GREEN_SOFT, false));
        addGap(card, 12);
        card.addView(text("Last refresh: " + BalanceStore.updatedAt(balances), 12, Color.rgb(196, 221, 202), false));
        addGap(card, 14);
        card.addView(assetBalanceRow("XLM", "Stellar", "xlm", wallet.stellar.address, balances));
        addGap(card, 10);
        card.addView(assetBalanceRow("SOL", "Solana", "sol", wallet.solana.address, balances));
        addGap(card, 10);
        card.addView(assetBalanceRow("ETH", "Ethereum", "eth", wallet.evm.address, balances));
        addGap(card, 10);
        card.addView(assetBalanceRow("ETH", "Base", "base_eth", wallet.evm.address, balances));
        addGap(card, 10);
        card.addView(assetBalanceRow("MATIC", "Polygon", "polygon_matic", wallet.evm.address, balances));
        addGap(card, 10);
        card.addView(assetBalanceRow("USDC", "Base", "base_usdc", wallet.evm.address, balances));
        addGap(card, 16);
        card.addView(goldButton(balanceRefreshInFlight ? "Refreshing..." : "Refresh Balances", this::refreshBalances), new LinearLayout.LayoutParams(-1, dp(50)));
        return card;
    }

    private View assetBalanceRow(String symbol, String network, String key, String address, JSONObject balances) {
        JSONObject asset = BalanceStore.asset(balances, key);
        String balance = asset.optString("balance", "Not refreshed");
        String status = asset.optString("status", "idle");
        String error = asset.optString("error", "");
        String line = "error".equals(status)
                ? "Refresh failed"
                : ("inactive".equals(status) ? "Inactive account" : balance + " " + symbol);

        LinearLayout box = vertical();
        box.setPadding(dp(12), dp(12), dp(12), dp(12));
        box.setBackground(round(SURFACE, dp(18), Color.TRANSPARENT, 0));

        LinearLayout top = row();
        top.addView(tokenGlyph(symbol, key), new LinearLayout.LayoutParams(dp(42), dp(42)));
        LinearLayout names = vertical();
        names.addView(text(symbol + " on " + network, 16, INK, true));
        names.addView(text(shortAddress(address), 12, MUTED, false));
        LinearLayout.LayoutParams namesLp = new LinearLayout.LayoutParams(0, -2, 1);
        namesLp.leftMargin = dp(12);
        top.addView(names, namesLp);

        LinearLayout amount = vertical();
        amount.setGravity(Gravity.RIGHT | Gravity.CENTER_VERTICAL);
        amount.addView(text(line, 14, statusColor(status), true));
        amount.addView(text("Details", 11, FADED, true));
        top.addView(amount);
        box.addView(top);
        if ("inactive".equals(status)) {
            addGap(box, 8);
            box.addView(text("Send at least 1 XLM to activate this Stellar account.", 12, MUTED, false));
        }
        if (error.length() > 0) {
            addGap(box, 8);
            box.addView(text(error, 12, RED, false));
        }
        box.setOnClickListener(v -> assetReceiveDetailSheet(symbol, network, key, address, line));
        return box;
    }

    private void assetReceiveDetailSheet(String symbol, String network, String key, String address, String balanceLine) {
        LinearLayout body = sheetBase(symbol + " Receive");
        body.addView(pill(network, chainColor(key), SOFT, Color.TRANSPARENT));
        addGap(body, 12);
        body.addView(qrImage(address));
        addGap(body, 14);
        body.addView(field("Asset", symbol, false));
        body.addView(field("Network", network, false));
        body.addView(field("Current balance", balanceLine, false));
        body.addView(field("Receive address", address, true));
        body.addView(warning(receiveWarning(symbol, network)));
        addGap(body, 12);
        body.addView(primaryButton("Copy Address", () -> copy(symbol + " address", address)), new LinearLayout.LayoutParams(-1, dp(48)));
        showSheet(body);
    }

    private String receiveWarning(String symbol, String network) {
        if ("Stellar".equalsIgnoreCase(network)) return "Use this address for XLM on Stellar. Stellar accounts must be funded before they are active.";
        if ("Solana".equalsIgnoreCase(network)) return "Use this address for SOL and SPL tokens only.";
        if ("Base".equalsIgnoreCase(network)) return "Use the Base network for Base assets. Do not send the same token over another network unless it is supported.";
        if ("Polygon".equalsIgnoreCase(network)) return "Use the Polygon network for Polygon assets only.";
        return "Deposit only on the matching network. Wrong-network deposits can permanently lose funds.";
    }

    private View walletQuickActionsCard() {
        LinearLayout card = card();
        card.addView(sectionEyebrow("Quick actions"));
        addGap(card, 12);
        LinearLayout top = row();
        top.addView(quickActionButton("Receive", this::receiveAddressesSheet), weight());
        top.addView(quickActionButton("Inbox", this::messageCenter), weightLeft());
        card.addView(top);
        addGap(card, 10);
        LinearLayout bottom = row();
        bottom.addView(quickActionButton("Backup", this::backupWalletSheet), weight());
        bottom.addView(quickActionButton("Refresh", this::refreshBalances), weightLeft());
        card.addView(bottom);
        return card;
    }

    private void refreshBalances() {
        if (!requireWallet() || balanceRefreshInFlight) return;
        balanceRefreshInFlight = true;
        if (TAB_WALLET.equals(activeTab)) renderWalletTab();
        toast("Refreshing balances");
        new Thread(() -> {
            try {
                JSONObject balances = BalanceFetcher.fetch(wallet);
                BalanceStore.save(this, balances);
                runOnUiThread(() -> {
                    balanceRefreshInFlight = false;
                    if (TAB_WALLET.equals(activeTab)) renderWalletTab();
                    toast("Balances refreshed");
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    balanceRefreshInFlight = false;
                    if (TAB_WALLET.equals(activeTab)) renderWalletTab();
                    error("Balance refresh failed", e);
                });
            }
        }).start();
    }

    private View receiveAddressesCard() {
        LinearLayout card = card();
        card.setPadding(dp(20), dp(20), dp(20), dp(20));
        card.setBackground(round(SURFACE, dp(24), LINE, 1));
        card.addView(pill("Multi-chain receive", BLUE, BLUE_SOFT, Color.TRANSPARENT));
        addGap(card, 12);
        card.addView(text("Receive Addresses", 26, INK, true));
        addGap(card, 6);
        card.addView(text("Use these addresses to deposit assets into this wallet. Each network has its own receiving rules.", 14, MUTED, false));
        addGap(card, 14);
        card.addView(field("Ethereum / Base / Polygon", wallet.evm.address, true));
        card.addView(text("Use this EVM address for ETH, Base, Polygon, and ERC-20 tokens on those networks.", 12, MUTED, false));
        addGap(card, 10);
        card.addView(field("Solana", wallet.solana.address, true));
        card.addView(text("Use this address for SOL and SPL tokens only.", 12, MUTED, false));
        addGap(card, 10);
        card.addView(field("Stellar", wallet.stellar.address, true));
        card.addView(text("Use this address for XLM. Stellar accounts must be funded before they are active.", 12, MUTED, false));
        addGap(card, 16);
        card.addView(primaryButton("Open Receive Details", this::receiveAddressesSheet), new LinearLayout.LayoutParams(-1, dp(50)));
        return card;
    }

    private void receiveAddressesSheet() {
        if (!requireWallet()) return;
        LinearLayout body = sheetBase("Receive");
        body.addView(text("Deposit only on the matching network. Sending assets to the wrong address type can permanently lose funds.", 13, MUTED, false));
        addGap(body, 10);
        body.addView(field("Ethereum address", wallet.evm.address, true));
        body.addView(field("Base address", wallet.evm.address, true));
        body.addView(field("Polygon address", wallet.evm.address, true));
        body.addView(warning("Ethereum, Base, and Polygon use the same EVM address format, but assets must be sent on the intended network."));
        body.addView(field("Solana address", wallet.solana.address, true));
        body.addView(warning("Use Solana only for SOL and SPL tokens."));
        body.addView(field("Stellar address", wallet.stellar.address, true));
        body.addView(warning("Stellar requires the account to be activated with XLM before it can receive normal payments."));
        addGap(body, 12);
        body.addView(primaryButton("Done", this::closeActiveSheet));
        showSheet(body);
    }

    private View transferLauncherCard() {
        LinearLayout card = card();
        card.addView(sectionEyebrow("Advanced send"));
        addGap(card, 8);
        card.addView(text("Real network transfer", 22, INK, true));
        addGap(card, 8);
        card.addView(text("These screens sign locally and broadcast to the RPC/Horizon endpoint you provide.", 13, MUTED, false));
        addGap(card, 14);
        card.addView(primaryButton("Send EVM Native Asset", this::evmTransferSheet));
        addGap(card, 10);
        card.addView(primaryButton("Send ERC-20 Token", this::evmTokenTransferSheet));
        addGap(card, 10);
        card.addView(primaryButton("Send SOL", this::solanaTransferSheet));
        addGap(card, 10);
        card.addView(primaryButton("Send SPL Token", this::splTokenTransferSheet));
        addGap(card, 10);
        card.addView(primaryButton("Send XLM", this::stellarTransferSheet));
        return card;
    }

    private void backupWalletSheet() {
        if (!requireWallet()) return;
        LinearLayout body = sheetBase("Back Up Wallet");
        body.addView(text("The recovery phrase restores the whole wallet. The individual private keys are advanced backups for specific chains.", 13, MUTED, false));
        addGap(body, 10);
        body.addView(warning("Anyone with this backup can move your funds. Store it offline and never paste it into chat, email, cloud notes, or screenshots."));
        addGap(body, 10);
        CheckBox privatePlace = checkbox("I am in a private place and can write this backup offline.", false);
        CheckBox understand = checkbox("I understand that losing this backup can permanently lose the wallet.", false);
        body.addView(privatePlace);
        body.addView(understand);
        addGap(body, 12);
        body.addView(primaryButton("Show Backup", () -> {
            if (!privatePlace.isChecked() || !understand.isChecked()) {
                toast("Confirm backup safety first");
                return;
            }
            authenticate("Back up wallet", "Confirm before showing recovery secrets.", this::backupSecretsSheet);
        }));
        showSheet(body);
    }

    private void backupSecretsSheet() {
        LinearLayout body = sheetBase("Wallet Backup");
        body.addView(warning("Write the recovery phrase offline. Do not share any value on this screen."));
        body.addView(field("Recovery phrase", wallet.mnemonic, true));
        body.addView(field("EVM private key", "0x" + Hex.bytesToHex(wallet.evm.privateKey), true));
        body.addView(field("Solana private seed", Hex.bytesToHex(wallet.solana.privateSeed), true));
        body.addView(field("Solana secret key base58", Base58.encode(Base58.concat(wallet.solana.privateSeed, wallet.solana.publicKey)), true));
        body.addView(field("Stellar secret seed", StellarStrKey.encodeSeed(wallet.stellar.privateSeed), true));
        addGap(body, 12);
        body.addView(primaryButton("Done", this::closeActiveSheet));
        showSheet(body);
    }

    private void renderSecrets() {
        content.removeAllViews();
        content.addView(warning("Secrets are visible. Do not screenshot, paste into chat, or share this screen."));
        addGap(content, 12);
        LinearLayout card = card();
        card.addView(text("Revealed secrets", 19, INK, true));
        card.addView(field("Mnemonic", wallet.mnemonic, true));
        card.addView(field("EVM private key", "0x" + Hex.bytesToHex(wallet.evm.privateKey), true));
        card.addView(field("Solana private seed", Hex.bytesToHex(wallet.solana.privateSeed), true));
        card.addView(field("Solana secret key base58", Base58.encode(Base58.concat(wallet.solana.privateSeed, wallet.solana.publicKey)), true));
        card.addView(field("Stellar secret seed", StellarStrKey.encodeSeed(wallet.stellar.privateSeed), true));
        content.addView(card);
        addGap(content, 12);
        content.addView(receiveAddressesCard());
        addGap(content, 12);
        content.addView(paymentInboxCard());
        addGap(content, 12);
        content.addView(transferLauncherCard());
    }

    private void evmTransferSheet() {
        evmTransferSheet("", "", "", "");
    }

    private void evmTransferSheet(String rpcValue, String chainValue, String toValue, String amountValue) {
        if (!requireWallet()) return;
        LinearLayout body = sheetBase("Send EVM Native Asset");
        EditText rpc = input("RPC URL, e.g. https://sepolia.infura.io/v3/...");
        EditText chain = input("Chain ID, e.g. 11155111, 8453, 137");
        EditText to = input("Recipient 0x address");
        EditText amount = input("Amount in native unit, e.g. 0.001");
        setIfPresent(rpc, rpcValue);
        setIfPresent(chain, chainValue);
        setIfPresent(to, toValue);
        setIfPresent(amount, amountValue);
        body.addView(rpc);
        body.addView(chain);
        body.addView(to);
        body.addView(amount);
        body.addView(warning("This sends native ETH/MATIC/etc. Use testnet first."));
        body.addView(primaryButton("Sign and Broadcast", () -> authenticate("Send EVM transaction", "Confirm local signing and broadcast.", () -> {
            runAsync("EVM transfer", "Native", "EVM " + chain.getText().toString().trim(), amount.getText().toString().trim(), to.getText().toString().trim(), () -> EvmTransfer.sendNative(
                    rpc.getText().toString().trim(),
                    Long.parseLong(chain.getText().toString().trim()),
                    wallet.evm.privateKey,
                    to.getText().toString().trim(),
                    amount.getText().toString().trim()
            ));
        })));
        showSheet(body);
    }

    private void evmTokenTransferSheet() {
        evmTokenTransferSheet("", "", "", "", "", "");
    }

    private void evmTokenTransferSheet(String rpcValue, String chainValue, String tokenValue, String toValue, String amountValue, String decimalsValue) {
        if (!requireWallet()) return;
        LinearLayout body = sheetBase("Send ERC-20 Token");
        EditText rpc = input("RPC URL, e.g. https://sepolia.infura.io/v3/...");
        EditText chain = input("Chain ID, e.g. 11155111, 8453, 137");
        EditText token = input("ERC-20 contract 0x address");
        EditText to = input("Recipient 0x address");
        EditText amount = input("Token amount, e.g. 12.5");
        EditText decimals = input("Token decimals, e.g. 6 or 18");
        setIfPresent(rpc, rpcValue);
        setIfPresent(chain, chainValue);
        setIfPresent(token, tokenValue);
        setIfPresent(to, toValue);
        setIfPresent(amount, amountValue);
        setIfPresent(decimals, decimalsValue);
        body.addView(rpc);
        body.addView(chain);
        body.addView(token);
        body.addView(to);
        body.addView(amount);
        body.addView(decimals);
        body.addView(warning("This signs transfer(address,uint256). Verify the token contract and decimals before broadcasting."));
        body.addView(primaryButton("Sign and Broadcast", () -> authenticate("Send ERC-20 token", "Confirm local token signing and broadcast.", () -> {
            runAsync("ERC-20 transfer", "Token", "EVM " + chain.getText().toString().trim(), amount.getText().toString().trim(), to.getText().toString().trim(), () -> EvmTransfer.sendErc20(
                    rpc.getText().toString().trim(),
                    Long.parseLong(chain.getText().toString().trim()),
                    wallet.evm.privateKey,
                    token.getText().toString().trim(),
                    to.getText().toString().trim(),
                    amount.getText().toString().trim(),
                    Integer.parseInt(decimals.getText().toString().trim())
            ));
        })));
        showSheet(body);
    }

    private void solanaTransferSheet() {
        solanaTransferSheet("", "", "");
    }

    private void solanaTransferSheet(String rpcValue, String toValue, String amountValue) {
        if (!requireWallet()) return;
        LinearLayout body = sheetBase("Send SOL");
        EditText rpc = input("RPC URL, e.g. https://api.devnet.solana.com");
        EditText to = input("Recipient Solana address");
        EditText amount = input("Amount in SOL, e.g. 0.001");
        setIfPresent(rpc, rpcValue);
        setIfPresent(to, toValue);
        setIfPresent(amount, amountValue);
        body.addView(rpc);
        body.addView(to);
        body.addView(amount);
        body.addView(warning("This signs a System Program SOL transfer and broadcasts it."));
        body.addView(primaryButton("Sign and Broadcast", () -> authenticate("Send SOL", "Confirm local signing and broadcast.", () -> {
            runAsync("Solana transfer", "SOL", "Solana", amount.getText().toString().trim(), to.getText().toString().trim(), () -> SolanaTransfer.sendSol(
                    rpc.getText().toString().trim(),
                    wallet.solana.privateSeed,
                    wallet.solana.publicKey,
                    to.getText().toString().trim(),
                    amount.getText().toString().trim()
            ));
        })));
        showSheet(body);
    }

    private void splTokenTransferSheet() {
        splTokenTransferSheet("", "", "", "", "");
    }

    private void splTokenTransferSheet(String rpcValue, String mintValue, String toValue, String amountValue, String decimalsValue) {
        if (!requireWallet()) return;
        LinearLayout body = sheetBase("Send SPL Token");
        EditText rpc = input("RPC URL, e.g. https://api.devnet.solana.com");
        EditText mint = input("SPL token mint address");
        EditText to = input("Recipient Solana wallet address");
        EditText amount = input("Token amount, e.g. 3.25");
        EditText decimals = input("Token decimals, e.g. 6 or 9");
        CheckBox createAta = checkbox("Create recipient associated token account if needed", true);
        setIfPresent(rpc, rpcValue);
        setIfPresent(mint, mintValue);
        setIfPresent(to, toValue);
        setIfPresent(amount, amountValue);
        setIfPresent(decimals, decimalsValue);
        body.addView(rpc);
        body.addView(mint);
        body.addView(to);
        body.addView(amount);
        body.addView(decimals);
        body.addView(createAta);
        body.addView(warning("This uses the classic SPL Token Program and signs a TransferChecked instruction."));
        body.addView(primaryButton("Sign and Broadcast", () -> authenticate("Send SPL token", "Confirm local token signing and broadcast.", () -> {
            runAsync("SPL token transfer", "SPL", "Solana", amount.getText().toString().trim(), to.getText().toString().trim(), () -> SolanaTransfer.sendSplToken(
                    rpc.getText().toString().trim(),
                    wallet.solana.privateSeed,
                    wallet.solana.publicKey,
                    mint.getText().toString().trim(),
                    to.getText().toString().trim(),
                    amount.getText().toString().trim(),
                    Integer.parseInt(decimals.getText().toString().trim()),
                    createAta.isChecked()
            ));
        })));
        showSheet(body);
    }

    private void stellarTransferSheet() {
        stellarTransferSheet("https://horizon.stellar.org", "public", "", "");
    }

    private void stellarTransferSheet(String horizonValue, String networkValue, String toValue, String amountValue) {
        if (!requireWallet()) return;
        LinearLayout body = sheetBase("Send XLM");
        EditText horizon = input("Horizon URL, e.g. https://horizon-testnet.stellar.org");
        EditText network = input("Network: testnet or public");
        EditText to = input("Recipient Stellar G... address");
        EditText amount = input("Amount in XLM, e.g. 1.5");
        setIfPresent(horizon, horizonValue);
        setIfPresent(network, networkValue);
        setIfPresent(to, toValue);
        setIfPresent(amount, amountValue);
        body.addView(horizon);
        body.addView(network);
        body.addView(to);
        body.addView(amount);
        body.addView(warning("The app checks the recipient before broadcasting. If the recipient is not activated, eligible XLM sends use Stellar Create Account."));
        body.addView(primaryButton("Sign and Broadcast", () -> authenticate("Send XLM", "Confirm local signing and Horizon submission.", () -> {
            runAsync("Stellar transfer", "XLM", network.getText().toString().trim().toLowerCase().contains("test") ? "stellar_testnet" : "stellar_public", amount.getText().toString().trim(), to.getText().toString().trim(), () -> StellarTransfer.sendXlm(
                    horizon.getText().toString().trim(),
                    network.getText().toString().trim().toLowerCase().contains("test"),
                    wallet.stellar.privateSeed,
                    wallet.stellar.publicKey,
                    to.getText().toString().trim(),
                    amount.getText().toString().trim()
            ));
        })));
        showSheet(body);
    }

    private void relaySettingsSheet() {
        LinearLayout body = sheetBase("Relay Settings");
        EditText relay = input("Relay URL, e.g. http://192.168.1.10:8787");
        relay.setText(PaymentInboxStore.relayUrl(this));
        body.addView(field("App device id", PaymentInboxStore.deviceId(this), true));
        body.addView(field("App device token", PaymentInboxStore.deviceToken(this), true));
        body.addView(relay);
        body.addView(warning("Use the HTTPS tunnel URL for a real phone. Android emulator can use http://10.0.2.2:8787."));
        body.addView(primaryButton("Save and Register", () -> {
            saveRelayUrlAndRegister(relay.getText().toString().trim());
        }));
        showSheet(body);
    }

    private void connectAgentSheet() {
        LinearLayout body = sheetBase("Connect Agent");
        EditText input = input("Pairing short code or velarumpay://pair URI");
        body.addView(input);
        body.addView(warning("Review the agent identity and requested scopes before approval. Pairing is not payment approval and never grants signing permission."));
        addGap(body, 12);
        body.addView(primaryButton("Review Pairing", () -> {
            PairingLink link = parsePairingLink(input.getText().toString());
            if (link == null) {
                error("Pairing failed", new IllegalArgumentException("Enter a 6-digit short code or velarumpay://pair URI."));
                return;
            }
            loadPairingSession(link);
        }), new LinearLayout.LayoutParams(-1, dp(48)));
        addGap(body, 10);
        body.addView(outlineButton("Scan QR", () -> {
            closeActiveSheet();
            openScanner();
        }), new LinearLayout.LayoutParams(-1, dp(48)));
        showSheet(body);
    }

    private void handleAppIntent(Intent intent) {
        if (intent == null) return;
        if (intent.getData() != null) {
            if (handleRelayConfigUri(intent.getData())) return;
            PairingLink link = parsePairingLink(intent.getData().toString());
            if (link != null) {
                loadPairingSession(link);
                return;
            }
        }
        String paymentIntentId = intent.getStringExtra(EXTRA_OPEN_PAYMENT_INTENT_ID);
        if (paymentIntentId != null && paymentIntentId.trim().length() > 0) {
            openPaymentIntentFromNotification(paymentIntentId.trim());
        }
    }

    private void openPaymentIntentFromNotification(String intentId) {
        closeActiveSheet();
        activeTab = TAB_MESSAGES;
        renderActiveTab();
        updateTabButtons();
        try {
            PaymentIntent local = PaymentInboxStore.find(this, intentId);
            if (local != null) {
                paymentDetailsSheet(local);
                return;
            }
        } catch (Exception ignored) {
        }
        toast("Opening payment request");
        new Thread(() -> {
            try {
                PaymentIntent remote = RelayClient.fetchIntent(this, intentId);
                PaymentInboxStore.upsert(this, remote);
                runOnUiThread(() -> {
                    activeTab = TAB_MESSAGES;
                    renderActiveTab();
                    updateTabButtons();
                    paymentDetailsSheet(remote);
                });
            } catch (Exception e) {
                runOnUiThread(() -> error("Open payment failed", e));
            }
        }).start();
    }

    private boolean handleRelayConfigUri(Uri data) {
        if (data == null) return false;
        if (!"agentwallet".equalsIgnoreCase(data.getScheme())) return false;
        String host = data.getHost();
        if (!"relay".equalsIgnoreCase(host)
                && !"configure-relay".equalsIgnoreCase(host)
                && !"setup".equalsIgnoreCase(host)) return false;
        String relayUrl = data.getQueryParameter("url");
        if (relayUrl == null || relayUrl.trim().length() == 0) {
            error("Relay setup link failed", new IllegalArgumentException("Missing url parameter"));
            return true;
        }
        relayUrl = relayUrl.trim();
        if (!relayUrl.startsWith("https://") && !relayUrl.startsWith("http://")) {
            error("Relay setup link failed", new IllegalArgumentException("Relay URL must start with http:// or https://"));
            return true;
        }
        String finalRelayUrl = relayUrl;
        if ("setup".equalsIgnoreCase(host)) {
            String bot = data.getQueryParameter("bot");
            String label = data.getQueryParameter("label");
            if (bot == null || bot.trim().length() == 0) bot = "Macmini1boybot";
            if (label == null || label.trim().length() == 0) label = "AgentFood Demo";
            String finalBot = bot.trim().replaceFirst("^@", "");
            String finalLabel = label.trim();
            new AlertDialog.Builder(this)
                    .setTitle("Start AgentFood Demo")
                    .setMessage("This will create or load a wallet, connect Relay, and create a Telegram demo session.")
                    .setNegativeButton("Cancel", null)
                    .setPositiveButton("Start Demo", (dialog, which) -> startDemoSetup(finalRelayUrl, finalBot, finalLabel))
                    .show();
            return true;
        }
        new AlertDialog.Builder(this)
                .setTitle("Configure Relay URL")
                .setMessage("Set AgentWallet Relay URL to:\n\n" + finalRelayUrl)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Save and Register", (dialog, which) -> saveRelayUrlAndRegister(finalRelayUrl))
                .show();
        return true;
    }

    private void openScanner() {
        startActivityForResult(new Intent(this, QrScannerActivity.class), REQUEST_SCAN);
    }

    private void handleScannedPayload(String payload) {
        String raw = payload == null ? "" : payload.trim();
        if (raw.length() == 0) {
            toast("No QR data found");
            return;
        }
        Uri uri = Uri.parse(raw);
        if (handleRelayConfigUri(uri)) return;
        PairingLink pairingLink = parsePairingLink(raw);
        if (pairingLink != null) {
            loadPairingSession(pairingLink);
            return;
        }
        if (isVelarumSetupUrl(uri)) {
            String query = uri.getEncodedQuery();
            Uri deep = Uri.parse("agentwallet://setup" + (query == null || query.length() == 0 ? "" : "?" + query));
            handleRelayConfigUri(deep);
            return;
        }
        ScannedPayment payment = parseScannedPayment(raw);
        if (payment.to.length() > 0) {
            scannedPaymentSheet(payment, raw);
            return;
        }
        scannedTextSheet(raw);
    }

    private boolean isVelarumSetupUrl(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        String host = uri.getHost();
        String path = uri.getPath();
        return ("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme))
                && "agentfood.velarumai.com".equalsIgnoreCase(host)
                && "/setup".equalsIgnoreCase(path);
    }

    private PairingLink parsePairingLink(String raw) {
        String clean = raw == null ? "" : raw.trim();
        if (clean.matches("^[0-9]{6}$")) return new PairingLink(clean, clean, "Short code");
        Uri uri;
        try {
            uri = Uri.parse(clean);
        } catch (Exception e) {
            return null;
        }
        String scheme = uri.getScheme();
        if (!"velarumpay".equalsIgnoreCase(scheme)) return null;
        String host = uri.getHost();
        String path = uri.getPath();
        if (!"pair".equalsIgnoreCase(host) && !"/pair".equalsIgnoreCase(path)) return null;
        String session = firstNonEmpty(param(uri, clean, "session"), param(uri, clean, "pairing_session_id"));
        String code = firstNonEmpty(param(uri, clean, "code"), param(uri, clean, "pairing_code"));
        String idOrCode = firstNonEmpty(session, code);
        if (idOrCode.length() == 0) return null;
        return new PairingLink(idOrCode, code, session.length() > 0 ? "QR URI" : "Short code");
    }

    private void loadPairingSession(PairingLink link) {
        toast("Loading pairing request");
        new Thread(() -> {
            try {
                PairingSession session = RelayClient.fetchPairingSession(this, link.idOrCode, link.code);
                runOnUiThread(() -> pairingReviewSheet(session, link.sourceLabel));
            } catch (Exception e) {
                runOnUiThread(() -> error("Pairing failed", e));
            }
        }).start();
    }

    private void pairingReviewSheet(PairingSession session, String sourceLabel) {
        LinearLayout body = sheetBase("Review Agent");
        body.addView(pill(session.status, session.isPending() ? GOLD : statusColor(session.status), SURFACE, Color.TRANSPARENT));
        addGap(body, 10);
        body.addView(field("Agent", session.displayName(), false));
        body.addView(field("Runtime", session.runtime, false));
        if (session.deviceLabel.length() > 0) body.addView(field("Device label", session.deviceLabel, false));
        if (session.source.length() > 0) body.addView(field("Source", session.source, false));
        body.addView(field("Pairing source", sourceLabel, false));
        body.addView(field("Expires at", session.expiresAt, false));
        addGap(body, 12);
        body.addView(sectionEyebrow("Requested scopes"));
        addGap(body, 8);
        List<CheckBox> boxes = new ArrayList<>();
        List<String> scopes = new ArrayList<>();
        for (String scope : session.requestedScopes) {
            if (isSigningScope(scope)) continue;
            CheckBox box = checkbox(scopeLabel(scope), true);
            boxes.add(box);
            scopes.add(scope);
            body.addView(box);
        }
        body.addView(warning("Pairing lets this agent prepare Payment Requests or read its own request status only. It cannot sign, spend automatically, read your recovery phrase, or approve payments."));
        addGap(body, 12);
        if (!session.isPending()) {
            body.addView(warning("This pairing session is " + session.status + " and cannot be approved."));
        } else {
            LinearLayout actions = row();
            actions.addView(dangerButton("Reject", () -> rejectPairing(session)), weight());
            actions.addView(primaryButton("Approve Selected", () -> {
                List<String> approved = new ArrayList<>();
                for (int i = 0; i < boxes.size(); i++) {
                    if (boxes.get(i).isChecked()) approved.add(scopes.get(i));
                }
                if (approved.isEmpty()) {
                    error("Pairing failed", new IllegalArgumentException("Approve at least one requested non-signing scope, or reject the pairing request."));
                    return;
                }
                approvePairing(session, approved);
            }), weightLeft());
            body.addView(actions);
        }
        showSheet(body);
    }

    private void approvePairing(PairingSession session, List<String> approvedScopes) {
        toast("Approving agent");
        new Thread(() -> {
            try {
                AgentConnection connection = RelayClient.approvePairing(this, session, approvedScopes);
                runOnUiThread(() -> {
                    activeTab = TAB_SETTINGS;
                    renderActiveTab();
                    updateTabButtons();
                    pairingApprovedSheet(connection);
                });
            } catch (Exception e) {
                runOnUiThread(() -> error("Approve failed", e));
            }
        }).start();
    }

    private void rejectPairing(PairingSession session) {
        toast("Rejecting pairing");
        new Thread(() -> {
            try {
                RelayClient.rejectPairing(this, session);
                runOnUiThread(() -> {
                    closeActiveSheet();
                    toast("Pairing rejected");
                });
            } catch (Exception e) {
                runOnUiThread(() -> error("Reject failed", e));
            }
        }).start();
    }

    private void pairingApprovedSheet(AgentConnection connection) {
        LinearLayout body = sheetBase("Agent Connected");
        body.addView(field("Agent", connection.displayName(), false));
        body.addView(field("Connection", connection.connectionId, true));
        body.addView(field("Approved scopes", connection.scopeSummary(), false));
        body.addView(warning("Every payment still requires user review and local signing on this device. The connection token is stored but never shown here."));
        addGap(body, 12);
        body.addView(primaryButton("View Connection", () -> agentConnectionDetailSheet(connection)), new LinearLayout.LayoutParams(-1, dp(48)));
        showSheet(body);
    }

    private void syncConnections() {
        toast("Syncing connections");
        new Thread(() -> {
            try {
                RelayClient.syncConnections(this);
                runOnUiThread(() -> {
                    renderActiveTab();
                    toast("Connections synced");
                });
            } catch (Exception e) {
                runOnUiThread(() -> error("Connection sync failed", e));
            }
        }).start();
    }

    private void agentConnectionDetailSheet(AgentConnection connection) {
        AgentConnection current = AgentConnectionStore.find(this, connection.connectionId);
        if (current == null) current = connection;
        LinearLayout body = sheetBase(current.displayName());
        body.addView(pill(current.status, statusColor(current.status), SURFACE, Color.TRANSPARENT));
        addGap(body, 10);
        body.addView(field("Connection ID", current.connectionId, true));
        body.addView(field("Runtime", current.runtime, false));
        if (current.deviceLabel.length() > 0) body.addView(field("Device label", current.deviceLabel, false));
        if (current.source.length() > 0) body.addView(field("Source", current.source, false));
        body.addView(field("Approved scopes", current.scopeSummary(), false));
        body.addView(field("Last activity", valueOr(current.lastActivityAt, "No activity yet"), false));
        body.addView(field("Expires at", current.expiresAt, false));
        body.addView(field("Token status", "Stored locally / hidden", false));
        body.addView(warning("Signing permission is not available for agent connections. Revoked or paused connections cannot create new standard requests."));
        addGap(body, 12);
        if (!current.isRevoked()) {
            LinearLayout actions = row();
            String nextStatus = "paused".equalsIgnoreCase(current.status) ? "active" : "paused";
            String label = "paused".equalsIgnoreCase(current.status) ? "Resume Agent" : "Pause Agent";
            AgentConnection actionConnection = current;
            actions.addView(outlineButton(label, () -> updateAgentConnectionStatus(actionConnection, nextStatus)), weight());
            actions.addView(dangerButton("Revoke", () -> confirmRevokeAgent(actionConnection)), weightLeft());
            body.addView(actions);
        }
        showSheet(body);
    }

    private void updateAgentConnectionStatus(AgentConnection connection, String status) {
        toast(("active".equals(status) ? "Resuming" : "Pausing") + " agent");
        new Thread(() -> {
            try {
                AgentConnection updated = RelayClient.updateConnectionStatus(this, connection, status);
                runOnUiThread(() -> {
                    renderActiveTab();
                    agentConnectionDetailSheet(updated);
                });
            } catch (Exception e) {
                runOnUiThread(() -> error("Connection update failed", e));
            }
        }).start();
    }

    private void confirmRevokeAgent(AgentConnection connection) {
        new AlertDialog.Builder(this)
                .setTitle("Revoke connection")
                .setMessage("This will revoke " + connection.displayName() + ". The agent will no longer be authorized to create standard requests with this token.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Revoke", (dialog, which) -> revokeAgentConnection(connection))
                .show();
    }

    private void revokeAgentConnection(AgentConnection connection) {
        toast("Revoking agent");
        new Thread(() -> {
            try {
                AgentConnection updated = RelayClient.revokeConnection(this, connection);
                runOnUiThread(() -> {
                    renderActiveTab();
                    agentConnectionDetailSheet(updated);
                });
            } catch (Exception e) {
                try {
                    AgentConnectionStore.updateStatus(this, connection.connectionId, "revoked");
                } catch (Exception ignored) {
                }
                runOnUiThread(() -> error("Remote revoke failed", e));
            }
        }).start();
    }

    private boolean isSigningScope(String scope) {
        String value = scope == null ? "" : scope.toLowerCase();
        return value.contains("sign") || value.contains("seed") || value.contains("private") || value.contains("keys");
    }

    private String scopeLabel(String scope) {
        if ("payment.requests.create".equals(scope)) return "Create Payment Requests / payment.requests.create";
        if ("payment.requests.read".equals(scope)) return "Read own request status / payment.requests.read";
        if ("transaction_contexts.create".equals(scope)) return "Create Transaction Context / transaction_contexts.create";
        if ("transaction_contexts.read".equals(scope)) return "Read own Transaction Context / transaction_contexts.read";
        if ("wallet.addresses.read".equals(scope)) return "Read approved address metadata / wallet.addresses.read";
        return scope;
    }

    private void scannedTextSheet(String raw) {
        LinearLayout body = sheetBase("Scanned QR");
        body.addView(field("QR content", raw, true));
        addGap(body, 12);
        if (raw.startsWith("https://") || raw.startsWith("http://")) {
            body.addView(primaryButton("Open Link", () -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(raw)));
                } catch (Exception e) {
                    error("Open link failed", e);
                }
            }), new LinearLayout.LayoutParams(-1, dp(48)));
        } else {
            body.addView(warning("This QR code was scanned, but it is not a supported setup or transfer format."));
        }
        showSheet(body);
    }

    private void scannedPaymentSheet(ScannedPayment payment, String raw) {
        LinearLayout body = sheetBase("Scanned Transfer");
        body.addView(field("Recipient", payment.to, true));
        if (payment.amount.length() > 0) body.addView(field("Amount", payment.amount, false));
        if (payment.asset.length() > 0) body.addView(field("Asset", payment.asset, false));
        if (payment.network.length() > 0) body.addView(field("Network", payment.network, false));
        body.addView(field("QR content", raw, true));
        addGap(body, 12);
        if (payment.isStellar()) {
            if ("XLM".equalsIgnoreCase(payment.asset)) {
                body.addView(primaryButton("Send XLM", () -> stellarTransferSheet(
                        payment.horizonUrl.length() > 0 ? payment.horizonUrl : "https://horizon.stellar.org",
                        payment.stellarTestnet ? "testnet" : "public",
                        payment.to,
                        payment.amount
                )), new LinearLayout.LayoutParams(-1, dp(48)));
            } else {
                body.addView(warning("This QR requests a Stellar non-XLM asset. The recipient account must already exist and have a matching trustline; this app version only broadcasts Stellar XLM."));
            }
        } else if (payment.isEvm()) {
            body.addView(primaryButton("Send Native Asset", () -> evmTransferSheet(
                    payment.rpcUrl,
                    payment.chainId,
                    payment.to,
                    payment.amount
            )), new LinearLayout.LayoutParams(-1, dp(48)));
            if (payment.tokenContract.length() > 0) {
                addGap(body, 10);
                body.addView(outlineButton("Send Token", () -> evmTokenTransferSheet(
                        payment.rpcUrl,
                        payment.chainId,
                        payment.tokenContract,
                        payment.to,
                        payment.amount,
                        payment.decimals
                )), new LinearLayout.LayoutParams(-1, dp(48)));
            }
        } else if (payment.isSolana()) {
            body.addView(primaryButton(payment.tokenContract.length() > 0 ? "Send SPL Token" : "Send SOL", () -> {
                if (payment.tokenContract.length() > 0) {
                    splTokenTransferSheet(payment.rpcUrl, payment.tokenContract, payment.to, payment.amount, payment.decimals);
                } else {
                    solanaTransferSheet(payment.rpcUrl, payment.to, payment.amount);
                }
            }), new LinearLayout.LayoutParams(-1, dp(48)));
        } else {
            body.addView(warning("Choose the matching send screen for this scanned address before broadcasting."));
        }
        showSheet(body);
    }

    private ScannedPayment parseScannedPayment(String raw) {
        ScannedPayment out = new ScannedPayment();
        String lower = raw.toLowerCase();
        Uri uri = Uri.parse(raw);
        out.to = firstNonEmpty(param(uri, raw, "to"), param(uri, raw, "address"), param(uri, raw, "recipient"), param(uri, raw, "destination"));
        out.amount = firstNonEmpty(param(uri, raw, "amount"), param(uri, raw, "value_decimal"));
        out.asset = firstNonEmpty(param(uri, raw, "asset"), param(uri, raw, "token"), param(uri, raw, "symbol"));
        out.network = firstNonEmpty(param(uri, raw, "network"), param(uri, raw, "chain"));
        out.chainId = firstNonEmpty(param(uri, raw, "chain_id"), param(uri, raw, "chainId"));
        out.rpcUrl = firstNonEmpty(param(uri, raw, "rpc_url"), param(uri, raw, "rpc"));
        out.horizonUrl = firstNonEmpty(param(uri, raw, "horizon_url"), param(uri, raw, "horizon"));
        out.tokenContract = firstNonEmpty(param(uri, raw, "token_contract"), param(uri, raw, "contract"), param(uri, raw, "mint"), param(uri, raw, "spl-token"));
        out.assetIssuer = firstNonEmpty(param(uri, raw, "asset_issuer"), param(uri, raw, "issuer"), param(uri, raw, "token_issuer"));
        out.decimals = firstNonEmpty(param(uri, raw, "decimals"), "USDC".equalsIgnoreCase(out.asset) ? "6" : "");

        if (lower.startsWith("web+stellar:pay") || lower.startsWith("stellar:pay")) {
            out.network = firstNonEmpty(out.network, "stellar");
            out.asset = firstNonEmpty(out.asset, "XLM");
            out.to = firstNonEmpty(out.to, paramFromRaw(raw, "destination"));
            out.amount = firstNonEmpty(out.amount, paramFromRaw(raw, "amount"));
            out.stellarTestnet = "testnet".equalsIgnoreCase(paramFromRaw(raw, "network"));
        } else if (lower.startsWith("stellar:")) {
            out.network = firstNonEmpty(out.network, "stellar");
            out.asset = firstNonEmpty(out.asset, "XLM");
            out.to = firstNonEmpty(out.to, uriBody(raw, "stellar:"));
        } else if (lower.startsWith("ethereum:")) {
            out.network = firstNonEmpty(out.network, "evm");
            out.to = firstNonEmpty(out.to, evmAddressFromEthereumUri(raw));
            out.chainId = firstNonEmpty(out.chainId, evmChainFromEthereumUri(raw));
        } else if (lower.startsWith("solana:")) {
            out.network = firstNonEmpty(out.network, "solana");
            out.asset = firstNonEmpty(out.asset, out.tokenContract.length() > 0 ? "SPL" : "SOL");
            out.to = firstNonEmpty(out.to, uriBody(raw, "solana:"));
        }

        if (out.to.length() == 0 && raw.matches("^0x[0-9a-fA-F]{40}$")) {
            out.to = raw;
            out.network = "evm";
        } else if (out.to.length() == 0 && raw.matches("^G[A-Z2-7]{55}$")) {
            out.to = raw;
            out.network = "stellar";
            out.asset = "XLM";
        } else if (out.to.length() == 0 && raw.matches("^[1-9A-HJ-NP-Za-km-z]{32,44}$")) {
            out.to = raw;
            out.network = "solana";
            out.asset = "SOL";
        }

        if (out.chainId.length() == 0 && out.network.toLowerCase().contains("base")) out.chainId = "8453";
        if (out.asset.length() == 0 && out.network.toLowerCase().contains("stellar")) out.asset = "XLM";
        if (out.asset.length() == 0 && out.network.toLowerCase().contains("solana")) out.asset = "SOL";
        return out;
    }

    private String evmAddressFromEthereumUri(String raw) {
        String body = uriBody(raw, "ethereum:");
        if (body.startsWith("pay-")) body = body.substring(4);
        int at = body.indexOf('@');
        if (at >= 0) body = body.substring(0, at);
        if (body.matches("^0x[0-9a-fA-F]{40}$")) return body;
        return "";
    }

    private String evmChainFromEthereumUri(String raw) {
        String body = uriBody(raw, "ethereum:");
        int at = body.indexOf('@');
        if (at < 0) return "";
        String chain = body.substring(at + 1);
        int end = chain.indexOf('/');
        if (end >= 0) chain = chain.substring(0, end);
        return chain.matches("^[0-9]+$") ? chain : "";
    }

    private String uriBody(String raw, String prefix) {
        if (!raw.toLowerCase().startsWith(prefix)) return "";
        String value = raw.substring(prefix.length());
        int q = value.indexOf('?');
        if (q >= 0) value = value.substring(0, q);
        return value;
    }

    private String param(Uri uri, String raw, String key) {
        try {
            String value = uri.getQueryParameter(key);
            if (value != null && value.trim().length() > 0) return value.trim();
        } catch (Exception ignored) {
        }
        return paramFromRaw(raw, key);
    }

    private String paramFromRaw(String raw, String key) {
        int q = raw.indexOf('?');
        if (q < 0 || q == raw.length() - 1) return "";
        String[] parts = raw.substring(q + 1).split("&");
        for (String part : parts) {
            int eq = part.indexOf('=');
            String name = eq >= 0 ? part.substring(0, eq) : part;
            if (!key.equalsIgnoreCase(urlDecode(name))) continue;
            String value = eq >= 0 ? part.substring(eq + 1) : "";
            return urlDecode(value).trim();
        }
        return "";
    }

    private String urlDecode(String value) {
        try {
            return URLDecoder.decode(value, "UTF-8");
        } catch (Exception ignored) {
            return value;
        }
    }

    private String firstNonEmpty(String... values) {
        for (String value : values) {
            if (value != null && value.trim().length() > 0) return value.trim();
        }
        return "";
    }

    private void startDemoSetup(String relayUrl, String telegramBot, String label) {
        try {
            if (wallet == null) {
                wallet = SecureWalletStore.hasWallet(this)
                        ? HDWallet.parse(SecureWalletStore.load(this))
                        : HDWallet.create();
                SecureWalletStore.save(this, wallet.serialize());
            }
        } catch (Exception e) {
            error("Demo setup failed", e);
            return;
        }
        PaymentInboxStore.setRelayUrl(this, relayUrl.trim());
        PaymentInboxStore.setTelegramBot(this, telegramBot);
        String stellarAddress = wallet.stellar.address;
        String evmAddress = wallet.evm.address;
        toast("Starting demo setup");
        new Thread(() -> {
            try {
                RelayClient.register(this);
                JSONObject session = RelayClient.createDemoSession(this, label, telegramBot, stellarAddress, evmAddress);
                runOnUiThread(() -> {
                    updateStatus();
                    renderPublicWallet();
                    startRelayPushService();
                    connectRelay();
                    syncInboxSilently();
                    showDemoReadySheet(session, telegramBot);
                });
            } catch (Exception e) {
                runOnUiThread(() -> error("Demo setup failed", e));
            }
        }).start();
    }

    private void showDemoReadySheet(JSONObject session, String telegramBot) {
        String sessionId = session.optString("session_id", PaymentInboxStore.demoSessionId(this));
        LinearLayout body = sheetBase("Demo Ready");
        body.addView(field("Relay URL", PaymentInboxStore.relayUrl(this), true));
        body.addView(field("Demo session", sessionId, true));
        body.addView(field("Telegram bot", telegramBot, false));
        body.addView(field("Stellar address", wallet == null ? "" : wallet.stellar.address, true));
        JSONObject funding = session.optJSONObject("funding");
        if (funding != null) {
            body.addView(field("Funding status", funding.optString("status", ""), false));
            if (funding.optString("tx_hash", "").length() > 0) body.addView(field("Funding tx", funding.optString("tx_hash", ""), true));
            if (funding.optString("reason", "").length() > 0) body.addView(field("Funding note", funding.optString("reason", ""), false));
            if (funding.optString("error", "").length() > 0) body.addView(warning("Funding error: " + funding.optString("error", "")));
        }
        addGap(body, 10);
        body.addView(warning("Use Telegram to order food. The payment request will be sent to this phone."));
        addGap(body, 12);
        body.addView(primaryButton("Open Telegram", () -> openTelegramDemo(telegramBot, sessionId)), new LinearLayout.LayoutParams(-1, dp(48)));
        addGap(body, 10);
        body.addView(outlineButton("Sync Inbox", this::syncInbox), new LinearLayout.LayoutParams(-1, dp(48)));
        showSheet(body);
    }

    private void openTelegramDemo(String telegramBot, String sessionId) {
        if (telegramBot == null || telegramBot.length() == 0 || sessionId == null || sessionId.length() == 0) {
            error("Telegram setup failed", new IllegalArgumentException("Missing Telegram bot or demo session"));
            return;
        }
        Uri uri = Uri.parse("https://t.me/" + telegramBot)
                .buildUpon()
                .appendQueryParameter("start", sessionId)
                .build();
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception e) {
            error("Telegram setup failed", e);
        }
    }

    private void openExternalUrl(String value, String errorTitle) {
        if (!isUseful(value)) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(value)));
        } catch (Exception e) {
            error(errorTitle, e);
        }
    }

    private void saveRelayUrlAndRegister(String relayUrl) {
        if (relayUrl == null || relayUrl.trim().length() == 0) {
            error("Relay registration failed", new IllegalArgumentException("Relay URL is required"));
            return;
        }
        PaymentInboxStore.setRelayUrl(this, relayUrl.trim());
        toast("Registering relay");
        new Thread(() -> {
            try {
                RelayClient.register(this);
                runOnUiThread(() -> {
                    updateStatus();
                    toast("Relay settings saved");
                    startRelayPushService();
                    connectRelay();
                    syncInbox();
                });
            } catch (Exception e) {
                runOnUiThread(() -> error("Relay registration failed", e));
            }
        }).start();
    }

    private void connectRelay() {
        startRelayPushService();
        if (relayClient != null) relayClient.close();
        relayClient = new RelayClient();
        toast("Connecting relay");
        relayClient.connect(this, new RelayClient.Listener() {
            @Override
            public void onConnected() {
                runOnUiThread(() -> toast("Relay connected"));
            }

            @Override
            public void onIntent(PaymentIntent intent) {
                runOnUiThread(() -> {
                    PaymentNotifications.notifyPaymentIntent(MainActivity.this, intent);
                    toast("New payment request");
                    activeTab = TAB_MESSAGES;
                    updateTabButtons();
                    renderMessagesTab();
                    paymentDetailsSheet(intent);
                });
            }

            @Override
            public void onMessage(String message) {
                runOnUiThread(() -> toast("Relay message received"));
            }

            @Override
            public void onFailure(String message) {
                runOnUiThread(() -> toast("Relay error: " + message));
            }
        });
    }

    private void syncInbox() {
        toast("Syncing inbox");
        new Thread(() -> {
            try {
                List<PaymentIntent> items = RelayClient.sync(this);
                runOnUiThread(() -> {
                    notifyPendingIntents(items);
                    renderPaymentInboxOnly();
                    toast("Inbox synced");
                });
            } catch (Exception e) {
                runOnUiThread(() -> error("Inbox sync failed", e));
            }
        }).start();
    }

    private void syncInboxSilently() {
        new Thread(() -> {
            try {
                List<PaymentIntent> items = RelayClient.sync(this);
                runOnUiThread(() -> {
                    notifyPendingIntents(items);
                    if (TAB_MESSAGES.equals(activeTab)) renderMessagesTab();
                });
            } catch (Exception ignored) {
            }
        }).start();
    }

    private void messageCenter() {
        switchTab(TAB_MESSAGES);
        syncInbox();
    }

    private void renderPaymentInboxOnly() {
        renderActiveTab();
    }

    private View paymentInboxCard() {
        LinearLayout card = card();
        card.setPadding(dp(20), dp(20), dp(20), dp(20));
        card.setBackground(round(SURFACE, dp(24), LINE, 1));
        card.addView(pill("Request center", GREEN, GREEN_SOFT, Color.TRANSPARENT));
        addGap(card, 12);
        card.addView(text("Inbox", 28, INK, true));
        addGap(card, 6);
        card.addView(text("Review agent Payment Requests, missing context, risk blockers, and final outcomes before anything is signed.", 14, MUTED, false));
        try {
            List<PaymentIntent> intents = PaymentInboxStore.list(this);
            List<PaymentIntent> filtered = filterInboxIntents(intents, inboxFilter);
            addGap(card, 16);
            card.addView(inboxFilterBar(intents));
            addGap(card, 12);
            card.addView(pill(inboxCountLabel(filtered.size(), inboxFilter), GREEN, GREEN_SOFT, Color.TRANSPARENT));
            if (intents.isEmpty()) {
                addGap(card, 10);
                card.addView(warning("No pending requests. Connect an agent or run the quickstart, then sync Inbox."));
            } else if (filtered.isEmpty()) {
                addGap(card, 10);
                card.addView(warning(emptyInboxFilterCopy(inboxFilter)));
            } else {
                for (PaymentIntent intent : filtered) {
                    addGap(card, 10);
                    card.addView(paymentIntentRow(intent));
                }
            }
        } catch (Exception e) {
            card.addView(warning("Inbox read failed: " + e.getMessage()));
        }
        return card;
    }

    private View paymentIntentRow(PaymentIntent intent) {
        LinearLayout row = vertical();
        row.setPadding(dp(16), dp(16), dp(16), dp(16));
        row.setBackground(round(SOFT, dp(20), LINE, 1));
        String state = inboxState(intent);
        LinearLayout top = row();
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.addView(text(inboxAgentLabel(intent), 12, MUTED, true), new LinearLayout.LayoutParams(0, -2, 1));
        top.addView(pill(PaymentInboxFilter.label(state), statusColor(state), SURFACE, Color.TRANSPARENT));
        row.addView(top);
        addGap(row, 8);
        row.addView(text(intent.request.title(), 18, INK, true));
        addGap(row, 8);
        row.addView(text(inboxAmountLine(intent), 18, GREEN_DARK, true));
        addGap(row, 8);
        row.addView(text("Payee: " + inboxPayeeLabel(intent), 13, INK_SOFT, false));
        row.addView(text("Recipient: " + shortAddress(intent.request.recipient), 12, MUTED, false));
        row.addView(text("Network: " + valueOr(intent.request.network, "Unknown network"), 12, MUTED, false));
        addGap(row, 10);
        LinearLayout badges = row();
        badges.addView(pill(inboxRiskLabel(intent, state), statusColor(inboxRiskState(intent, state)), SURFACE, Color.TRANSPARENT));
        LinearLayout.LayoutParams contextLp = new LinearLayout.LayoutParams(-2, -2);
        contextLp.leftMargin = dp(8);
        badges.addView(pill(inboxContextLabel(intent, state), inboxContextColor(intent, state), SURFACE, Color.TRANSPARENT), contextLp);
        row.addView(badges);
        addGap(row, 8);
        row.addView(text(inboxTimeWindow(intent, state), 12, FADED, false));
        if (isUseful(intent.error)) {
            addGap(row, 8);
            row.addView(warning("Failure: " + trimError(intent.error)));
        }
        addGap(row, 12);
        row.addView(outlineButton("Open review", () -> paymentDetailsSheet(intent)), new LinearLayout.LayoutParams(-1, dp(48)));
        row.setOnClickListener(v -> paymentDetailsSheet(intent));
        return row;
    }

    private View inboxFilterBar(List<PaymentIntent> intents) {
        LinearLayout shell = row();
        shell.setPadding(dp(4), dp(4), dp(4), dp(4));
        shell.setBackground(round(SURFACE, dp(24), LINE, 1));
        shell.addView(inboxFilterButton("Pending", PaymentInboxFilter.FILTER_PENDING, inboxCount(intents, PaymentInboxFilter.FILTER_PENDING)), new LinearLayout.LayoutParams(0, dp(44), 1));
        LinearLayout.LayoutParams allLp = new LinearLayout.LayoutParams(0, dp(44), 1);
        allLp.leftMargin = dp(6);
        shell.addView(inboxFilterButton("All", PaymentInboxFilter.FILTER_ALL, inboxCount(intents, PaymentInboxFilter.FILTER_ALL)), allLp);
        LinearLayout.LayoutParams finalLp = new LinearLayout.LayoutParams(0, dp(44), 1);
        finalLp.leftMargin = dp(6);
        shell.addView(inboxFilterButton("Final", PaymentInboxFilter.FILTER_FINAL, inboxCount(intents, PaymentInboxFilter.FILTER_FINAL)), finalLp);
        return shell;
    }

    private Button inboxFilterButton(String label, String filter, int count) {
        boolean selected = filter.equals(inboxFilter);
        Button button = button(label + " " + count, selected ? Color.WHITE : INK_SOFT, selected ? GREEN : Color.TRANSPARENT, selected ? GREEN : Color.TRANSPARENT, () -> {
            inboxFilter = filter;
            renderPaymentInboxOnly();
        });
        button.setTextSize(12);
        button.setMinHeight(dp(40));
        button.setMinimumHeight(dp(40));
        button.setPadding(dp(8), 0, dp(8), 0);
        return button;
    }

    private int inboxCount(List<PaymentIntent> intents, String filter) {
        int count = 0;
        for (PaymentIntent intent : intents) {
            if (PaymentInboxFilter.matches(filter, inboxState(intent))) count++;
        }
        return count;
    }

    private List<PaymentIntent> filterInboxIntents(List<PaymentIntent> intents, String filter) {
        List<PaymentIntent> filtered = new ArrayList<>();
        for (PaymentIntent intent : intents) {
            if (PaymentInboxFilter.matches(filter, inboxState(intent))) filtered.add(intent);
        }
        Collections.sort(filtered, (a, b) -> PaymentInboxFilter.compare(
                inboxState(a),
                a.createdAt,
                a.expiresAt,
                inboxState(b),
                b.createdAt,
                b.expiresAt
        ));
        return filtered;
    }

    private String inboxState(PaymentIntent intent) {
        String state = PaymentInboxFilter.effectiveState(
                intent.status,
                intent.request.reviewState,
                intent.request.riskReviewStatus,
                intent.request.riskLevel,
                intent.isExpired()
        );
        if ("pending".equals(state) || "needs_review".equals(state) || "source_review_required".equals(state)) {
            try {
                RiskPolicy.Result localRisk = RiskPolicy.evaluate(this, intent);
                if (!localRisk.errors.isEmpty()) return "blocked";
            } catch (Exception ignored) {
            }
        }
        return state;
    }

    private String inboxCountLabel(int count, String filter) {
        String noun = count == 1 ? "request" : "requests";
        if (PaymentInboxFilter.FILTER_FINAL.equals(filter)) return count + " final " + noun;
        if (PaymentInboxFilter.FILTER_ALL.equals(filter)) return count + " total " + noun;
        return count + " pending " + noun;
    }

    private String emptyInboxFilterCopy(String filter) {
        if (PaymentInboxFilter.FILTER_FINAL.equals(filter)) return "No final requests yet. Confirmed, rejected, expired, and cancelled requests will appear here.";
        if (PaymentInboxFilter.FILTER_ALL.equals(filter)) return "No payment requests are saved on this device.";
        return "No pending requests. Requests needing attention will appear here.";
    }

    private String inboxAgentLabel(PaymentIntent intent) {
        PaymentRequest request = intent.request;
        String agent = firstNonEmpty(request.sourceAgentName, request.sourceDeviceLabel, request.sourceDeviceId, request.sourceType, "Agent");
        String channel = firstNonEmpty(request.sourceChannel, request.sourceRuntime);
        return channel.length() > 0 ? agent + " / " + channel : agent;
    }

    private String inboxAmountLine(PaymentIntent intent) {
        PaymentRequest request = intent.request;
        String amount = firstNonEmpty(request.amount, intent.amount, "0");
        String asset = firstNonEmpty(request.asset, intent.asset, "token");
        return amount + " " + asset;
    }

    private String inboxPayeeLabel(PaymentIntent intent) {
        return firstNonEmpty(
                intent.request.payeeName,
                intent.recipientName,
                intent.merchantName,
                shortAddress(intent.request.recipient),
                "Unknown payee"
        );
    }

    private String inboxRiskLabel(PaymentIntent intent, String state) {
        RiskPolicy.Result localRisk = inboxLocalRisk(intent, state);
        if (localRisk != null && !localRisk.errors.isEmpty()) return "Risk blocked";
        if ("blocked".equals(state)) return firstNonEmpty(intent.request.riskLabel, "Risk blocked");
        if ("network_disabled".equals(state)) return "Network disabled";
        if ("missing_context".equals(state)) return "Context needs review";
        if (localRisk != null && !localRisk.warnings.isEmpty()) return "Needs review";
        if (PaymentInboxFilter.isFinalState(state)) return "Final state";
        if ("failed".equals(state)) return "Execution failed";
        if ("broadcasting".equals(state) || "signed_locally".equals(state)) return "Execution in progress";
        return firstNonEmpty(intent.request.riskLabel, "Ready to sign");
    }

    private String inboxRiskState(PaymentIntent intent, String state) {
        RiskPolicy.Result localRisk = inboxLocalRisk(intent, state);
        if (localRisk != null && !localRisk.errors.isEmpty()) return "blocked";
        if ("blocked".equals(state) || "network_disabled".equals(state) || "failed".equals(state)) return state;
        if ("missing_context".equals(state) || "needs_review".equals(state) || "source_review_required".equals(state)) return "needs_review";
        if ("broadcasting".equals(state) || "signed_locally".equals(state)) return "broadcasting";
        if (PaymentInboxFilter.isFinalState(state)) return state;
        return firstNonEmpty(intent.request.riskLevel, state);
    }

    private RiskPolicy.Result inboxLocalRisk(PaymentIntent intent, String state) {
        if (!"pending".equals(state) && !"blocked".equals(state) && !"missing_context".equals(state)
                && !"needs_review".equals(state) && !"source_review_required".equals(state)
                && !"network_disabled".equals(state)) {
            return null;
        }
        try {
            return RiskPolicy.evaluate(this, intent);
        } catch (Exception ignored) {
            return null;
        }
    }

    private String inboxContextLabel(PaymentIntent intent, String state) {
        PaymentRequest request = intent.request;
        if ("missing_context".equals(state) || request.contextMissing) return "Context missing";
        String contextStatus = PaymentInboxFilter.normalizeState(request.contextStatus);
        if (request.contextHasSnapshot || "ready".equals(contextStatus) || "complete".equals(contextStatus)) return "Context ready";
        if (request.contextTransactionId.length() > 0 || request.contextSnapshotHash.length() > 0) return "Context ref";
        return "Context not received";
    }

    private int inboxContextColor(PaymentIntent intent, String state) {
        String label = inboxContextLabel(intent, state).toLowerCase();
        if (label.contains("missing") || label.contains("not received")) return GOLD;
        if (label.contains("ready")) return GREEN;
        return BLUE;
    }

    private String inboxTimeWindow(PaymentIntent intent, String state) {
        if ("expired".equals(state)) return "Approval window expired " + timeAgo(intent.expiresAt) + " ago";
        if (PaymentInboxFilter.isFinalState(state)) return "Final request created " + timeAgo(intent.createdAt) + " ago";
        if (intent.expiresAt > System.currentTimeMillis()) return "Approval window: " + timeUntil(intent.expiresAt) + " left";
        return "Approval window expired " + timeAgo(intent.expiresAt) + " ago";
    }

    private String timeUntil(long timestampMs) {
        return compactDuration(Math.max(0L, timestampMs - System.currentTimeMillis()));
    }

    private String timeAgo(long timestampMs) {
        if (timestampMs <= 0L) return "some time";
        return compactDuration(Math.max(0L, System.currentTimeMillis() - timestampMs));
    }

    private String compactDuration(long millis) {
        long minutes = Math.max(1L, millis / 60_000L);
        if (minutes < 60L) return minutes + " min";
        long hours = Math.max(1L, minutes / 60L);
        if (hours < 24L) return hours + " hr";
        long days = Math.max(1L, hours / 24L);
        return days + " day" + (days == 1L ? "" : "s");
    }

    private void paymentDetailsSheet(PaymentIntent intent) {
        LinearLayout body = sheetBase(intent.hasOrderDetails() ? "Order Payment" : "Payment Request");
        String state = paymentDetailState(intent);
        RiskPolicy.Result risk = paymentDetailRisk(intent, state);
        boolean canSign = isPaymentDetailSignable(intent, state, risk);

        body.addView(sectionEyebrow("Payment Facts"));
        addGap(body, 8);
        body.addView(field("Status", paymentDetailStatusLabel(state), false));
        body.addView(field("Source", intent.sourceLabel(), false));
        body.addView(field("Amount", intent.amount + " " + intent.asset, false));
        if (intent.orderTotalUsd.length() > 0) body.addView(field("Order total", "$" + intent.orderTotalUsd, false));
        if (intent.recipientName.length() > 0) body.addView(field("Recipient name", intent.recipientName, false));
        body.addView(field("Network", intent.network, false));
        body.addView(field("Recipient address", intent.to, true));
        if (intent.tokenContract.length() > 0) body.addView(field("Token contract", intent.tokenContract, true));
        if (intent.assetIssuer.length() > 0) body.addView(field("Asset issuer", intent.assetIssuer, true));
        if (intent.memo.length() > 0) body.addView(field("Memo", intent.memo, true));
        if (intent.estimatedFee.length() > 0) body.addView(field("Estimated fee", intent.estimatedFee, false));

        addGap(body, 12);
        body.addView(paymentDetailStateCard(intent, state, risk, canSign));

        addGap(body, 12);
        body.addView(truthPanelCard(intent.request));

        addGap(body, 12);
        body.addView(transactionDossierEntryCard(intent));

        if (intent.hasOrderDetails()) {
            addGap(body, 12);
            body.addView(sectionEyebrow("Request context"));
            addGap(body, 8);
            body.addView(orderPurposeCard(intent));
        } else if (intent.summary().length() > 0) {
            addGap(body, 12);
            body.addView(sectionEyebrow("Request context"));
            addGap(body, 8);
            body.addView(text(intent.summary(), 14, MUTED, false));
        }

        if (intent.velarumRequestId.length() > 0 || intent.velarumPayloadHash.length() > 0) {
            addGap(body, 12);
            body.addView(sectionEyebrow("Audit"));
            addGap(body, 8);
            if (intent.velarumRequestId.length() > 0) body.addView(field("Velarum request", intent.velarumRequestId, true));
            if (intent.velarumPayloadHash.length() > 0) body.addView(field("Velarum payload hash", intent.velarumPayloadHash, true));
        }
        if (intent.hasOrderDetails()) {
            addGap(body, 10);
            body.addView(warning("This is a simulated food order, but the blockchain payment is real. Pay only if the order details, recipient, and amount match what you expect."));
        }
        addGap(body, 12);
        addPaymentDetailActions(body, intent, state, risk, canSign);
        showSheet(body);
    }

    private String paymentDetailState(PaymentIntent intent) {
        String state = PaymentInboxFilter.effectiveState(
                intent.status,
                intent.request.reviewState,
                intent.request.riskReviewStatus,
                intent.request.riskLevel,
                intent.isExpired()
        );
        if (("pending".equals(state) || "awaiting_signature".equals(state)
                || "needs_review".equals(state) || "source_review_required".equals(state))
                && PaymentIntent.STATUS_PENDING.equals(intent.status)
                && !intent.isExpired()) {
            RiskPolicy.Result risk = paymentDetailRisk(intent, state);
            if (!risk.errors.isEmpty()) return "blocked";
        }
        return state;
    }

    private RiskPolicy.Result paymentDetailRisk(PaymentIntent intent, String state) {
        if (!shouldEvaluateDetailRisk(intent, state)) return new RiskPolicy.Result();
        try {
            return RiskPolicy.evaluate(this, intent);
        } catch (Exception e) {
            RiskPolicy.Result result = new RiskPolicy.Result();
            result.errors.add("Risk evaluation failed: " + trimError(e.getMessage()));
            return result;
        }
    }

    private boolean shouldEvaluateDetailRisk(PaymentIntent intent, String state) {
        if (!PaymentIntent.STATUS_PENDING.equals(intent.status)) return false;
        String value = PaymentInboxFilter.normalizeState(state);
        return "pending".equals(value)
                || "awaiting_signature".equals(value)
                || "blocked".equals(value)
                || "missing_context".equals(value)
                || "network_disabled".equals(value)
                || "needs_review".equals(value)
                || "source_review_required".equals(value);
    }

    private boolean isPaymentDetailSignable(PaymentIntent intent, String state, RiskPolicy.Result risk) {
        String value = PaymentInboxFilter.normalizeState(state);
        return ("pending".equals(value) || "awaiting_signature".equals(value))
                && isPayableIntent(intent)
                && intent.request.signingAllowed
                && risk != null
                && risk.allowed
                && risk.errors.isEmpty();
    }

    private String paymentDetailStatusLabel(String state) {
        return PaymentInboxFilter.label(state);
    }

    private View paymentDetailStateCard(PaymentIntent intent, String state, RiskPolicy.Result risk, boolean canSign) {
        LinearLayout card = card();
        card.setElevation(0);
        card.setBackground(round(paymentDetailToneBackground(state, canSign), dp(18), paymentDetailToneBorder(state, canSign), 1));
        LinearLayout top = row();
        top.addView(text(paymentDetailStateTitle(state, canSign), 17, INK, true), new LinearLayout.LayoutParams(0, -2, 1));
        top.addView(pill(paymentDetailStatusLabel(state), paymentDetailToneColor(state, canSign), SURFACE, Color.TRANSPARENT));
        card.addView(top);
        addGap(card, 8);
        card.addView(text(paymentDetailStateCopy(intent, state, canSign), 13, INK_SOFT, false));
        if (risk != null && !risk.errors.isEmpty()) {
            addGap(card, 10);
            card.addView(warning("Blocked: " + join(risk.errors)));
        }
        if (risk != null && !risk.warnings.isEmpty()) {
            addGap(card, 10);
            card.addView(warning("Warnings: " + join(risk.warnings)));
        }
        if (isUseful(intent.error)) {
            addGap(card, 10);
            card.addView(warning("Failure: " + trimError(intent.error)));
        }
        if (isUseful(intent.txHash) && ("broadcasting".equals(state) || "failed".equals(state) || "confirmed".equals(state))) {
            addGap(card, 10);
            card.addView(field("Tx hash", intent.txHash, true));
        }
        return card;
    }

    private String paymentDetailStateTitle(String state, boolean canSign) {
        String value = PaymentInboxFilter.normalizeState(state);
        if (canSign) return "Ready to sign";
        if ("missing_context".equals(value) || "needs_review".equals(value) || "source_review_required".equals(value)) return "Context needs review";
        if ("blocked".equals(value)) return "Blocked by risk policy";
        if ("network_disabled".equals(value)) return "Network disabled";
        if ("broadcasting".equals(value)) return "Broadcasting";
        if ("signed_locally".equals(value)) return "Signed locally";
        if ("failed".equals(value)) return "Broadcast failed";
        if ("confirmed".equals(value)) return "Signed locally";
        if ("rejected".equals(value)) return "Rejected";
        if ("expired".equals(value)) return "Expired";
        if ("cancelled".equals(value)) return "Cancelled";
        return "Not signable";
    }

    private String paymentDetailStateCopy(PaymentIntent intent, String state, boolean canSign) {
        String value = PaymentInboxFilter.normalizeState(state);
        if (canSign) return "Payment facts and local risk checks are ready. You can reject the request or continue to local signing on this device.";
        if ("missing_context".equals(value)) return "Required transaction context or evidence is missing. Payment facts remain visible, but signing is unavailable until the agent repairs the context.";
        if ("needs_review".equals(value) || "source_review_required".equals(value)) return "Critical context needs review before signing can resume. Request more context or reject the request.";
        if ("blocked".equals(value)) return "A blocking risk rule prevents this request from being signed. Review the dossier or reject the request.";
        if ("network_disabled".equals(value)) return "This request targets a network that is not enabled or verified in the wallet. Open network settings before any signature is possible.";
        if ("broadcasting".equals(value)) return "A local signature exists and the transaction has been submitted. Do not sign again; refresh status or view activity.";
        if ("signed_locally".equals(value)) return "The transaction was signed on this device. Continue tracking it from activity instead of signing again.";
        if ("failed".equals(value)) return "The request was signed, but broadcast failed. Retry only after re-checking fee, recipient, and the prior transaction state.";
        if ("confirmed".equals(value)) return "The request is final and already recorded in activity. No new signature is allowed.";
        if ("rejected".equals(value)) return "You rejected this Payment Request. Agents cannot reuse this approval and nothing was signed.";
        if ("expired".equals(value)) return "The approval window is closed. Ask the agent to create a new request if payment is still needed.";
        if ("cancelled".equals(value)) return "The requesting app cancelled this Payment Request. Nothing was signed.";
        return "This request is not in a signable state.";
    }

    private int paymentDetailToneColor(String state, boolean canSign) {
        String value = PaymentInboxFilter.normalizeState(state);
        if (canSign || "confirmed".equals(value)) return GREEN;
        if ("broadcasting".equals(value) || "signed_locally".equals(value)) return BLUE;
        if ("missing_context".equals(value) || "needs_review".equals(value) || "source_review_required".equals(value) || "network_disabled".equals(value)) return GOLD;
        return RED;
    }

    private int paymentDetailToneBackground(String state, boolean canSign) {
        int color = paymentDetailToneColor(state, canSign);
        if (color == GREEN) return GREEN_SOFT;
        if (color == BLUE) return BLUE_SOFT;
        if (color == GOLD) return AMBER_SOFT;
        return RED_SOFT;
    }

    private int paymentDetailToneBorder(String state, boolean canSign) {
        int color = paymentDetailToneColor(state, canSign);
        if (color == GREEN) return Color.rgb(191, 216, 197);
        if (color == BLUE) return Color.rgb(191, 214, 229);
        if (color == GOLD) return Color.rgb(231, 220, 170);
        return Color.rgb(232, 187, 181);
    }

    private void addPaymentDetailActions(LinearLayout body, PaymentIntent intent, String state, RiskPolicy.Result risk, boolean canSign) {
        String value = PaymentInboxFilter.normalizeState(state);
        if (canSign) {
            LinearLayout actions = row();
            actions.addView(dangerButton("Reject", () -> rejectIntent(intent)), weight());
            actions.addView(primaryButton("Sign", () -> payIntent(intent)), weightLeft());
            body.addView(actions);
            return;
        }
        if ("missing_context".equals(value) || "needs_review".equals(value) || "source_review_required".equals(value)) {
            addTwoPaymentActions(body,
                    primaryButton("Request context", () -> requestPaymentContext(intent)),
                    dangerButton("Reject request", () -> rejectIntent(intent)));
            return;
        }
        if ("blocked".equals(value)) {
            addTwoPaymentActions(body,
                    primaryButton("Open dossier", () -> paymentDossierSheet(intent)),
                    dangerButton("Reject request", () -> rejectIntent(intent)));
            return;
        }
        if ("network_disabled".equals(value)) {
            addTwoPaymentActions(body,
                    primaryButton("Open networks", this::openNetworkSettings),
                    dangerButton("Reject request", () -> rejectIntent(intent)));
            return;
        }
        if ("broadcasting".equals(value)) {
            addTwoPaymentActions(body,
                    primaryButton("Refresh status", this::syncInbox),
                    outlineButton("View activity", this::openActivityFromSheet));
            return;
        }
        if ("signed_locally".equals(value) || "confirmed".equals(value)) {
            body.addView(primaryButton("View activity", this::openActivityFromSheet), new LinearLayout.LayoutParams(-1, dp(48)));
            return;
        }
        if ("failed".equals(value)) {
            addTwoPaymentActions(body,
                    primaryButton("Retry broadcast", () -> retryFailedPaymentPlaceholder(intent)),
                    outlineButton("Replace request", () -> replacePaymentRequestPlaceholder(intent)));
            return;
        }
        if ("expired".equals(value) || "cancelled".equals(value)) {
            body.addView(outlineButton("Archive", this::closeActiveSheet), new LinearLayout.LayoutParams(-1, dp(48)));
            return;
        }
        if ("rejected".equals(value)) {
            body.addView(outlineButton("Back to Inbox", this::backToInboxFromSheet), new LinearLayout.LayoutParams(-1, dp(48)));
            return;
        }
        body.addView(statusNoticeForIntent(intent));
    }

    private void addTwoPaymentActions(LinearLayout body, Button primary, Button secondary) {
        LinearLayout actions = row();
        actions.addView(primary, weight());
        actions.addView(secondary, weightLeft());
        body.addView(actions);
    }

    private void requestPaymentContext(PaymentIntent intent) {
        toast("Context requested from " + inboxAgentLabel(intent));
    }

    private void openNetworkSettings() {
        closeActiveSheet();
        switchTab(TAB_SETTINGS);
        toast("Review network settings before signing");
    }

    private void openActivityFromSheet() {
        closeActiveSheet();
        switchTab(TAB_HISTORY);
    }

    private void retryFailedPaymentPlaceholder(PaymentIntent intent) {
        toast("Review fee and recipient before retrying broadcast");
    }

    private void replacePaymentRequestPlaceholder(PaymentIntent intent) {
        toast("Ask the agent to create a replacement request");
    }

    private void backToInboxFromSheet() {
        closeActiveSheet();
        switchTab(TAB_MESSAGES);
    }

    private View transactionDossierEntryCard(PaymentIntent intent) {
        TransactionDossier dossier = TransactionDossier.from(intent);
        LinearLayout card = card();
        card.setElevation(0);
        card.setBackground(round(SURFACE, dp(24), LINE, 1));
        LinearLayout head = row();
        LinearLayout copy = vertical();
        copy.addView(text("Transaction dossier", 19, INK, true));
        copy.addView(text("intent, evidence, AI trace, risk checks, payment mapping", 12, MUTED, false));
        head.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
        head.addView(pill(dossier.status, truthToneColor(dossier.tone), truthTonePillBackground(dossier.tone), Color.TRANSPARENT));
        card.addView(head);
        addGap(card, 10);
        card.addView(text("Open the full dossier to see why this payment exists, what the AI did, what evidence arrived, and how it maps to the final chain action.", 13, INK_SOFT, false));
        addGap(card, 12);
        card.addView(outlineButton("Open transaction dossier", () -> paymentDossierSheet(intent)), new LinearLayout.LayoutParams(-1, dp(48)));
        return card;
    }

    private void paymentDossierSheet(PaymentIntent intent) {
        TransactionDossier dossier = TransactionDossier.from(intent);
        LinearLayout body = sheetBase("Transaction Dossier");
        LinearLayout top = row();
        LinearLayout copy = vertical();
        copy.addView(text(dossier.title, 25, INK, true));
        copy.addView(text(dossier.agentName + " / " + dossier.source, 13, MUTED, false));
        top.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
        top.addView(pill(dossier.status, truthToneColor(dossier.tone), truthTonePillBackground(dossier.tone), Color.TRANSPARENT));
        body.addView(top);

        addGap(body, 12);
        body.addView(dossierRiskCard(dossier));

        addGap(body, 12);
        body.addView(dossierEvidenceCard(dossier.evidenceItems));

        addGap(body, 12);
        body.addView(dossierRowsCard("Decision snapshot", "why this payment exists", dossier.decisionRows));

        addGap(body, 12);
        body.addView(dossierRowsCard("Evidence and items", "what was purchased or requested", dossier.itemRows));

        addGap(body, 12);
        body.addView(dossierTruthCard(dossier.truthSections));

        addGap(body, 12);
        body.addView(dossierTraceCard(dossier.agentSteps));

        addGap(body, 12);
        body.addView(dossierRowsCard("Permission and risk checks", "request permission, local signing, blockers", dossier.permissionRiskRows));

        addGap(body, 12);
        body.addView(dossierRowsCard("Payment mapping", "final chain action", dossier.paymentMappingRows));

        addGap(body, 12);
        addDossierActions(body, intent);
        showSheet(body);
    }

    private View dossierRiskCard(TransactionDossier dossier) {
        LinearLayout card = card();
        card.setElevation(0);
        card.setBackground(round(truthToneBackground(dossier.tone), dp(20), truthToneBorder(dossier.tone), 1));
        LinearLayout top = row();
        top.addView(text(dossier.riskTitle, 17, INK, true), new LinearLayout.LayoutParams(0, -2, 1));
        top.addView(pill(truthToneLabel(dossier.tone), truthToneColor(dossier.tone), SURFACE, Color.TRANSPARENT));
        card.addView(top);
        addGap(card, 8);
        card.addView(text(dossier.riskBody, 13, INK_SOFT, false));
        return card;
    }

    private View dossierEvidenceCard(List<TransactionDossier.EvidenceItem> items) {
        LinearLayout card = card();
        card.setElevation(0);
        card.setBackground(round(SURFACE, dp(24), LINE, 1));
        LinearLayout head = row();
        head.addView(text("Evidence", 19, INK, true), new LinearLayout.LayoutParams(0, -2, 1));
        head.addView(text("source material", 12, MUTED, false));
        card.addView(head);
        if (items == null || items.isEmpty()) {
            addGap(card, 12);
            card.addView(dossierEvidenceItemView(new TransactionDossier.EvidenceItem("Evidence not received", "Missing", TransactionDossier.TONE_DANGER)));
            return card;
        }
        LinearLayout currentRow = null;
        for (int i = 0; i < items.size(); i++) {
            if (i % 2 == 0) {
                addGap(card, 10);
                currentRow = row();
                card.addView(currentRow);
            }
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, -2, 1);
            if (i % 2 == 1) lp.leftMargin = dp(10);
            currentRow.addView(dossierEvidenceItemView(items.get(i)), lp);
        }
        return card;
    }

    private View dossierEvidenceItemView(TransactionDossier.EvidenceItem item) {
        LinearLayout box = vertical();
        box.setPadding(dp(14), dp(14), dp(14), dp(14));
        box.setBackground(round(truthTonePillBackground(item.tone), dp(18), Color.TRANSPARENT, 0));
        box.addView(text(item.title, 14, INK, true));
        addGap(box, 6);
        box.addView(text(item.meta, 12, INK_SOFT, false));
        return box;
    }

    private View dossierRowsCard(String title, String note, List<TransactionDossier.Row> rows) {
        LinearLayout card = card();
        card.setElevation(0);
        card.setBackground(round(SURFACE, dp(24), LINE, 1));
        LinearLayout head = row();
        LinearLayout copy = vertical();
        copy.addView(text(title, 19, INK, true));
        if (isUseful(note)) copy.addView(text(note, 12, MUTED, false));
        head.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
        card.addView(head);
        if (rows == null || rows.isEmpty()) {
            addGap(card, 12);
            card.addView(warning("Evidence not received."));
            return card;
        }
        for (TransactionDossier.Row item : rows) {
            addGap(card, 10);
            card.addView(dossierRowView(item));
        }
        return card;
    }

    private View dossierRowView(TransactionDossier.Row item) {
        LinearLayout box = vertical();
        box.setPadding(dp(12), dp(12), dp(12), dp(12));
        box.setBackground(round(truthTonePillBackground(item.tone), dp(16), truthToneBorder(item.tone), 1));
        LinearLayout top = row();
        top.addView(text(item.label, 13, INK, true), new LinearLayout.LayoutParams(0, -2, 1));
        top.addView(pill(truthToneLabel(item.tone), truthToneColor(item.tone), SURFACE, Color.TRANSPARENT));
        box.addView(top);
        addGap(box, 5);
        TextView value = text(item.value, 13, INK_SOFT, false);
        value.setTextIsSelectable(true);
        box.addView(value);
        if (isUseful(item.detail)) {
            addGap(box, 6);
            box.addView(text(item.detail, 12, MUTED, false));
        }
        return box;
    }

    private View dossierTruthCard(List<TruthPanel.Section> sections) {
        LinearLayout card = card();
        card.setElevation(0);
        card.setBackground(round(SURFACE, dp(24), LINE, 1));
        LinearLayout head = row();
        LinearLayout copy = vertical();
        copy.addView(text("Truth Panel", 19, INK, true));
        copy.addView(text("facts, claims, inference", 12, MUTED, false));
        head.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
        card.addView(head);
        if (sections == null || sections.isEmpty()) {
            addGap(card, 12);
            card.addView(warning("Evidence not received. Payment Facts remain visible, but source evidence is unavailable."));
            return card;
        }
        for (TruthPanel.Section section : sections) {
            addGap(card, 12);
            card.addView(truthSectionView(section));
        }
        return card;
    }

    private View dossierTraceCard(List<TransactionDossier.TraceStep> steps) {
        LinearLayout card = card();
        card.setElevation(0);
        card.setBackground(round(SURFACE, dp(24), LINE, 1));
        LinearLayout head = row();
        LinearLayout copy = vertical();
        copy.addView(text("AI task trace", 19, INK, true));
        copy.addView(text("decision path", 12, MUTED, false));
        head.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
        card.addView(head);
        if (steps == null || steps.isEmpty()) {
            addGap(card, 12);
            card.addView(warning("Evidence not received. Agent trace is missing."));
            return card;
        }
        for (TransactionDossier.TraceStep step : steps) {
            addGap(card, 10);
            card.addView(dossierTraceStepView(step));
        }
        return card;
    }

    private View dossierTraceStepView(TransactionDossier.TraceStep step) {
        LinearLayout box = row();
        box.setGravity(Gravity.TOP);
        box.setPadding(dp(12), dp(12), dp(12), dp(12));
        box.setBackground(round(truthTonePillBackground(step.tone), dp(16), truthToneBorder(step.tone), 1));
        TextView marker = pill("", truthToneColor(step.tone), truthToneColor(step.tone), Color.TRANSPARENT);
        LinearLayout.LayoutParams markerLp = new LinearLayout.LayoutParams(dp(12), dp(12));
        markerLp.topMargin = dp(3);
        box.addView(marker, markerLp);
        LinearLayout copy = vertical();
        LinearLayout.LayoutParams copyLp = new LinearLayout.LayoutParams(0, -2, 1);
        copyLp.leftMargin = dp(10);
        copy.addView(text(step.title, 13, INK, true));
        addGap(copy, 4);
        copy.addView(text(step.body, 12, MUTED, false));
        box.addView(copy, copyLp);
        return box;
    }

    private void addDossierActions(LinearLayout body, PaymentIntent intent) {
        String value = PaymentInboxFilter.normalizeState(paymentDetailState(intent));
        if ("missing_context".equals(value) || "needs_review".equals(value) || "source_review_required".equals(value)) {
            addTwoPaymentActions(body,
                    primaryButton("Request context", () -> requestPaymentContext(intent)),
                    outlineButton("Back to Payment Detail", () -> paymentDetailsSheet(intent)));
            return;
        }
        if ("blocked".equals(value)) {
            addTwoPaymentActions(body,
                    dangerButton("Reject request", () -> rejectIntent(intent)),
                    outlineButton("Back to Payment Detail", () -> paymentDetailsSheet(intent)));
            return;
        }
        body.addView(primaryButton("Back to Payment Detail", () -> paymentDetailsSheet(intent)), new LinearLayout.LayoutParams(-1, dp(48)));
    }

    private View truthPanelCard(PaymentRequest request) {
        LinearLayout panel = card();
        panel.setElevation(0);
        panel.setBackground(round(SURFACE, dp(24), LINE, 1));
        LinearLayout head = row();
        LinearLayout copy = vertical();
        copy.addView(text("Truth Panel", 19, INK, true));
        copy.addView(text("facts, claims, inference", 12, MUTED, false));
        head.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
        head.addView(pill("Sources", BLUE, BLUE_SOFT, Color.TRANSPARENT));
        panel.addView(head);

        List<TruthPanel.Section> sections = TruthPanel.sections(request);
        if (sections.isEmpty()) {
            addGap(panel, 12);
            panel.addView(warning("Transaction context was not received. Payment Facts remain visible, but source evidence is unavailable."));
            return panel;
        }
        for (TruthPanel.Section section : sections) {
            addGap(panel, 12);
            panel.addView(truthSectionView(section));
        }
        return panel;
    }

    private View truthSectionView(TruthPanel.Section section) {
        LinearLayout box = vertical();
        box.setPadding(dp(14), dp(14), dp(14), dp(14));
        box.setBackground(round(truthToneBackground(section.tone), dp(18), truthToneBorder(section.tone), 1));
        LinearLayout head = row();
        LinearLayout copy = vertical();
        copy.addView(text(section.title, 15, INK, true));
        copy.addView(text(section.note, 11, MUTED, false));
        head.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
        head.addView(pill(truthToneLabel(section.tone), truthToneColor(section.tone), SURFACE, Color.TRANSPARENT));
        box.addView(head);
        for (TruthPanel.Row truthRow : section.rows) {
            addGap(box, 10);
            box.addView(truthRowView(truthRow));
        }
        return box;
    }

    private View truthRowView(TruthPanel.Row truthRow) {
        LinearLayout box = vertical();
        box.setPadding(dp(12), dp(12), dp(12), dp(12));
        box.setBackground(round(SURFACE, dp(14), Color.TRANSPARENT, 0));
        box.addView(text(truthRow.field, 13, INK, true));
        addGap(box, 4);
        TextView value = text(truthRow.value, 13, INK_SOFT, false);
        value.setTextIsSelectable(true);
        box.addView(value);
        addGap(box, 8);
        LinearLayout badges = row();
        badges.addView(pill(truthRow.source, truthToneColor(truthRow.tone), truthTonePillBackground(truthRow.tone), Color.TRANSPARENT));
        LinearLayout.LayoutParams statusLp = new LinearLayout.LayoutParams(-2, -2);
        statusLp.leftMargin = dp(8);
        badges.addView(pill(truthRow.status, truthToneColor(truthRow.tone), truthTonePillBackground(truthRow.tone), Color.TRANSPARENT), statusLp);
        box.addView(badges);
        if (isUseful(truthRow.evidence)) {
            addGap(box, 8);
            box.addView(text(truthRow.evidence, 12, MUTED, false));
        }
        return box;
    }

    private int truthToneColor(String tone) {
        if (TruthPanel.TONE_DANGER.equals(tone)) return RED;
        if (TruthPanel.TONE_CAUTION.equals(tone)) return GOLD;
        if (TruthPanel.TONE_SAFE.equals(tone)) return GREEN;
        return BLUE;
    }

    private int truthToneBackground(String tone) {
        if (TruthPanel.TONE_DANGER.equals(tone)) return RED_SOFT;
        if (TruthPanel.TONE_CAUTION.equals(tone)) return AMBER_SOFT;
        if (TruthPanel.TONE_SAFE.equals(tone)) return GREEN_SOFT;
        return BLUE_SOFT;
    }

    private int truthTonePillBackground(String tone) {
        if (TruthPanel.TONE_DANGER.equals(tone)) return RED_SOFT;
        if (TruthPanel.TONE_CAUTION.equals(tone)) return AMBER_SOFT;
        if (TruthPanel.TONE_SAFE.equals(tone)) return GREEN_SOFT;
        return BLUE_SOFT;
    }

    private int truthToneBorder(String tone) {
        if (TruthPanel.TONE_DANGER.equals(tone)) return Color.rgb(232, 187, 181);
        if (TruthPanel.TONE_CAUTION.equals(tone)) return Color.rgb(231, 220, 170);
        if (TruthPanel.TONE_SAFE.equals(tone)) return Color.rgb(191, 216, 197);
        return Color.rgb(191, 214, 229);
    }

    private String truthToneLabel(String tone) {
        if (TruthPanel.TONE_DANGER.equals(tone)) return "Blocked";
        if (TruthPanel.TONE_CAUTION.equals(tone)) return "Review";
        if (TruthPanel.TONE_SAFE.equals(tone)) return "Verified";
        return "Info";
    }

    private View orderPurposeCard(PaymentIntent intent) {
        LinearLayout card = card();
        card.setElevation(0);
        card.setBackground(round(SURFACE, dp(24), LINE, 1));
        card.addView(pill("Food delivery demo", GREEN, GREEN_SOFT, Color.TRANSPARENT));
        addGap(card, 12);
        card.addView(text("You are paying for", 14, MUTED, true));
        addGap(card, 4);
        card.addView(text(valueOr(intent.itemSummary, intent.title()), 24, INK, true));
        if (isUseful(intent.primaryImageUrl())) {
            addGap(card, 12);
            card.addView(remoteImage(intent.primaryImageUrl(), -1, 132, 18));
        }
        addGap(card, 12);
        if (intent.restaurantName.length() > 0) {
            card.addView(field("Restaurant", joinDisplay(intent.restaurantName, intent.restaurantCuisine), false));
        }
        if (intent.orderId.length() > 0) card.addView(field("Order ID", intent.orderId, true));
        if (isUseful(intent.shoppingSiteUrl)) {
            card.addView(field("AgentFood order page", intent.shoppingSiteUrl, true));
            addGap(card, 8);
            card.addView(outlineButton("Open AgentFood page", () -> openExternalUrl(intent.shoppingSiteUrl, "Open AgentFood page failed")), new LinearLayout.LayoutParams(-1, dp(48)));
        } else if (isUseful(intent.orderUrl)) {
            card.addView(field("Order page", intent.orderUrl, true));
            addGap(card, 8);
            card.addView(outlineButton("Open order page", () -> openExternalUrl(intent.orderUrl, "Open order page failed")), new LinearLayout.LayoutParams(-1, dp(48)));
        }
        if (intent.orderSubtotalUsd.length() > 0) card.addView(field("Subtotal", "$" + intent.orderSubtotalUsd, false));
        if (intent.orderDeliveryFeeUsd.length() > 0) card.addView(field("Delivery fee", "$" + intent.orderDeliveryFeeUsd, false));
        if (intent.orderTotalUsd.length() > 0) card.addView(field("Order total", "$" + intent.orderTotalUsd, false));
        card.addView(field("Pay with", intent.amount + " " + intent.asset, false));
        if (isUseful(intent.orderEtaMinutes)) card.addView(field("Estimated delivery", intent.orderEtaMinutes + " min", false));
        if (!intent.orderItems.isEmpty()) {
            addGap(card, 12);
            card.addView(sectionEyebrow("Items"));
            for (PaymentIntent.OrderItem item : intent.orderItems) {
                addGap(card, 8);
                card.addView(orderItemLine(item));
            }
        }
        if (intent.agentPrompt.length() > 0) card.addView(field("AI request", intent.agentPrompt, false));
        if (intent.agentNote.length() > 0) card.addView(field("AI note", intent.agentNote, false));
        return card;
    }

    private View orderItemLine(PaymentIntent.OrderItem item) {
        LinearLayout row = row();
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(10), dp(10), dp(10), dp(10));
        row.setBackground(round(SUNKEN, dp(14), LINE, 1));
        if (isUseful(item.imageUrl)) {
            row.addView(remoteImage(item.imageUrl, 54, 54, 12));
        }
        LinearLayout copy = vertical();
        LinearLayout.LayoutParams copyLp = new LinearLayout.LayoutParams(0, -2, 1);
        copyLp.leftMargin = isUseful(item.imageUrl) ? dp(10) : 0;
        LinearLayout titleRow = row();
        String title = item.quantity + "x " + item.name;
        titleRow.addView(text(title, 14, INK, true), new LinearLayout.LayoutParams(0, -2, 1));
        if (item.lineTotalUsd.length() > 0) titleRow.addView(text("$" + item.lineTotalUsd, 13, GREEN, true));
        copy.addView(titleRow);
        if (isUseful(item.description)) copy.addView(text(item.description, 12, MUTED, false));
        if (isUseful(item.note)) copy.addView(text("Note: " + item.note, 12, FADED, false));
        row.addView(copy, copyLp);
        if (isUseful(item.url)) row.setOnClickListener(v -> openExternalUrl(item.url, "Open item failed"));
        return row;
    }

    private void rejectIntent(PaymentIntent intent) {
        new Thread(() -> {
            try {
                RelayClient.updateStatus(this, intent, PaymentIntent.STATUS_REJECTED, null, null);
                runOnUiThread(() -> {
                    renderPaymentInboxOnly();
                    toast("Payment rejected");
                });
            } catch (Exception e) {
                runOnUiThread(() -> error("Reject failed", e));
            }
        }).start();
    }

    private void payIntent(PaymentIntent intent) {
        paymentSigningReviewSheet(intent);
    }

    private boolean ensurePaymentReadyToSign(PaymentIntent intent) {
        String state = paymentDetailState(intent);
        RiskPolicy.Result risk = paymentDetailRisk(intent, state);
        if (!isPaymentDetailSignable(intent, state, risk)) {
            error("Payment blocked", new IllegalStateException(paymentDetailBlockedReason(intent, state, risk)));
            return false;
        }
        if (!requireWallet()) return false;
        try {
            if (PaymentInboxStore.hasCompletedIntent(this, intent)) {
                error("Payment blocked", new IllegalStateException("Duplicate or completed payment request"));
                return false;
            }
        } catch (Exception e) {
            error("Payment blocked", e);
            return false;
        }
        return true;
    }

    private void paymentSigningReviewSheet(PaymentIntent intent) {
        if (!ensurePaymentReadyToSign(intent)) return;
        LinearLayout body = sheetBase("Review before signing");
        body.addView(signingStepRow(0));
        addGap(body, 12);
        body.addView(text("Confirm the exact on-chain action before unlocking the encrypted local keyring.", 15, INK_SOFT, false));
        addGap(body, 12);
        body.addView(signingFactsCard(intent, false));
        addGap(body, 12);
        body.addView(warning(signingBoundaryCopy()));
        addGap(body, 12);
        LinearLayout actions = row();
        actions.addView(outlineButton("Cancel", () -> paymentDetailsSheet(intent)), weight());
        actions.addView(primaryButton("Continue", () -> paymentSigningAuthSheet(intent)), weightLeft());
        body.addView(actions);
        showSheet(body);
    }

    private void paymentSigningAuthSheet(PaymentIntent intent) {
        if (!ensurePaymentReadyToSign(intent)) return;
        LinearLayout body = sheetBase("Unlock encrypted keyring");
        body.addView(signingStepRow(1));
        addGap(body, 12);
        body.addView(text("Use biometric unlock or device passcode. The keyring is unlocked only for this one local signature.", 15, INK_SOFT, false));
        addGap(body, 12);
        body.addView(signingFactsCard(intent, false));
        addGap(body, 12);
        body.addView(warning("No signature is created until local authentication succeeds. " + signingBoundaryCopy()));
        addGap(body, 12);
        LinearLayout actions = row();
        actions.addView(outlineButton("Cancel", () -> paymentSigningCancelledSheet(
                intent,
                "Signing cancelled",
                "No signature created",
                "You cancelled before local authentication completed. The request is still unsigned."
        )), weight());
        actions.addView(primaryButton("Authenticate", () -> authenticate(
                "Unlock encrypted keyring",
                "Confirm local signing for " + signingAmountLine(intent) + ".",
                () -> executePaymentAfterAuthentication(intent),
                () -> paymentSigningCancelledSheet(
                        intent,
                        "Signing cancelled",
                        "No signature created",
                        "Local authentication did not complete. The request status was not changed."
                ),
                () -> paymentSigningFailedSheet(
                        intent,
                        "The keyring remains locked. No signature was created and the request status was not changed."
                )
        )), weightLeft());
        body.addView(actions);
        showSheet(body);
    }

    private void paymentSigningCancelledSheet(PaymentIntent intent, String heading, String title, String message) {
        LinearLayout body = sheetBase(heading);
        body.addView(signingStepRow(1));
        addGap(body, 12);
        LinearLayout card = card();
        card.setElevation(0);
        card.setBackground(round(BLUE_SOFT, dp(20), Color.rgb(191, 214, 229), 1));
        card.addView(text(title, 17, INK, true));
        addGap(card, 8);
        card.addView(text(message, 13, INK_SOFT, false));
        body.addView(card);
        addGap(body, 12);
        body.addView(signingFactsCard(intent, false));
        addGap(body, 12);
        LinearLayout actions = row();
        actions.addView(primaryButton("Review signing again", () -> paymentSigningReviewSheet(intent)), weight());
        actions.addView(outlineButton("Return to request", () -> paymentDetailsSheet(intent)), weightLeft());
        body.addView(actions);
        showSheet(body);
    }

    private void paymentSigningFailedSheet(PaymentIntent intent, String message) {
        LinearLayout body = sheetBase("Authentication failed");
        body.addView(signingStepRow(1));
        addGap(body, 12);
        LinearLayout card = card();
        card.setElevation(0);
        card.setBackground(round(RED_SOFT, dp(20), Color.rgb(232, 187, 181), 1));
        card.addView(text("Keyring remains locked", 17, INK, true));
        addGap(card, 8);
        card.addView(text(message, 13, INK_SOFT, false));
        body.addView(card);
        addGap(body, 12);
        body.addView(signingFactsCard(intent, false));
        addGap(body, 12);
        LinearLayout actions = row();
        actions.addView(primaryButton("Try again", () -> paymentSigningAuthSheet(intent)), weight());
        actions.addView(outlineButton("Cancel signing", () -> paymentDetailsSheet(intent)), weightLeft());
        body.addView(actions);
        showSheet(body);
    }

    private void executePaymentAfterAuthentication(PaymentIntent intent) {
        if (!ensurePaymentReadyToSign(intent)) return;
        toast("Signing locally");
        paymentProgressSheet(
                "Unlock encrypted keyring",
                "Local authentication completed. Preparing a one-time signature on this device.",
                "Key source: " + ENCRYPTED_LOCAL_KEYRING
        );
        new Thread(() -> {
            try {
                String txHash = PaymentExecutor.execute(this, wallet, intent, detail -> {
                    runOnUiThread(() -> paymentProgressSheet(
                            "Signed locally",
                            intent.network.length() > 0
                                    ? "A local signature exists. Broadcasting to " + intent.network + "."
                                    : "A local signature exists. Broadcasting to the network.",
                            detail
                    ));
                    RelayClient.updateStatus(this, intent, PaymentIntent.STATUS_SIGNED, null, null);
                });
                RelayClient.updateStatus(this, intent, PaymentIntent.STATUS_BROADCASTED, txHash, null);
                RiskPolicy.recordSuccessfulPayment(this, intent);
                runOnUiThread(() -> {
                    paymentSigningReceiptSheet(intent, txHash);
                    renderPaymentInboxOnly();
                    refreshBalancesAfterPayment();
                });
            } catch (Exception e) {
                try {
                    String status = intent.isExpired() ? PaymentIntent.STATUS_EXPIRED : PaymentIntent.STATUS_FAILED;
                    RelayClient.updateStatus(this, intent, status, null, e.getMessage());
                } catch (Exception ignored) {
                }
                runOnUiThread(() -> error("Payment failed", e));
            }
        }).start();
    }

    private void paymentSigningReceiptSheet(PaymentIntent intent, String txHash) {
        LinearLayout body = sheetBase("Signed locally");
        body.addView(signingStepRow(2));
        addGap(body, 12);
        body.addView(text("The transaction signature was created on this device. " + signingBoundaryCopy(), 15, INK_SOFT, false));
        addGap(body, 12);
        LinearLayout receipt = card();
        receipt.setElevation(0);
        receipt.setBackground(round(GREEN_SOFT, dp(20), Color.rgb(191, 216, 197), 1));
        receipt.addView(text("Signature receipt", 18, INK, true));
        receipt.addView(field("Request ID", signingRequestId(intent), true));
        if (isUseful(txHash)) {
            receipt.addView(field("Tx hash", txHash, true));
        } else {
            receipt.addView(field("Local signing status", "Signed locally", false));
        }
        receipt.addView(field("Amount", signingAmountLine(intent), false));
        receipt.addView(field("Created by", ENCRYPTED_LOCAL_KEYRING, false));
        body.addView(receipt);
        addGap(body, 12);
        LinearLayout actions = row();
        actions.addView(primaryButton("View activity", this::openActivityFromSheet), weight());
        actions.addView(outlineButton("Open request", () -> openUpdatedPaymentDetails(intent)), weightLeft());
        body.addView(actions);
        showSheet(body);
    }

    private void openUpdatedPaymentDetails(PaymentIntent intent) {
        try {
            PaymentIntent current = PaymentInboxStore.find(this, signingRequestId(intent));
            paymentDetailsSheet(current == null ? intent : current);
        } catch (Exception e) {
            paymentDetailsSheet(intent);
        }
    }

    private View signingStepRow(int active) {
        LinearLayout steps = row();
        String[] labels = {"Review", "Unlock", "Signed"};
        for (int i = 0; i < labels.length; i++) {
            int color = i == active ? (i == 1 ? BLUE : GREEN) : MUTED;
            int bg = i == active ? (i == 1 ? BLUE_SOFT : GREEN_SOFT) : SOFT;
            TextView step = pill((i + 1) + " " + labels[i], color, bg, Color.TRANSPARENT);
            step.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(34), 1);
            if (i > 0) lp.leftMargin = dp(8);
            steps.addView(step, lp);
        }
        return steps;
    }

    private View signingFactsCard(PaymentIntent intent, boolean includeRequestId) {
        LinearLayout card = card();
        card.setElevation(0);
        card.setBackground(round(SURFACE, dp(20), LINE, 1));
        card.addView(field("Payee", inboxPayeeLabel(intent), false));
        card.addView(field("Recipient address", intent.to, true));
        card.addView(field("Network", firstNonEmpty(intent.network, intent.request.network, "Unknown network"), false));
        card.addView(field("Total", signingTotalLine(intent), false));
        card.addView(field("Key source", ENCRYPTED_LOCAL_KEYRING, false));
        if (includeRequestId) card.addView(field("Request ID", signingRequestId(intent), true));
        return card;
    }

    private String signingAmountLine(PaymentIntent intent) {
        return firstNonEmpty(intent.amount, intent.request.amount, "0") + " " + firstNonEmpty(intent.asset, intent.request.asset, "token");
    }

    private String signingTotalLine(PaymentIntent intent) {
        String amount = firstNonEmpty(intent.amount, intent.request.amount, "0");
        String asset = firstNonEmpty(intent.asset, intent.request.asset, "token");
        String total = intent.request == null ? "" : intent.request.total;
        if (isUseful(total) && !total.equals(amount)) {
            return total.toUpperCase().contains(asset.toUpperCase()) ? total : total + " " + asset;
        }
        if (isUseful(intent.estimatedFee)) return amount + " " + asset + " + fee " + intent.estimatedFee;
        return amount + " " + asset;
    }

    private String signingRequestId(PaymentIntent intent) {
        return firstNonEmpty(
                intent.velarumRequestId,
                intent.request == null ? "" : intent.request.requestId,
                intent.id,
                intent.request == null ? "" : intent.request.legacyIntentId,
                "local-request"
        );
    }

    private String signingBoundaryCopy() {
        return "Agent, connector, and VelarumPay server never receive seed material or signing authority.";
    }

    private String paymentDetailBlockedReason(PaymentIntent intent, String state, RiskPolicy.Result risk) {
        if (risk != null && !risk.errors.isEmpty()) return join(risk.errors);
        String value = PaymentInboxFilter.normalizeState(state);
        if (intent.isExpired() || "expired".equals(value)) return "This request is expired. Ask the agent to create a new request.";
        if ("missing_context".equals(value) || "needs_review".equals(value) || "source_review_required".equals(value)) {
            return "Required transaction context is missing or needs review before signing.";
        }
        if ("blocked".equals(value)) return "A blocking risk rule prevents signing.";
        if ("network_disabled".equals(value)) return "The target network must be enabled and verified before signing.";
        if ("broadcasting".equals(value) || "signed_locally".equals(value)) return "This request is already signed or broadcasting.";
        if ("failed".equals(value)) return "Failed requests cannot be signed again. Retry broadcast or replace the request.";
        if ("confirmed".equals(value) || "rejected".equals(value) || "cancelled".equals(value)) return "This request is final and cannot be signed.";
        return "This payment request is not in a signable state.";
    }

    private boolean requireWallet() {
        if (wallet == null) {
            toast("Generate or load a wallet first");
            return false;
        }
        return true;
    }

    private boolean isPayableIntent(PaymentIntent intent) {
        return PaymentIntent.STATUS_PENDING.equals(intent.status) && !intent.isExpired();
    }

    private View statusNoticeForIntent(PaymentIntent intent) {
        String message = intent.isExpired()
                ? "This payment request has expired."
                : "This payment request is already " + intent.status + ".";
        return warning(message);
    }

    private String shortAddress(String value) {
        if (value == null) return "";
        if (value.length() <= 18) return value;
        return value.substring(0, 10) + "..." + value.substring(value.length() - 8);
    }

    private String join(List<String> values) {
        StringBuilder out = new StringBuilder();
        for (String value : values) {
            if (out.length() > 0) out.append("; ");
            out.append(value);
        }
        return out.toString();
    }

    private void runAsync(String label, String asset, String network, String amount, String to, NetworkCall call) {
        toast(label + " started");
        new Thread(() -> {
            try {
                String result = call.run();
                try {
                    TransactionHistoryStore.record(
                            this,
                            result.length() > 0 ? "tx:" + result : "local:" + label + ":" + System.currentTimeMillis(),
                            label,
                            asset,
                            amount,
                            network,
                            to,
                            "broadcasted",
                            result
                    );
                } catch (Exception ignored) {
                }
                runOnUiThread(() -> {
                    resultSheet(label + " submitted", result);
                    refreshBalancesAfterPayment();
                });
            } catch (Exception e) {
                runOnUiThread(() -> error(label + " failed", e));
            }
        }).start();
    }

    private void refreshBalancesAfterPayment() {
        scheduleBalanceRefresh(0);
        scheduleBalanceRefresh(4_000);
        scheduleBalanceRefresh(12_000);
    }

    private void scheduleBalanceRefresh(long delayMs) {
        mainHandler.postDelayed(this::refreshBalancesSilently, delayMs);
    }

    private void refreshBalancesSilently() {
        if (wallet == null || balanceRefreshInFlight) return;
        HDWallet current = wallet;
        balanceRefreshInFlight = true;
        if (TAB_WALLET.equals(activeTab)) renderWalletTab();
        new Thread(() -> {
            try {
                JSONObject balances = BalanceFetcher.fetch(current);
                BalanceStore.save(this, balances);
                runOnUiThread(() -> {
                    balanceRefreshInFlight = false;
                    if (TAB_WALLET.equals(activeTab)) renderWalletTab();
                });
            } catch (Exception ignored) {
                runOnUiThread(() -> {
                    balanceRefreshInFlight = false;
                    if (TAB_WALLET.equals(activeTab)) renderWalletTab();
                });
            }
        }).start();
    }

    private void resultSheet(String heading, String result) {
        LinearLayout body = sheetBase(heading);
        body.addView(field("Transaction result", result, true));
        body.addView(primaryButton("Done", this::closeActiveSheet));
        showSheet(body);
    }

    private void paymentProgressSheet(String heading, String message, String detail) {
        LinearLayout body = sheetBase(heading);
        body.addView(text(message, 15, INK_SOFT, false));
        if (isUseful(detail)) {
            addGap(body, 10);
            body.addView(field("Local transaction", detail, false));
        }
        showSheet(body);
    }

    private void authenticate(String title, String subtitle, Runnable onSuccess) {
        authenticate(title, subtitle, onSuccess, null);
    }

    private void authenticate(String title, String subtitle, Runnable onSuccess, Runnable onCancel) {
        authenticate(title, subtitle, onSuccess, onCancel, onCancel);
    }

    private void authenticate(String title, String subtitle, Runnable onSuccess, Runnable onCancel, Runnable onFailure) {
        int authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        BiometricManager manager = BiometricManager.from(this);
        int can = manager.canAuthenticate(authenticators);
        if (can != BiometricManager.BIOMETRIC_SUCCESS) {
            toast("Biometric or device credential is not available");
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
                if (isAuthenticationCancel(errorCode)) {
                    if (onCancel != null) {
                        onCancel.run();
                    } else {
                        toast("Authentication cancelled");
                    }
                } else if (onFailure != null) {
                    onFailure.run();
                } else if (onCancel != null) {
                    onCancel.run();
                } else {
                    toast("Authentication failed");
                }
            }
        });
        BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setAllowedAuthenticators(authenticators)
                .build();
        prompt.authenticate(info);
    }

    private boolean isAuthenticationCancel(int errorCode) {
        return errorCode == BiometricPrompt.ERROR_CANCELED
                || errorCode == BiometricPrompt.ERROR_USER_CANCELED
                || errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON;
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
        }
    }

    private void startRelayPushService() {
        requestNotificationPermissionIfNeeded();
        Intent intent = new Intent(this, RelayPushService.class);
        ContextCompat.startForegroundService(this, intent);
    }

    private void notifyPendingIntents(List<PaymentIntent> intents) {
        for (PaymentIntent intent : intents) {
            if (PaymentIntent.STATUS_PENDING.equals(intent.status) && !intent.isExpired()) {
                PaymentNotifications.notifyPaymentIntent(this, intent);
            }
        }
    }

    private void updateStatus() {
        if (status == null) return;
        status.setText(SecureWalletStore.hasWallet(this)
                ? "Ready"
                : "No wallet");
        boolean ready = SecureWalletStore.hasWallet(this);
        status.setTextColor(ready ? GREEN : MUTED);
        status.setBackground(round(ready ? GREEN_SOFT : SOFT, dp(18), Color.TRANSPARENT, 0));
    }

    private View emptyState() {
        LinearLayout card = card();
        card.addView(text("No wallet loaded", 22, INK, true));
        addGap(card, 6);
        card.addView(text("Generate a new BIP39 wallet or restore from an existing mnemonic. Secrets are encrypted with Android Keystore.", 14, MUTED, false));
        addGap(card, 12);
        card.addView(warning("Mainnet transfers are real. Use testnet RPC endpoints until you are confident."));
        return card;
    }

    private View field(String label, String value, boolean copy) {
        LinearLayout box = vertical();
        box.setPadding(0, dp(12), 0, 0);
        LinearLayout head = row();
        head.addView(text(label, 12, MUTED, true), new LinearLayout.LayoutParams(0, -2, 1));
        if (copy) {
            TextView c = pill("Copy", BLUE, BLUE_SOFT, Color.TRANSPARENT);
            c.setTextSize(10);
            c.setOnClickListener(v -> copy(label, value));
            head.addView(c);
        }
        box.addView(head);
        addGap(box, 6);
        TextView body = text(value, 13, INK, false);
        body.setTypeface(Typeface.MONOSPACE);
        body.setTextIsSelectable(true);
        body.setPadding(dp(12), dp(10), dp(12), dp(10));
        body.setBackground(round(SUNKEN, dp(14), LINE, 1));
        box.addView(body);
        return box;
    }

    private EditText input(String hint) {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint(hint);
        input.setHintTextColor(MUTED);
        input.setTextColor(INK);
        input.setTextSize(15);
        input.setSelectAllOnFocus(false);
        input.setPadding(dp(14), 0, dp(14), 0);
        input.setBackground(round(SURFACE, dp(14), LINE_STRONG, 1));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, dp(52));
        lp.bottomMargin = dp(10);
        input.setLayoutParams(lp);
        return input;
    }

    private CheckBox checkbox(String label, boolean checked) {
        CheckBox box = new CheckBox(this);
        box.setText(label);
        box.setTextColor(INK);
        box.setTextSize(13);
        box.setChecked(checked);
        box.setPadding(0, dp(2), 0, dp(8));
        return box;
    }

    private TextView warning(String value) {
        TextView warning = text(value, 13, Color.rgb(132, 114, 45), true);
        warning.setPadding(dp(14), dp(12), dp(14), dp(12));
        warning.setBackground(round(AMBER_SOFT, dp(16), Color.rgb(231, 220, 170), 1));
        return warning;
    }

    private LinearLayout card() {
        LinearLayout card = vertical();
        card.setPadding(dp(18), dp(18), dp(18), dp(18));
        card.setBackground(round(SURFACE, dp(24), LINE, 1));
        card.setElevation(dp(2));
        return card;
    }

    private LinearLayout sheetBase(String heading) {
        LinearLayout body = vertical();
        body.setPadding(dp(20), dp(16), dp(20), dp(22));
        body.setBackground(round(BG, dp(28), 0, 0));
        TextView grab = new TextView(this);
        grab.setBackground(round(Color.rgb(167, 178, 171), dp(3), 0, 0));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(48), dp(5));
        lp.gravity = Gravity.CENTER_HORIZONTAL;
        body.addView(grab, lp);
        addGap(body, 14);
        body.addView(text(heading, 24, INK, true));
        addGap(body, 14);
        return body;
    }

    private void showSheet(View body) {
        closeActiveSheet();
        AlertDialog dialog = new AlertDialog.Builder(this).create();
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(false);
        scroll.addView(body);
        dialog.setView(scroll);
        dialog.setOnDismissListener(d -> {
            if (activeSheet == dialog) activeSheet = null;
        });
        dialog.setOnShowListener(d -> {
            Window w = dialog.getWindow();
            if (w != null) {
                w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
                w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, (int) (getResources().getDisplayMetrics().heightPixels * 0.88f));
                w.setGravity(Gravity.BOTTOM);
            }
        });
        dialog.show();
        Window w = dialog.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, (int) (getResources().getDisplayMetrics().heightPixels * 0.88f));
            w.setGravity(Gravity.BOTTOM);
        }
        activeSheet = dialog;
    }

    private void closeActiveSheet() {
        if (activeSheet == null) return;
        AlertDialog dialog = activeSheet;
        activeSheet = null;
        if (dialog.isShowing()) dialog.dismiss();
    }

    private Button primaryButton(String label, Runnable action) {
        return button(label, Color.WHITE, GREEN, GREEN, action);
    }

    private Button goldButton(String label, Runnable action) {
        return button(label, Color.rgb(42, 36, 16), GOLD, GOLD, action);
    }

    private Button outlineButton(String label, Runnable action) {
        return button(label, INK, SURFACE, LINE_STRONG, action);
    }

    private Button dangerButton(String label, Runnable action) {
        return button(label, Color.WHITE, RED, RED, action);
    }

    private Button button(String label, int fg, int bg, int border, Runnable action) {
        Button b = new Button(this);
        b.setAllCaps(false);
        b.setText(label);
        b.setTextSize(14);
        b.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        b.setTextColor(fg);
        b.setIncludeFontPadding(false);
        b.setMinHeight(dp(48));
        b.setMinimumHeight(dp(48));
        b.setPadding(dp(14), 0, dp(14), 0);
        b.setBackground(round(bg, dp(24), border, border == Color.TRANSPARENT ? 0 : 1));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            b.setStateListAnimator(null);
        }
        b.setOnClickListener(v -> action.run());
        return b;
    }

    private TextView text(String value, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(value);
        t.setTextSize(sp);
        t.setTextColor(color);
        t.setIncludeFontPadding(true);
        t.setLineSpacing(0, sp >= 20 ? 1.06f : 1.22f);
        if (bold) t.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return t;
    }

    private TextView sectionEyebrow(String value) {
        TextView t = text(value.toUpperCase(), 11, FADED, true);
        t.setLetterSpacing(0.08f);
        return t;
    }

    private TextView pill(String value, int fg, int bg, int border) {
        TextView t = text(value, 12, fg, true);
        t.setGravity(Gravity.CENTER);
        t.setIncludeFontPadding(false);
        t.setPadding(dp(11), dp(6), dp(11), dp(6));
        t.setBackground(round(bg, dp(999), border, border == Color.TRANSPARENT ? 0 : 1));
        return t;
    }

    private Button quickActionButton(String label, Runnable action) {
        Button b = button(label, INK, SOFT, Color.TRANSPARENT, action);
        b.setTextSize(13);
        return b;
    }

    private Button compactButton(String label, Runnable action) {
        Button b = button(label, GREEN, GREEN_SOFT, Color.TRANSPARENT, action);
        b.setTextSize(12);
        b.setMinHeight(dp(34));
        b.setMinimumHeight(dp(34));
        b.setPadding(dp(12), 0, dp(12), 0);
        return b;
    }

    private ImageView qrImage(String value) {
        ImageView image = new ImageView(this);
        image.setAdjustViewBounds(true);
        image.setPadding(dp(16), dp(16), dp(16), dp(16));
        image.setBackground(round(SURFACE, dp(24), LINE, 1));
        try {
            image.setImageBitmap(qrBitmap(value, dp(220)));
        } catch (Exception e) {
            image.setImageDrawable(null);
        }
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(252), dp(252));
        lp.gravity = Gravity.CENTER_HORIZONTAL;
        image.setLayoutParams(lp);
        return image;
    }

    private ImageView remoteImage(String url, int widthDp, int heightDp, int radiusDp) {
        ImageView image = new ImageView(this);
        image.setScaleType(ImageView.ScaleType.CENTER_CROP);
        image.setBackground(round(SUNKEN, dp(radiusDp), LINE, 1));
        image.setClipToOutline(true);
        image.setTag(url);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(widthDp > 0 ? dp(widthDp) : -1, dp(heightDp));
        image.setLayoutParams(lp);
        loadRemoteImage(url, image, dp(Math.max(widthDp > 0 ? widthDp : 180, heightDp) * 2));
        return image;
    }

    private void loadRemoteImage(String url, ImageView target, int maxSizePx) {
        if (!isUseful(url)) return;
        Bitmap cached = imageCache.get(url);
        if (cached != null) {
            target.setImageBitmap(cached);
            return;
        }
        new Thread(() -> {
            try {
                Request request = new Request.Builder().url(url).build();
                try (Response response = IMAGE_HTTP.newCall(request).execute()) {
                    if (!response.isSuccessful() || response.body() == null) return;
                    byte[] bytes = response.body().bytes();
                    Bitmap bitmap = decodeRemoteBitmap(bytes, maxSizePx);
                    if (bitmap == null) return;
                    imageCache.put(url, bitmap);
                    runOnUiThread(() -> {
                        Object tag = target.getTag();
                        if (tag != null && url.equals(tag.toString())) target.setImageBitmap(bitmap);
                    });
                }
            } catch (Exception ignored) {
            }
        }).start();
    }

    private Bitmap decodeRemoteBitmap(byte[] bytes, int maxSizePx) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        int sample = 1;
        while (bounds.outWidth / sample > maxSizePx || bounds.outHeight / sample > maxSizePx) {
            sample *= 2;
        }
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = Math.max(1, sample);
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, opts);
    }

    private Bitmap qrBitmap(String value, int size) throws Exception {
        BitMatrix matrix = new QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, size, size);
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        for (int y = 0; y < size; y++) {
            for (int x = 0; x < size; x++) {
                bitmap.setPixel(x, y, matrix.get(x, y) ? Color.BLACK : Color.WHITE);
            }
        }
        return bitmap;
    }

    private void setIfPresent(EditText input, String value) {
        if (value != null && value.trim().length() > 0) input.setText(value.trim());
    }

    private TextView tokenGlyph(String symbol, String key) {
        TextView glyph = text(tokenShort(symbol, key), 13, Color.WHITE, true);
        glyph.setGravity(Gravity.CENTER);
        glyph.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        int color = chainColor(key);
        glyph.setTextColor(color == CHAIN_SOL ? DARK : Color.WHITE);
        glyph.setBackground(round(color, dp(21), Color.TRANSPARENT, 0));
        return glyph;
    }

    private String tokenShort(String symbol, String key) {
        if (key != null && key.contains("polygon")) return "P";
        if (key != null && key.contains("base_usdc")) return "U";
        if (symbol == null || symbol.length() == 0) return "?";
        return symbol.substring(0, 1);
    }

    private int chainColor(String key) {
        if (key == null) return GREEN;
        if (key.contains("sol")) return CHAIN_SOL;
        if (key.contains("xlm")) return CHAIN_STELLAR;
        if (key.contains("base")) return CHAIN_BASE;
        if (key.contains("polygon")) return CHAIN_POLYGON;
        if (key.contains("eth")) return CHAIN_ETH;
        return GREEN;
    }

    private int statusColor(String status) {
        String value = status == null ? "" : status.toLowerCase();
        if (value.contains("error") || value.contains("failed") || value.contains("reject") || value.contains("expired")
                || value.contains("blocked") || value.contains("danger") || value.contains("disabled")
                || value.contains("cancelled")) return RED;
        if (value.contains("missing") || value.contains("review") || value.contains("pending")
                || value.contains("inactive") || value.contains("signed") || value.contains("caution")) return GOLD;
        if (value.contains("broadcast") || value.contains("complete") || value.contains("paid")
                || value.contains("confirmed") || value.contains("safe") || value.contains("ready")) return GREEN;
        return GREEN;
    }

    private String valueOr(String primary, String fallback) {
        return isUseful(primary) ? primary : fallback;
    }

    private String joinDisplay(String first, String second) {
        if (!isUseful(first)) return isUseful(second) ? second : "";
        if (!isUseful(second)) return first;
        return first + " / " + second;
    }

    private boolean isUseful(String value) {
        if (value == null) return false;
        String clean = value.trim();
        return clean.length() > 0 && !"null".equalsIgnoreCase(clean);
    }

    private int statusBarHeight() {
        int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
        return id > 0 ? getResources().getDimensionPixelSize(id) : dp(24);
    }

    private LinearLayout row() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        return row;
    }

    private LinearLayout vertical() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private LinearLayout.LayoutParams weight() {
        return new LinearLayout.LayoutParams(0, dp(48), 1);
    }

    private LinearLayout.LayoutParams weightLeft() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(48), 1);
        lp.leftMargin = dp(10);
        return lp;
    }

    private void addGap(LinearLayout parent, int sizeDp) {
        TextView gap = new TextView(this);
        parent.addView(gap, new LinearLayout.LayoutParams(1, dp(sizeDp)));
    }

    private GradientDrawable round(int color, int radius, int strokeColor, int strokeWidthDp) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(radius);
        if (strokeWidthDp > 0) d.setStroke(dp(strokeWidthDp), strokeColor);
        return d;
    }

    private void copy(String label, String value) {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        clipboard.setPrimaryClip(ClipData.newPlainText(label, value));
        toast(label + " copied");
    }

    private void error(String heading, Exception e) {
        LinearLayout body = sheetBase(heading);
        body.addView(text(e.getClass().getSimpleName() + ": " + trimError(e.getMessage()), 13, RED, true));
        body.addView(primaryButton("Done", this::closeActiveSheet));
        showSheet(body);
    }

    private String trimError(String message) {
        if (message == null || message.trim().length() == 0) return "Unknown error";
        String clean = message.replace('\n', ' ').replace('\r', ' ').trim();
        return clean.length() <= 900 ? clean : clean.substring(0, 900) + "...";
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private static final class PairingLink {
        final String idOrCode;
        final String code;
        final String sourceLabel;

        PairingLink(String idOrCode, String code, String sourceLabel) {
            this.idOrCode = idOrCode == null ? "" : idOrCode;
            this.code = code == null ? "" : code;
            this.sourceLabel = sourceLabel == null ? "" : sourceLabel;
        }
    }

    private static final class ScannedPayment {
        String network = "";
        String asset = "";
        String to = "";
        String amount = "";
        String chainId = "";
        String rpcUrl = "";
        String horizonUrl = "";
        String tokenContract = "";
        String assetIssuer = "";
        String decimals = "";
        boolean stellarTestnet;

        boolean isStellar() {
            return network.toLowerCase().contains("stellar") || to.matches("^G[A-Z2-7]{55}$");
        }

        boolean isEvm() {
            return network.toLowerCase().contains("evm")
                    || network.toLowerCase().contains("base")
                    || network.toLowerCase().contains("polygon")
                    || network.toLowerCase().contains("ethereum")
                    || to.matches("^0x[0-9a-fA-F]{40}$");
        }

        boolean isSolana() {
            return network.toLowerCase().contains("solana")
                    || (to.matches("^[1-9A-HJ-NP-Za-km-z]{32,44}$") && !isStellar() && !isEvm());
        }
    }

    private interface NetworkCall {
        String run() throws Exception;
    }
}
