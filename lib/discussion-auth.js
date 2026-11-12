// Discussion board identity: who may post, and with which token.
//
// Reported 12 Nov on /democracy/referendum/38: the wallet was connected (the
// header said My Account) and the Discussion panel still put up "Sign in with
// your Substrate wallet" and a separate button. The board drew that wall
// whenever the active wallet had no token, the browser kept ONE token for all
// accounts, and every account switch revoked it. So any switch, a second
// account, or the 7-day expiry put the wall back.
//
// Now (second decision, same day): ONE discussion sign-in, bound to the active
// wallet.
//   - The browser holds at most one token, for the connected wallet's address.
//     Any change of the active wallet (switch account or extension, another
//     tab, Disconnect, Reset) revokes that token on the server (best effort,
//     never blocking) and removes it; the board then shows the composer for the
//     new wallet and the first Post (or Save) asks it to sign;
//   - a token found for any other address (a legacy multi-token store, or data
//     an older version left behind) is revoked and removed on load (reconcile);
//   - a connected wallet gets the composer straight away (sendAsWallet);
//   - no wallet: one "Connect a wallet to comment" link to the global picker.
//
// The server is unchanged: POST /api/auth/challenge, POST /api/auth/verify
// -> { token, address, expiresIn } (7 days), Bearer token on every write.
//
// Privacy note: one token sits in this browser's localStorage, a 7-day bearer
// that can only post as the connected address; switching wallets and Disconnect
// revoke it on the server.
//
// No imports on purpose, so the logic runs under node --test.

export const SIGN_NOTE = 'Your wallet will ask you to confirm it is you. No transaction, no fee.';
export const WALLET_CHANGED = 'Your wallet changed while signing; you are not signed in. Nothing was posted.';

function safeSame(isSame, a, b) {
    if (!a || !b) return false;
    try { return !!isSame(a, b); } catch (e) { return false; }
}

// storage: localStorage-shaped. Stored value: { v: 3, token, address, expiresAt }.
// Two older shapes are still READ, so a migration never strands a token: the
// first version's { token, address } and the later { v: 2, sessions: [...] } map.
// reconcile() rewrites whatever it finds as the single v3 slot.
export function createDiscussAuth({ storage, key, isSame, wallet = () => '', now = () => Date.now() }) {
    function read() {
        let raw = null;
        try { raw = storage.getItem(key); } catch (e) { return []; }
        if (!raw) return [];
        let v;
        try { v = JSON.parse(raw); } catch (e) { return []; }
        const list = v && Array.isArray(v.sessions) ? v.sessions : (v && v.token ? [{ token: v.token, address: v.address, expiresAt: Number.isFinite(v.expiresAt) ? v.expiresAt : null }] : []);
        return list.filter(s => s && typeof s.token === 'string' && s.token && typeof s.address === 'string' && s.address);
    }
    function write(session) {
        try {
            if (session) storage.setItem(key, JSON.stringify({ v: 3, token: session.token, address: session.address, expiresAt: session.expiresAt }));
            else storage.removeItem(key);
        } catch (e) { /* private mode or a full quota: the session lasts this page only */ }
    }
    const live = (s) => !(Number.isFinite(s.expiresAt) && s.expiresAt <= now());

    function list() { return read().filter(live); }
    function sessionFor(address) {
        if (!address) return null;
        return list().find(s => safeSame(isSame, s.address, address)) || null;
    }
    function current() { return sessionFor(wallet()); }
    // Keep only the token that belongs to `active` (none when there is no active
    // wallet) and return every other live token, for the caller to revoke on the
    // server. Expired tokens are dropped without a revoke (the server has
    // already forgotten them). Run on load and on every wallet change.
    function reconcile(active) {
        const all = read();
        if (!all.length) return [];
        const keep = active ? list().filter(s => safeSame(isSame, s.address, active)).pop() || null : null;
        write(keep);
        return all.filter(s => live(s) && !(keep && s.token === keep.token)).map(s => s.token);
    }
    // Store `token` for `address` if that address is still the active wallet.
    // Returns { session, stored, evicted: [token] }; the caller revokes the
    // evicted ones (the replaced older tokens, and `token` itself when it could
    // not be kept). Two tabs share the key: a write for an address that is no
    // longer active must not win, so check before AND after the write, and on a
    // late change take back only our own token.
    function remember(address, token, expiresInMs) {
        const ms = Number(expiresInMs);
        const session = { token, address, expiresAt: Number.isFinite(ms) && ms > 0 ? now() + ms : null };
        const stale = () => !safeSame(isSame, wallet(), address);
        if (stale()) return { session, stored: false, evicted: [token] };
        const evicted = read().map(s => s.token).filter(t => t !== token);
        write(session);
        if (stale() || !read().some(s => s.token === token)) {
            forgetToken(token);
            return { session, stored: false, evicted: evicted.concat(token) };
        }
        return { session, stored: true, evicted };
    }
    function forgetToken(token) {
        const rest = read().filter(s => s.token !== token);
        if (rest.length !== read().length) write(rest.pop() || null);
    }
    // Empties the store FIRST and returns the tokens, so the caller can tell the
    // server after the local copy is already gone (F-120).
    function takeAll() {
        const tokens = read().map(s => s.token);
        write(null);
        return tokens;
    }
    return { list, sessionFor, current, reconcile, remember, forgetToken, takeAll };
}

