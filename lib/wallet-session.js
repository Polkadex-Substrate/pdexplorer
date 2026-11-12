// Who is connected, and what it takes to change that.
//
// This is the state half of "Switch wallet" and "Disconnect". It lives in its
// own module, with storage and the discussion-session revoker passed in, so the
// whole lifecycle can be run under Node with a Map for a localStorage and fake
// injectedWeb3 providers. script.js is a 15k-line bundle with no export surface;
// the bug this module exists for was invisible there for exactly that reason.
//
// The bug (reported on /wallet, 26-27 Oct): "I am not able to switch to a new
// wallet." Four things were wrong together:
//
//   1. Disconnect did not stick. It set a ONE-SHOT sessionStorage flag that
//      stopped the auto-pick once. The next visit to /wallet (a reload, a new
//      tab, or just navigating away and back) found nothing stored, found an
//      unlocked extension, and silently re-selected the last-used account. The
//      user was "logged out" for exactly one page view.
//   2. /wallet redirected to /wallet/<stored> whenever anything was stored, so
//      the picker could not be opened without first destroying the selection.
//   3. Selecting a different account never touched the discussion session, so
//      the old address's bearer token stayed in storage and valid on the server.
//   4. A dashboard fetch still in flight when the user clicked Switch repainted
//      the dashboard over the picker (see walletFetchGen in script.js).
//
// So: Disconnect now writes a PERSISTENT opt-out, select() is the one place an
// opt-out is lifted. Cause 3 was first fixed by revoking on every switch; since
// 12 Nov the discussion tokens are kept per address instead (only the active
// account's is ever used), and Disconnect revokes them all.

export const WALLET_KEYS = Object.freeze({
    address: 'pdex_wallet_address',
    lastUsed: 'pdex_last_used_wallet_address',
    source: 'pdex_wallet_source',
    disconnected: 'pdex_wallet_disconnected'
});

// `storage` is localStorage-shaped (getItem / setItem / removeItem). Every call
// is wrapped: Safari private mode and a full quota both throw, and a wallet
// switch must not die halfway because a write failed.
function safeGet(storage, key) { try { return storage.getItem(key) || ''; } catch (e) { return ''; } }
function safeSet(storage, key, value) { try { storage.setItem(key, value); } catch (e) { /* ignore */ } }
function safeDel(storage, key) { try { storage.removeItem(key); } catch (e) { /* ignore */ } }

