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
// On when FEATURE_FLAGS.walletConnect is true (everyone), unless this browser
// opted out: ?wc=0 stores pdex_wc_enabled=0 and wins over the flag; ?wc=1
// stores 1 (an opt-in when the flag is off, and it undoes an opt-out). The
// diagnostic mode: ?wcdebug=1 stores pdex_wc_debug=1, ?wcdebug=0 removes it.
//
// Tested in test/walletconnect.test.js.

import { WC_FLAG_KEY, WC_SESSION_HINT_KEY, WC_SOURCE, WC_DEBUG_KEY } from './walletconnect-config.js';

function safeGet(storage, key) { try { return storage.getItem(key) || ''; } catch (e) { return ''; } }
function safeSet(storage, key, value) { try { storage.setItem(key, value); } catch (e) { /* private mode, full quota */ } }
function safeDel(storage, key) { try { storage.removeItem(key); } catch (e) { /* ignore */ } }

// ?<name>=1 stores key, ?<name>=0 removes it; true while it is stored.
function optIn(storage, search, name, key) {
    let param = null;
    try { param = new URLSearchParams(search || '').get(name); } catch (e) { param = null; }
    if (param === '1') safeSet(storage, key, '1');
    else if (param === '0') safeDel(storage, key);
    return safeGet(storage, key) === '1';
}

export function walletConnectEnabled({ flag = false, storage, search = '' }) {
    let param = null;
    try { param = new URLSearchParams(search || '').get('wc'); } catch (e) { param = null; }
    if (param === '1' || param === '0') safeSet(storage, WC_FLAG_KEY, param);
    const stored = safeGet(storage, WC_FLAG_KEY);
    if (stored === '0') return false;
    return !!flag || stored === '1';
}

export function walletConnectDebugEnabled({ storage, search = '' }) {
    return optIn(storage, search, 'wcdebug', WC_DEBUG_KEY);
}

// deps go to createWalletConnectSource (doc, getRegistry, getApi, isMobile, clipboard, debug).
// onEnded(): the phone ended the session, or it expired. onAccounts(list): the
// accounts the phone shares, after a restore or a change.
export function createWalletConnectGate({ enabled, storage, deps = {}, onEnded = () => {}, onAccounts = () => {}, load = () => import('./walletconnect-source.js') }) {
    let source = null;
    let loading = null;
    // The connect attempt in progress: { cancelled }. One per attempt (issue
    // #71): a newer attempt must not clear an older attempt's cancel.
    let attempt = null;

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
            if (attempt) attempt.cancelled = true;   // a new attempt replaces the one before
            const mine = { cancelled: false };
            attempt = mine;
            try {
                const s = await ensure();
                if (mine.cancelled) throw new Error('Cancelled');
                const list = await s.connect(panel);
                // Cancelled in the moment between the phone's approval and here:
                // the session is not kept, and no hint is left to restore it.
                if (mine.cancelled) { await s.disconnect().catch(() => {}); throw new Error('Cancelled'); }
                safeSet(storage, WC_SESSION_HINT_KEY, '1');
                return list;
            } finally {
                if (attempt === mine) attempt = null;
            }
        },
        // The page's Back on the pairing view: stop waiting for the phone,
        // whether the WalletConnect code is still loading or pairing has begun.
        cancel() {
            if (attempt) attempt.cancelled = true;
            if (source && typeof source.cancelConnect === 'function') source.cancelConnect();
        },
        async disconnect() {
            safeDel(storage, WC_SESSION_HINT_KEY);
            if (source) await source.disconnect();
        }
    };
}