// The extension's "Cancel" arrives as an Error whose text varies by wallet.
function isCancel(e) { return /cancel|reject|denied|declined|abort/i.test(String((e && e.message) || e || '')); }

// Challenge, signature, verify, remember. Throws on anything short of a stored
// token for `address`, and keeps nothing if the active wallet changed meanwhile.
// deps: { address, fetchFn, getSigner(address), wallet(), isSame, auth, onEvicted(tokens) }
export async function signInForDiscussion(deps) {
    const { address, fetchFn, getSigner, wallet, isSame, auth } = deps;
    const changed = () => !safeSame(isSame, wallet(), address);
    const json = async (res) => { try { return await res.json(); } catch (e) { return {}; } };
    const challRes = await fetchFn('/api/auth/challenge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address })
    });
    const chall = await json(challRes);
    if (!challRes.ok || chall.error) throw new Error(chall.error || 'Could not start sign-in.');
    const signer = await getSigner(address);
    if (!signer) throw new Error('Could not reach a wallet extension that holds this address.');
    let signed;
    try { signed = await signer.signRaw({ address, data: chall.message, type: 'bytes' }); }
    catch (e) {
        const err = new Error(isCancel(e) ? 'You cancelled the signature in your wallet.' : ('Your wallet could not sign: ' + ((e && e.message) || e)));
        err.cancelled = isCancel(e);
        throw err;
    }
    if (changed()) throw new Error(WALLET_CHANGED);
    const verRes = await fetchFn('/api/auth/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, signature: signed && signed.signature })
    });
    const ver = await json(verRes);
    if (!verRes.ok || ver.error || !ver.token) throw new Error(ver.error || 'Verification failed.');
    if (changed()) {
        // The server already issued this token; do not leave it alive for 7 days.
        if (deps.onEvicted) { try { deps.onEvicted([ver.token]); } catch (e) { /* best effort */ } }
        throw new Error(WALLET_CHANGED);
    }
    const r = auth.remember(address, ver.token, ver.expiresIn);
    if (r.evicted.length && deps.onEvicted) { try { deps.onEvicted(r.evicted); } catch (e) { /* best effort */ } }
    if (!r.stored) throw new Error(WALLET_CHANGED);
    return r.session;
}

