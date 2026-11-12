// Load order of script.js and the leftovers of the single discussion sign-in.
//
// The reviewer found that script.js called reconcileDiscussSession() at top
// level BEFORE the line that declared DISCUSS_TOKEN_KEY (a const), so the call
// hit the temporal dead zone, threw, and a catch swallowed it: legacy tokens
// were never revoked on load. Earlier tests missed it because the helper
// declared the key first and the tests called reconcile themselves.
//
// This file runs the REAL top-level statements of script.js in their REAL
// order (positions in the file, nothing pre-declared by the test other than
// what script.js imports), in a vm with a fake localStorage and fetch.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import * as auth from '../lib/discussion-auth.js';
import { createWalletSession } from '../lib/wallet-session.js';
import { isValidPolkadexAddress } from '../lib/wallet-safety.js';
import { readRepo, bodyOf } from './helpers/source.js';
import { addr, memStorage } from './helpers/wallet-world.js';

const SCRIPT = readRepo('script.js', import.meta.url);
const KEY = 'pdex_discuss_session';
const DAY = 24 * 60 * 60 * 1000;
const A = addr(1), B = addr(2);
const same = (a, b) => {
    if (!a || !b) return false;
    try { return Buffer.from(decodeAddress(a)).equals(Buffer.from(decodeAddress(b))); } catch (e) { return false; }
};

// The pieces of script.js that run (or are called) at load, in file order.
function loadScriptTop({ storage, errors = [] }) {
    const parts = [];
    const lineAt = (marker) => {
        const s = SCRIPT.indexOf(marker);
        assert.ok(s !== -1, `${marker} not found in script.js`);
        const e = SCRIPT.indexOf('\n', s);
        return { pos: s, text: SCRIPT.slice(s, e) };
    };
    const fn = (name) => ({ pos: SCRIPT.indexOf(`function ${name}(`), text: bodyOf(SCRIPT, name) });
    // From the walletSession constant through the reconcile call that follows it.
    const ws = SCRIPT.indexOf('const walletSession = createWalletSession(');
    const rc = SCRIPT.indexOf('reconcileDiscussSession();', ws);
    assert.ok(ws !== -1 && rc !== -1, 'the startup reconcile call is gone from script.js');
    parts.push({ pos: ws, text: SCRIPT.slice(ws, SCRIPT.indexOf('\n', rc)) });
    parts.push(lineAt('function getStoredWallet()'));
    const declared = /^const DISCUSS_TOKEN_KEY\b/m.test(SCRIPT);
    if (declared) parts.push(lineAt('const DISCUSS_TOKEN_KEY'));
    for (const n of ['discussAuthStore', 'reconcileDiscussSession', 'revokeDiscussSession', 'logoutDiscussToken', 'isSameAddress', 'toPolkadexAddress']) parts.push(fn(n));
    parts.sort((a, b) => a.pos - b.pos);
    // An import is hoisted: it is visible to every statement, like a global here.
    const imported = /^import \{[^}]*\bDISCUSS_TOKEN_KEY\b[^}]*\} from '\.\/lib\/discussion-auth\.js'/m.test(SCRIPT);
    const logouts = [];
    const ctx = {
        localStorage: storage, decodeAddress, encodeAddress, POLKADEX_SS58: 88, createWalletSession, createDiscussAuth: auth.createDiscussAuth,
        isValidPolkadexAddress, onWalletChanged: () => {}, Promise, JSON, Number, Array,
        fetch: (url, init) => { logouts.push({ url, token: String(init.headers.Authorization).replace('Bearer ', '') }); return Promise.resolve({ ok: true }); },
        console: { error: (...a) => errors.push(a.map(String).join(' ')), log() {}, warn() {} }
    };
    if (imported) ctx.DISCUSS_TOKEN_KEY = auth.DISCUSS_TOKEN_KEY;
    vm.createContext(ctx);
    vm.runInContext(parts.map(p => p.text).join('\n'), ctx);
    return { logouts, errors, declared, imported, ctx };
}

const put = (storage, v) => storage.setItem(KEY, JSON.stringify(v));
const live = () => Date.now() + DAY;
const walletIs = (storage, a) => storage.setItem('pdex_wallet_address', a);

