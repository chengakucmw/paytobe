/*
 * VelarumPay native bridge adapter.
 *
 * This file runs AFTER the prototype's inline <script>, in the same classic-script
 * global scope, so it can read/patch the prototype globals (state, assetCatalog,
 * render, REQUEST_ORDER, handleScannedQrPayload, ...).
 *
 * When loaded in a plain browser (no window.VPNative) it does nothing, so the
 * prototype keeps working as a standalone demo. Inside the Android WebView the
 * native host injects two interfaces:
 *   - VPNative              (wallet data, send, wallet lifecycle)
 *   - VelarumPayNativeScan  (camera QR scanning; already expected by the prototype)
 */
(function () {
  'use strict';

  var N = window.VPNative;
  if (!N) return; // browser preview: keep prototype demo behaviour

  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }
  function rerender() { safe(function () { if (typeof render === 'function') render(); }); }
  function hasGlobal(name) { try { return typeof eval(name) !== 'undefined'; } catch (e) { return false; } }

  // BalanceStore key -> prototype asset (symbol + chain) for the assets this build can actually use.
  var BAL_MAP = {
    xlm:           { sym: 'XLM',  chain: 'Stellar',     family: 'stellar' },
    sol:           { sym: 'SOL',  chain: 'Solana',      family: 'solana' },
    eth:           { sym: 'ETH',  chain: 'Ethereum',    family: 'evm' },
    base_usdc:     { sym: 'USDC', chain: 'Base',        family: 'evm' },
    polygon_matic: { sym: 'POL',  chain: 'Polygon PoS', family: 'evm' }
  };
  // Home assets shown by default (real, sendable).
  var HOME_PAIRS = [['XLM', 'Stellar'], ['SOL', 'Solana'], ['ETH', 'Ethereum'], ['USDC', 'Base']];

  function findAsset(sym, chain) {
    if (!hasGlobal('assetCatalog')) return null;
    for (var i = 0; i < assetCatalog.length; i++) {
      if (assetCatalog[i].symbol === sym && assetCatalog[i].chain === chain) return assetCatalog[i];
    }
    return null;
  }

  // ---- safety net: the HTML ships with no demo data, but force a clean
  // zero/empty baseline before real wallet data arrives so nothing stale shows.
  function neutralizeDemo() {
    safe(function () {
      if (hasGlobal('REQUEST_ORDER') && Array.isArray(REQUEST_ORDER)) REQUEST_ORDER.splice(0);
      if (hasGlobal('assetCatalog') && Array.isArray(assetCatalog)) {
        assetCatalog.forEach(function (a) {
          if (a.balance && a.balance !== 'Not added') a.balance = '0';
        });
      }
      if (typeof state === 'object' && state) {
        state.walletId = '';
        state.walletName = 'My Wallet';
        state.avatarInitial = 'V';
        state.paired = false;
        state.backupSaved = false;
        if (state.manualDraft) { state.manualDraft.recipient = ''; state.manualDraft.amount = ''; state.manualDraft.memo = ''; }
        if (typeof assetKey === 'function' && hasGlobal('assetCatalog')) {
          var keys = [];
          HOME_PAIRS.forEach(function (p) {
            var a = findAsset(p[0], p[1]);
            if (a) keys.push(assetKey(a));
          });
          if (keys.length) state.displayedAssetKeys = keys;
        }
      }
    });
  }

  // ---- apply real wallet data coming from native ----
  function applyData(data) {
    if (!data) return;
    safe(function () {
      if (typeof state === 'object' && state) {
        state.backupSaved = !!data.backupVerified;
        if (data.identity) {
          if (data.identity.walletId) state.walletId = data.identity.walletId;
          if (data.identity.walletName) state.walletName = data.identity.walletName;
          if (data.identity.avatar) state.avatarInitial = data.identity.avatar;
        }
      }
      var addrs = data.addresses || {};
      if (hasGlobal('assetCatalog') && Array.isArray(assetCatalog)) {
        assetCatalog.forEach(function (a) {
          if (a.family === 'evm' && addrs.evm) a.address = addrs.evm;
          else if (a.family === 'solana' && addrs.solana) a.address = addrs.solana;
          else if (a.family === 'stellar' && addrs.stellar) a.address = addrs.stellar;
        });
        var bals = data.balances || {};
        Object.keys(BAL_MAP).forEach(function (k) {
          var m = BAL_MAP[k], b = bals[k];
          if (!b) return;
          var target = findAsset(m.sym, m.chain);
          if (!target) return;
          if (b.status === 'inactive' || b.status === 'error') target.balance = '0';
          else if (b.balance != null && b.balance !== '') target.balance = String(b.balance);
        });
      }
    });
    rerender();
    if (!data.hasWallet) showOnboarding(); else hideOnboarding();
  }

  function loadWalletData() {
    var raw = safe(function () { return N.walletData(); }, null);
    if (!raw) { showOnboarding(); return; }
    var data = safe(function () { return JSON.parse(raw); }, null);
    applyData(data);
  }

  // native pushes refreshed data here
  window.__vpOnData = function (json) {
    var data = safe(function () { return typeof json === 'string' ? JSON.parse(json) : json; }, null);
    if (data) applyData(data);
  };

  // ---------------- real send ----------------
  function sendDescriptor(d) {
    if (!d) return null;
    var token = (d.token || d.symbol || '').toString();
    var network = (d.network || d.chain || '').toString();
    var to = (d.recipient || d.to || '').toString();
    var amount = (d.amount || '').toString();
    var memo = (d.memo || '').toString();
    if (!to || !amount) return null;
    return { symbol: token, network: network, to: to, amount: amount, memo: memo };
  }

  function doRealSend(kind) {
    var d = null;
    if (kind === 'scan') d = safe(function () { return typeof currentScannedPayment === 'function' ? currentScannedPayment() : (state && state.scanPayment); });
    else d = safe(function () { return state && state.manualDraft; });
    var desc = sendDescriptor(d);
    if (!desc) { safe(function () { showToast('Missing details', 'Enter a recipient and amount first.', true); }); return; }
    window.__vpSendKind = kind;
    safe(function () { showToast('Authorizing', 'Confirm on your device to sign and broadcast.'); });
    safe(function () { N.send(JSON.stringify(desc)); });
  }

  // native returns here after biometric + broadcast
  window.__vpOnSendResult = function (json) {
    var r = safe(function () { return typeof json === 'string' ? JSON.parse(json) : json; }, {}) || {};
    var kind = window.__vpSendKind;
    safe(function () {
      if (r.ok) {
        if (kind === 'scan') { if (state) state.scanTransferStatus = 'confirmed'; }
        else { if (state) { if (state.manualDraft) state.manualDraft.txHash = r.txHash || ''; state.manualStatus = 'confirmed'; } }
        rerender();
        showToast('Transfer confirmed', r.txHash ? ('Tx ' + String(r.txHash).slice(0, 10) + '...') : 'Broadcast to the network.');
      } else if (r.backupRequired) {
        showOnboarding('backup');
      } else {
        if (kind === 'scan') { if (state) state.scanTransferStatus = 'failed'; }
        else { if (state) state.manualStatus = 'failed'; }
        rerender();
        showToast('Transfer failed', r.error || 'The network did not accept the transaction.', true);
      }
    });
  };

  // intercept the prototype's mock sign/broadcast and run a real transfer instead
  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
    if (!t) return;
    var action = t.getAttribute('data-action');
    if (action === 'manual-sign' || action === 'manual-broadcast') {
      ev.stopImmediatePropagation(); ev.preventDefault();
      doRealSend('manual');
    } else if (action === 'scan-sign' || action === 'scan-broadcast') {
      ev.stopImmediatePropagation(); ev.preventDefault();
      doRealSend('scan');
    }
  }, true);

  // ---------------- onboarding (no wallet / backup) ----------------
  var GREEN = '#2f7d4f', INK = '#16201a', LINE = '#dbe6de', SOFT = '#eef5ef';
  function el(tag, css, html) { var e = document.createElement(tag); if (css) e.setAttribute('style', css); if (html != null) e.innerHTML = html; return e; }

  function overlayShell(title, subtitle) {
    hideOnboarding();
    var wrap = el('div', 'position:fixed;inset:0;z-index:99999;background:#e7efe9;display:flex;align-items:center;justify-content:center;padding:24px;font-family:-apple-system,Roboto,system-ui,sans-serif;');
    wrap.id = '__vpOnboard';
    var card = el('div', 'width:100%;max-width:380px;background:#fff;border:1px solid ' + LINE + ';border-radius:28px;padding:24px;box-shadow:0 24px 60px rgba(26,30,26,.14);');
    card.appendChild(el('div', 'display:inline-block;background:' + SOFT + ';color:' + GREEN + ';font-weight:700;font-size:13px;padding:8px 14px;border-radius:999px;', 'Local only'));
    card.appendChild(el('h1', 'font-size:30px;font-weight:800;color:' + INK + ';margin:16px 0 6px;', title));
    card.appendChild(el('p', 'color:#5b6a60;font-size:15px;margin:0 0 18px;line-height:1.5;', subtitle));
    wrap.appendChild(card);
    document.body.appendChild(wrap);
    return card;
  }
  function bigBtn(label, filled) {
    return el('button', 'display:block;width:100%;border:0;cursor:pointer;margin-top:12px;padding:15px;border-radius:999px;font-size:16px;font-weight:700;' +
      (filled ? ('background:' + GREEN + ';color:#fff;') : ('background:#fff;color:' + INK + ';border:1px solid ' + LINE + ';')), label);
  }
  function hideOnboarding() { var e = document.getElementById('__vpOnboard'); if (e) e.remove(); }

  function showOnboarding(mode) {
    if (mode === 'backup') { showBackup(); return; }
    var card = overlayShell('Welcome to VelarumPay', 'Create a new self-custody wallet or import an existing recovery phrase. Keys never leave this device.');
    var create = bigBtn('Create new wallet', true);
    create.onclick = function () { safe(function () { N.createWallet(); }); };
    var imp = bigBtn('Import recovery phrase', false);
    imp.onclick = showImport;
    card.appendChild(create); card.appendChild(imp);
  }

  function showImport() {
    var card = overlayShell('Import wallet', 'Paste a 12 / 15 / 18 / 21 / 24-word BIP-39 English recovery phrase from an offline backup.');
    var ta = el('textarea', 'width:100%;min-height:96px;border:1px solid ' + LINE + ';border-radius:16px;padding:12px;font-size:15px;box-sizing:border-box;');
    card.appendChild(ta);
    var go = bigBtn('Import to this device', true);
    go.onclick = function () { var p = ta.value.trim(); if (!p) return; safe(function () { N.importWallet(p); }); };
    var back = bigBtn('Back', false); back.onclick = function () { showOnboarding(); };
    card.appendChild(go); card.appendChild(back);
  }

  function showBackup() {
    var words = safe(function () { return JSON.parse(N.mnemonicWords()); }, []) || [];
    var card = overlayShell('Back up recovery phrase', 'Write these 24 words down in order and keep them offline. They are the only way to recover this wallet.');
    var grid = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;');
    words.forEach(function (w, i) {
      grid.appendChild(el('div', 'background:' + SOFT + ';border-radius:12px;padding:10px 12px;font-size:14px;color:' + INK + ';', '<span style="color:#8aa093">' + (i + 1) + '</span>&nbsp;&nbsp;<strong>' + w + '</strong>'));
    });
    card.appendChild(grid);
    var done = bigBtn('I have written it down', true);
    done.onclick = function () { safe(function () { N.confirmBackup(); }); };
    card.appendChild(done);
  }

  // native lifecycle callbacks
  window.__vpOnWalletCreated = function () { showBackup(); };
  window.__vpOnBackupDone = function () { hideOnboarding(); loadWalletData(); safe(function () { N.refreshBalances(); }); };
  window.__vpOnWalletImported = function () { hideOnboarding(); loadWalletData(); safe(function () { N.refreshBalances(); }); };
  window.__vpOnError = function (msg) { safe(function () { showToast('Something went wrong', msg || 'Please try again.', true); }); };

  // ---------------- boot ----------------
  neutralizeDemo();
  rerender();
  loadWalletData();
  safe(function () { if (N.hasWallet && N.hasWallet()) N.refreshBalances(); });
})();