// The labels panel's per-action check: the ACTIVE wallet's token, read now (not
// when the panel was drawn), and only if that wallet is the one the panel was
// opened for. Returns null when it has no token; throws on a different wallet.
// deps: { auth, wallet(), isSame, openedFor }
export const PANEL_WALLET_CHANGED = 'Your wallet changed; nothing was saved.';
export function liveSessionFor({ auth, wallet, isSame, openedFor }) {
    if (openedFor && !safeSame(isSame, wallet(), openedFor)) throw new Error(PANEL_WALLET_CHANGED);
    return auth.current();
}

// Run one authenticated write as the connected wallet. Uses its stored token,
// or signs in first (onSigning tells the page to say "confirm in your wallet").
// A 401 on a token we believed valid drops that token, signs once and retries
// once. Never sends a token that is not the active wallet's.
// deps: { auth, wallet(), isSame, signIn(address) -> session, send(session) -> response, onSigning() }
export async function sendAsWallet(deps) {
    const { auth, wallet, isSame, signIn, send } = deps;
    const onSigning = deps.onSigning || (() => {});
    const address = wallet();
    if (!address) throw new Error('Connect a wallet to comment.');
    const check = (s) => {
        if (!s || !safeSame(isSame, s.address, address) || !safeSame(isSame, wallet(), address)) throw new Error(WALLET_CHANGED);
        return s;
    };
    const fresh = async () => { onSigning(); return check(await signIn(address)); };
    let signed = false;
    let s = auth.sessionFor(address);
    if (!s) { s = await fresh(); signed = true; }
    check(s);
    let res = await send(s);
    if (res && res.status === 401) {
        auth.forgetToken(s.token);
        if (signed) throw new Error('The sign-in was not accepted. Please try again.');
        s = await fresh();
        res = await send(s);
        if (res && res.status === 401) { auth.forgetToken(s.token); throw new Error('The sign-in was not accepted. Please try again.'); }
    }
    return res;
}

// The error line under the box. The draft always stays, so say so.
export function discussErrorText(e) {
    const msg = String((e && e.message) || e || 'Something went wrong.');
    if (e && e.cancelled) return msg + ' Nothing was posted; your text is still here.';
    return msg;
}

// The bottom of a thread: closed note, connect link, or the composer.
// o: { thread, wallet, session, esc, shortAddr, composer (trusted html), returnTo }
export function discussComposerHtml(o) {
    const { thread, wallet, session, esc, shortAddr } = o;
    if (thread && thread.status === 'closed') {
        return `<div class="discussion-closed-note"><i class='bx bx-lock-alt'></i> ${esc(thread.closedReason || 'This discussion is closed.')}</div>`;
    }
    if (!wallet) {
        return `<div class="discussion-composer">
            <p style="color:var(--text-secondary);font-size:0.85rem;margin-bottom:10px;">Connect a wallet to comment.</p>
            <a id="discuss-connect-btn" class="staking-download-btn" href="/wallet?returnTo=${encodeURIComponent(o.returnTo || '/')}"><i class='bx bx-wallet'></i> Connect wallet</a>
        </div>`;
    }
    const who = `<span style="color:var(--brand-secondary);" title="${esc(wallet)}">${esc(shortAddr(wallet))}</span>`;
    const head = session ? `Signed in as ${who}` : `Posting as ${who}`;
    const note = session ? '' : `<span class="discussion-sign-note" style="color:var(--text-muted);font-size:0.75rem;margin-right:auto;">${esc(SIGN_NOTE)}</span>`;
    return `<div class="discussion-composer">
            <div style="color:var(--text-secondary);font-size:0.78rem;margin-bottom:8px;">${head}</div>
            ${o.composer}
            <div style="display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:8px;">
                ${note}
                <button id="discuss-post-btn" class="staking-download-btn" style="background:var(--brand-primary);color:#fff;border-color:var(--brand-primary);"><i class='bx bx-send'></i> Post</button>
            </div>
            <div id="discuss-post-error" class="staking-error" style="display:none;"></div>
        </div>`;
}