describe('script.js reconciles discussion tokens on load, in its real top-level order', () => {
    test('the key is not declared after the startup call (no temporal dead zone)', () => {
        const key = SCRIPT.search(/^const DISCUSS_TOKEN_KEY\b/m);
        const call = SCRIPT.indexOf('reconcileDiscussSession();');
        assert.ok(key === -1 || key < call, 'DISCUSS_TOKEN_KEY is declared below the top-level reconcile call');
    });
    test('loading throws nothing and logs no error', () => {
        const storage = memStorage(), errors = [];
        walletIs(storage, A);
        assert.doesNotThrow(() => loadScriptTop({ storage, errors }));
        assert.deepEqual(errors, [], 'reconcile failed on load');
    });
    test('a legacy single-slot token for a wallet that is not active is revoked and cleared on load', () => {
        const storage = memStorage();
        walletIs(storage, A);
        put(storage, { token: 'legacy-b', address: B });
        const r = loadScriptTop({ storage });
        assert.deepEqual(r.logouts.map(l => l.token), ['legacy-b'], 'the legacy token was not revoked on load');
        assert.equal(storage.getItem(KEY), null, 'the legacy token is still stored');
    });
    test('an 8-slot map: tokens for other addresses are revoked, the active wallet\'s valid token is kept', () => {
        const storage = memStorage();
        walletIs(storage, A);
        const sessions = [{ token: 't-a', address: A, expiresAt: live() }];
        for (let n = 2; n <= 8; n++) sessions.push({ token: 't-' + n, address: addr(n), expiresAt: live() });
        put(storage, { v: 2, sessions });
        const r = loadScriptTop({ storage });
        assert.deepEqual(r.logouts.map(l => l.token).sort(), ['t-2', 't-3', 't-4', 't-5', 't-6', 't-7', 't-8']);
        const kept = JSON.parse(storage.getItem(KEY));
        assert.equal(kept.token, 't-a');
        assert.equal(kept.address, A);
    });
    test('a valid token for the still-active wallet alone is kept and nothing is revoked', () => {
        const storage = memStorage();
        walletIs(storage, A);
        put(storage, { v: 3, token: 'mine', address: A, expiresAt: live() });
        const r = loadScriptTop({ storage });
        assert.deepEqual(r.logouts, []);
        assert.equal(JSON.parse(storage.getItem(KEY)).token, 'mine');
    });
    test('no wallet at all: every stored token is revoked and cleared', () => {
        const storage = memStorage();
        put(storage, { v: 3, token: 'orphan', address: A, expiresAt: live() });
        const r = loadScriptTop({ storage });
        assert.deepEqual(r.logouts.map(l => l.token), ['orphan']);
        assert.equal(storage.getItem(KEY), null);
    });
});

describe('a failure in the startup reconcile is logged, not swallowed', () => {
    test('reconcileDiscussSession reports an error through console.error', () => {
        const body = bodyOf(SCRIPT, 'reconcileDiscussSession');
        assert.match(body, /catch \(e\)\s*\{[^}]*console\.error/, 'the catch hides the failure');
    });
    test('run with a store that throws: the error is logged and the page still loads', () => {
        const storage = memStorage(), errors = [];
        walletIs(storage, A);
        const r = loadScriptTop({ storage, errors });
        r.ctx.discussAuthStore = () => { throw new Error('boom'); };
        r.ctx.reconcileDiscussSession();
        assert.ok(errors.some(e => /boom/.test(e)), 'a failing reconcile left no trace in the console');
    });
});

