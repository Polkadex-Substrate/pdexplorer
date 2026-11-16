// The flag and the lazy loader for "Connect with your phone" (WalletConnect).
//
// This module is in the eager bundle and must stay small: it holds no
// WalletConnect code. The WalletConnect source (lib/walletconnect-source.js,
// which pulls in @walletconnect/universal-provider) is a dynamic import, so a
// visitor who never asks for it downloads none of it and the page never dials
// the relay. Two things load it: a click on Connect with your phone, or a
// session made earlier in this browser (pdex_wc_session) that the page restores
// on start.
//
// On when FEATURE_FLAGS.walletConnect is true (everyone), or per browser:
// ?wc=1 stores pdex_wc_enabled=1, ?wc=0 removes it.
//
// Tested in test/walletconnect.test.js.

import { WC_FLAG_KEY, WC_SESSION_HINT_KEY, WC_SOURCE } from './walletconnect-config.js';

function safeGet(storage, key) { try { return storage.getItem(key) || ''; } catch (e) { return ''; } }
function safeSet(storage, key, value) { try { storage.setItem(key, value); } catch (e) { /* private mode, full quota */ } }
function safeDel(storage, key) { try { storage.removeItem(key); } catch (e) { /* ignore */ } }

export function walletConnectEnabled({ flag = false, storage, search = '' }) {
    let param = null;
    try { param = new URLSearchParams(search || '').get('wc'); } catch (e) { param = null; }
    if (param === '1') safeSet(storage, WC_FLAG_KEY, '1');
    else if (param === '0') safeDel(storage, WC_FLAG_KEY);
    if (flag) return true;
    return safeGet(storage, WC_FLAG_KEY) === '1';
}

// deps go to createWalletConnectSource (doc, getRegistry, isMobile, clipboard).
// onEnded(): the phone ended the session, or it expired. onAccounts(list): the
// accounts the phone shares, after a restore or a change.
export function createWalletConnectGate({ enabled, storage, deps = {}, onEnded = () => {}, onAccounts = () => {}, load = () => import('./walletconnect-source.js') }) {
    let source = null;
    let loading = null;

    function ensure() {
        if (!enabled) return Promise.reject(new Error('WalletConnect is not enabled in this browser.'));
        if (source) return Promise.resolve(source);
        if (!loading) {
            loading = Promise.resolve().then(load).then((mod) => {
                source = mod.createWalletConnectSource({
                    ...deps,
                    onEnded: (reason) => { safeDel(storage, WC_SESSION_HINT_KEY); onEnded(reason); },
                    onAccounts: (list) => onAccounts(list)
                });
                return source;
            }).catch((e) => { loading = null; throw e; });
        }
        return loading;
    }

    return {
        enabled: !!enabled,
        // The source as an injected-extension lookalike, only while paired.
        providers() { return source && source.isConnected() ? { [WC_SOURCE]: source.provider } : {}; },
        isConnected() { return !!source && source.isConnected(); },
        peerName() { return source ? source.peerName() : ''; },
        async restore() {
            if (!enabled || safeGet(storage, WC_SESSION_HINT_KEY) !== '1') return [];
            const s = await ensure();
            const list = await s.restore();
            if (!list.length) { safeDel(storage, WC_SESSION_HINT_KEY); onEnded('expired'); return []; }
            onAccounts(list);
            return list;
        },
        // panel: the element the pairing QR is drawn in.
        async connect(panel) {
            const s = await ensure();
            const list = await s.connect(panel);
            safeSet(storage, WC_SESSION_HINT_KEY, '1');
            return list;
        },
        async disconnect() {
            safeDel(storage, WC_SESSION_HINT_KEY);
            if (source) await source.disconnect();
        }
    };
}
