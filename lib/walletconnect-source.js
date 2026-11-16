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
// Tested in test/walletconnect.test.js.

import { createWalletConnectSession, WC_CANCELLED } from './walletconnect-session.js';
import { createWalletConnectSigner } from './walletconnect-signer.js';
import { mountPairingPanel, showPendingNotice } from './walletconnect-view.js';
import { escapeHtml } from './html-escape.js';

const defaultLoadProvider = () => import('@walletconnect/universal-provider').then(m => m.UniversalProvider || m.default);

// deps: { doc, getRegistry, isMobile, clipboard, onEnded(reason), onAccounts(list), loadProvider? }
export function createWalletConnectSource({ doc, getRegistry, isMobile = () => false, clipboard, onEnded = () => {}, onAccounts = () => {}, loadProvider = defaultLoadProvider }) {
    let ending = false;
    const session = createWalletConnectSession({
        loadProvider,
        onChange: (c) => {
            if (c.reason === 'ended') { if (!ending) onEnded('ended'); }
            else if (c.reason === 'accounts') onAccounts(c.accounts);
        }
    });
    const signer = createWalletConnectSigner({
        request: (method, params) => session.request(method, params),
        getRegistry,
        onPending: ({ kind, cancel }) => (doc ? showPendingNotice(doc, { kind, cancel }) : null)
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
        try { await session.disconnect(); } finally { ending = false; }
    }

    return {
        provider, connect, disconnect,
        restore: () => session.restore(),
        isConnected: () => session.isConnected(),
        peerName: () => session.peerName()
    };
}
