// WalletConnect as one more wallet source, shaped like an injected extension
// (window.injectedWeb3[key]) so the rest of the explorer does not change:
//
//   provider.enable() -> { accounts: { get() }, signer }
//
// script.js lists these accounts with the extensions' (source 'walletconnect'),
// resolves this signer for them, and tx-submit, the fee preflight, stillValid
// and the discussion sign-in (signRaw) run as they do for an extension.
//
// Loaded only by lib/walletconnect-gate.js, with a dynamic import, and it
// loads @walletconnect/universal-provider the same way: both end up in lazy
// chunks of the build.
//
// The signer gets the chain's metadata hash from getApi() (lib/metadata-hash.js),
// read once the phone is paired so the first signature does not wait for it.
// debug (?wcdebug=1): a failed signature check is logged to the console and
// shown as a copyable block, with the wallet's public name, url, description
// and version added (never the session topic or keys).
//
// Tested in test/walletconnect.test.js.

import { createWalletConnectSession, WC_CANCELLED } from './walletconnect-session.js';
import { createWalletConnectSigner } from './walletconnect-signer.js';
import { mountPairingPanel, showPendingNotice, showDebugReport } from './walletconnect-view.js';
import { createMetadataHashSource } from './metadata-hash.js';
import { debugReportText } from './walletconnect-debug.js';
import { escapeHtml } from './html-escape.js';

const defaultLoadProvider = () => import('@walletconnect/universal-provider').then(m => m.UniversalProvider || m.default);

// deps: { doc, getRegistry, getApi, isMobile, clipboard, debug, onEnded(reason), onAccounts(list), loadProvider? }
export function createWalletConnectSource({ doc, getRegistry, getApi = () => null, isMobile = () => false, clipboard, debug = false, onEnded = () => {}, onAccounts = () => {}, loadProvider = defaultLoadProvider }) {
    let ending = false;
    let signer = null;
    // A session that ends (on the phone, by expiry, or by our own disconnect)
    // cancels every signing request still waiting, which also removes its
    // "Approve on your phone" notice.
    const cancelPending = () => { if (signer) signer.cancelAll(); };
    const session = createWalletConnectSession({
        loadProvider,
        onChange: (c) => {
            if (c.reason === 'ended') { cancelPending(); if (!ending) onEnded('ended'); }
            else if (c.reason === 'accounts') onAccounts(c.accounts);
        }
    });
    const metadataHash = createMetadataHashSource({ getApi });
    const prefetchHash = () => { metadataHash.get().catch(() => {}); };
    const report = (r) => {
        const text = debugReportText({ ...r, metadataHashError: r.metadataHashError || metadataHash.lastError() || null, wallet: session.peerInfo() });
        console.warn('[walletconnect debug] ' + text);
        if (doc) showDebugReport(doc, { text, clipboard });
    };
    signer = createWalletConnectSigner({
        request: (method, params) => session.request(method, params),
        getRegistry,
        getMetadataHash: () => metadataHash.get(),
        onPending: ({ kind, cancel }) => (doc ? showPendingNotice(doc, { kind, cancel }) : null),
        onVerifyFailure: debug ? report : undefined
    });
    const accountName = () => (session.peerName() ? session.peerName() + ' account' : 'Phone wallet account');
    const provider = {
        enable: async () => ({
            accounts: { get: async () => session.accounts().map(a => ({ address: a.address, name: accountName() })) },
            signer
        })
    };

    async function connect(panel) {
        let view = null;
        if (panel) { panel.hidden = false; panel.innerHTML = '<p class="wc-status" role="status">Starting WalletConnect...</p>'; }
        try {
            const list = await session.connect({
                onUri: (uri) => {
                    if (!panel) return;
                    view = mountPairingPanel(panel, { uri, onMobile: isMobile(), clipboard, onCancel: () => session.cancelConnect() });
                }
            });
            if (panel) panel.innerHTML = `<p class="wc-status" role="status">Connected to ${escapeHtml(session.peerName() || 'your phone wallet')}. Choose an account below.</p>`;
            prefetchHash();
            return list;
        } catch (e) {
            if (panel) {
                if (view) view.close();
                const msg = e && e.message === WC_CANCELLED ? '' : ((e && e.message) || 'Could not connect your phone wallet.');
                panel.innerHTML = msg ? `<p class="wc-status wc-error" role="alert">${escapeHtml(msg)}</p>` : '';
                if (!msg) panel.hidden = true;
            }
            throw e;
        }
    }

    async function disconnect() {
        ending = true;
        try { await session.disconnect(); } finally { ending = false; cancelPending(); }
    }

    return {
        provider, connect, disconnect,
        restore: () => session.restore().then((list) => { if (list.length) prefetchHash(); return list; }),
        isConnected: () => session.isConnected(),
        peerName: () => session.peerName()
    };
}