describe('forgetToken after a 401 revokes what it drops', () => {
    const mk = (wallet, revoke) => {
        const storage = memStorage();
        const state = { wallet };
        const store = auth.createDiscussAuth({ storage, key: KEY, isSame: same, wallet: () => state.wallet, revoke });
        return { storage, state, store };
    };
    test('leftover tokens for other addresses are revoked and storage keeps only the active wallet\'s valid token', () => {
        const revoked = [];
        const w = mk(A, (t) => revoked.push(...t));
        put(w.storage, { v: 2, sessions: [
            { token: 'old-a', address: A, expiresAt: live() },
            { token: 'tok-b', address: B, expiresAt: live() },
            { token: 'tok-a', address: A, expiresAt: live() }
        ] });
        w.store.forgetToken('old-a');
        assert.deepEqual(revoked.sort(), ['tok-b'], 'a token for another wallet was dropped without revocation');
        const kept = JSON.parse(w.storage.getItem(KEY));
        assert.equal(kept.token, 'tok-a');
        assert.equal(kept.address, A);
    });
    test('only another wallet\'s token is left: it is revoked and storage ends empty', () => {
        const revoked = [];
        const w = mk(A, (t) => revoked.push(...t));
        put(w.storage, { v: 2, sessions: [{ token: 'bad', address: A, expiresAt: live() }, { token: 'tok-b', address: B, expiresAt: live() }] });
        w.store.forgetToken('bad');
        assert.deepEqual(revoked, ['tok-b']);
        assert.equal(w.storage.getItem(KEY), null);
    });
    test('the 401 token itself is not revoked again, and a lone token leaves storage empty', () => {
        const revoked = [];
        const w = mk(A, (t) => revoked.push(...t));
        put(w.storage, { v: 3, token: 'bad', address: A, expiresAt: live() });
        w.store.forgetToken('bad');
        assert.deepEqual(revoked, []);
        assert.equal(w.storage.getItem(KEY), null);
    });
    test('script.js hands the store a revoker that logs tokens out on the server', () => {
        assert.match(bodyOf(SCRIPT, 'discussAuthStore'), /revoke:/);
    });
});

describe('remember(): another tab on the SAME wallet is not "your wallet changed"', () => {
    test('a concurrent same-wallet write wins quietly: stored, theirs kept, ours revoked, no change flag', () => {
        const base = memStorage(); const state = { wallet: A };
        const storage = { getItem: k => base.getItem(k), removeItem: k => base.removeItem(k),
            setItem() { base.setItem(KEY, JSON.stringify({ v: 3, token: 'tok-a-tab2', address: A, expiresAt: Date.now() + DAY })); } };
        const store = auth.createDiscussAuth({ storage, key: KEY, isSame: same, wallet: () => state.wallet });
        const r = store.remember(A, 'tok-a', DAY);
        assert.equal(r.stored, true);
        assert.equal(r.session.token, 'tok-a-tab2');
        assert.ok(r.evicted.includes('tok-a'));
        assert.equal(JSON.parse(base.getItem(KEY)).token, 'tok-a-tab2');
    });
    test('signInForDiscussion in that race returns the session and never says the wallet changed', async () => {
        const base = memStorage(); const state = { wallet: A };
        const storage = { getItem: k => base.getItem(k), removeItem: k => base.removeItem(k),
            setItem() { base.setItem(KEY, JSON.stringify({ v: 3, token: 'tok-a-tab2', address: A, expiresAt: Date.now() + DAY })); } };
        const store = auth.createDiscussAuth({ storage, key: KEY, isSame: same, wallet: () => state.wallet });
        const fetchFn = async (url) => ({ ok: true, json: async () => (url.endsWith('challenge') ? { message: 'm' } : { token: 'tok-a', expiresIn: DAY }) });
        const evicted = [];
        const s = await auth.signInForDiscussion({ address: A, fetchFn, getSigner: async () => ({ signRaw: async () => ({ signature: '0x01' }) }),
            wallet: () => state.wallet, isSame: same, auth: store, onEvicted: (t) => evicted.push(...t) });
        assert.equal(s.token, 'tok-a-tab2');
        assert.ok(evicted.includes('tok-a'));
    });
    test('when the active address really differs the message is still shown', async () => {
        const base = memStorage(); const state = { wallet: A };
        const storage = { getItem: k => base.getItem(k), removeItem: k => base.removeItem(k), setItem(k, v) { base.setItem(k, v); state.wallet = B; } };
        const store = auth.createDiscussAuth({ storage, key: KEY, isSame: same, wallet: () => state.wallet });
        const fetchFn = async (url) => ({ ok: true, json: async () => (url.endsWith('challenge') ? { message: 'm' } : { token: 'tok-a', expiresIn: DAY }) });
        await assert.rejects(auth.signInForDiscussion({ address: A, fetchFn, getSigner: async () => ({ signRaw: async () => ({ signature: '0x01' }) }),
            wallet: () => state.wallet, isSame: same, auth: store }), (e) => e.message === auth.WALLET_CHANGED);
    });
});