export function createWalletSession({ storage, toAddress = (a) => a, isSame = (a, b) => a === b, isValid = (a) => !!a, revokeDiscuss = () => {}, onChange = () => {} }) {
    const get = (k) => safeGet(storage, k);

    // The connected address in Polkadex form, '' when none. Legacy generic-SS58
    // values are coerced and rewritten, as the old getStoredWallet did.
    function connected() {
        const v = get(WALLET_KEYS.address);
        if (!v) return '';
        const pdex = toAddress(v);
        if (pdex && pdex !== v) { safeSet(storage, WALLET_KEYS.address, pdex); return pdex; }
        return v;
    }
    function source() { return get(WALLET_KEYS.source); }
    function lastUsed() { return get(WALLET_KEYS.lastUsed); }
    function isDisconnected() { return get(WALLET_KEYS.disconnected) === '1'; }

    // True when the page may pick an account for the user without being asked:
    // nothing is connected and the user has not said "disconnect".
    function mayAutoPick() { return !connected() && !isDisconnected(); }

    // ── The active account, for pages (lib/wallet-aware.js) ──
    // Restore from storage is synchronous, so a remembered account is
    // 'connected' as soon as this session exists. The one asynchronous restore
    // is the auto-pick asking the extension (tryAutoSelectFirstWallet); while it
    // runs the status is 'restoring', so a page can say "checking" rather than
    // flash a Connect prompt.
    const listeners = new Set();
    let restoring = false;
    function getActiveAccount() {
        const address = connected();
        return { address, source: address ? source() : '', status: address ? 'connected' : (restoring ? 'restoring' : 'none') };
    }
    let seen = getActiveAccount();   // what the listeners were last told
    function reasonFor(prev, next) {
        if (!prev.address && next.address) return 'connect';
        if (prev.address && !next.address) return 'disconnect';
        if (prev.address && !isSame(prev.address, next.address)) return 'switch-account';
        if (prev.address && prev.source !== next.source) return 'switch-extension';
        return 'restore';
    }
    // Tell the page listeners, once, if anything they can see changed. A
    // listener that throws must not stop the others or the switch itself.
    function announce(external = false) {
        const prev = seen, next = getActiveAccount();
        seen = next;
        if (prev.address === next.address && prev.source === next.source && prev.status === next.status) return null;
        const change = { reason: reasonFor(prev, next), previous: prev.address, previousSource: prev.source, current: next.address, source: next.source, status: next.status, external };
        for (const cb of Array.from(listeners)) { try { cb(change); } catch (e) { /* a page bug stays in that page */ } }
        return change;
    }
    // Returns the unsubscribe; calling it twice is harmless.
    function onActiveAccountChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; }
    function listenerCount() { return listeners.size; }
    function beginRestore() { if (restoring || !mayAutoPick()) return; restoring = true; announce(); }
    function endRestore() { if (!restoring) return; restoring = false; announce(); }
    // Another tab wrote the keys (the 'storage' event). Runs the same global
    // onChange a local switch does, then the page listeners, flagged external.
    function syncExternal() {
        const next = getActiveAccount();
        if (seen.address === next.address && seen.source === next.source) return null;
        onChange({ previous: seen.address, current: next.address, reason: 'external' });
        return announce(true);
    }

    // Connect (or switch to) an account. `src` is the extension key it came from
    // ('polkadot-js', 'talisman', 'subwallet-js'), '' for a typed-in address.
    // Returns { changed, previous }.
    function select(address, src = '') {
        if (!isValid(address)) return { changed: false, previous: connected(), rejected: true };
        const previous = connected();
        const next = toAddress(address);
        const addressChanged = !previous || !isSame(previous, next);
        const sourceChanged = (src || '') !== source();
        // No revoke here (changed 12 Nov): discussion tokens are kept per address
        // (lib/discussion-auth.js) and only ever used for their own account, so
        // switching back does not ask for a signature again. Disconnect revokes.
        safeSet(storage, WALLET_KEYS.address, next);
        if (src) safeSet(storage, WALLET_KEYS.source, src); else safeDel(storage, WALLET_KEYS.source);
        safeSet(storage, WALLET_KEYS.lastUsed, next);
        safeDel(storage, WALLET_KEYS.disconnected);   // an explicit choice lifts the opt-out
        restoring = false;
        const changed = addressChanged || sourceChanged;
        if (changed) onChange({ previous, current: next, reason: 'select' });
        announce();
        return { changed, previous };
    }

    // Forget the wallet entirely and remember that the user asked for that.
    function disconnect() {
        const previous = connected();
        revokeDiscuss();   // clears the local token first, then tells the server
        safeDel(storage, WALLET_KEYS.address);
        safeDel(storage, WALLET_KEYS.source);
        safeDel(storage, WALLET_KEYS.lastUsed);
        safeSet(storage, WALLET_KEYS.disconnected, '1');
        restoring = false;
        if (previous) onChange({ previous, current: '', reason: 'disconnect' });
        announce();
        return { changed: !!previous, previous };
    }

    return { connected, source, lastUsed, isDisconnected, mayAutoPick, select, disconnect,
        getActiveAccount, onActiveAccountChange, listenerCount, beginRestore, endRestore, syncExternal };
}

// The account to sign with: the one matching `address`, preferring the extension
// the user picked it from. Accounts are matched by public key (isSame), so an
// SS58-prefix difference never hides a match. If the preferred extension no
// longer holds the account, any extension that does is used.
export function pickSigningAccount(accounts, address, preferredSource, isSame) {
    const list = (accounts || []).filter(a => a && isSame(a.address, address));
    if (!list.length) return null;
    return list.find(a => preferredSource && a.source === preferredSource) || list[0];
}

// Extension keys with the preferred one first, for loops that try each in turn.
export function orderSources(keys, preferred) {
    const all = Array.from(keys || []);
    if (!preferred || !all.includes(preferred)) return all;
    return [preferred, ...all.filter(k => k !== preferred)];
}
