// Review follow-ups on the discussion token (one sign-in, bound to the active wallet).
//
//   1. The account labels panel read the token once, when it was drawn, and used
//      it at Save; vote and report held it across a sign-in or a prompt(). A switch
//      now revokes the old token, but a request already in flight must still
//      never carry the OLD account's token. Every action now re-reads the ACTIVE
//      wallet's token immediately before the fetch, and refuses if the wallet
//      is not the one the panel was opened for.
//   2. A token issued for a wallet that changed while verify was in flight was
//      dropped locally but left alive on the server; it is revoked now. And
//      remember() must survive two tabs writing the same key at once.
//
// The panel parts run the REAL renderAccountLabelEditor / labelVote / labelReport
// from script.js (lifted by name) on a happy-dom page. Addresses are synthetic.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { decodeAddress } from '@polkadot/util-crypto';
import * as auth from '../lib/discussion-auth.js';
import { escapeHtml } from '../lib/html-escape.js';
import { readRepo, bodyOf } from './helpers/source.js';
import { addr, memStorage } from './helpers/wallet-world.js';

const SCRIPT = readRepo('script.js', import.meta.url);
const KEY = 'pdex_discuss_session';
const DAY = 24 * 60 * 60 * 1000;
const A = addr(1), B = addr(2), X = addr(9);
const MSG = 'Your wallet changed; nothing was saved.';
const same = (a, b) => {
    if (!a || !b) return false;
    try { return Buffer.from(decodeAddress(a)).equals(Buffer.from(decodeAddress(b))); } catch (e) { return false; }
};
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

// ─── lib: liveSessionFor ────────────────────────────────────────────────────

describe('liveSessionFor: the active wallet\'s token, read now', () => {
    const mk = (wallet, sessions) => {
        const storage = memStorage();
        const s = { wallet };
        const store = auth.createDiscussAuth({ storage, key: KEY, isSame: same, wallet: () => s.wallet });
        for (const [a, t] of sessions) { const keep = s.wallet; s.wallet = a; store.remember(a, t, DAY); s.wallet = keep; }
        return { s, store, deps: (openedFor) => ({ auth: store, wallet: () => s.wallet, isSame: same, openedFor }) };
    };
    test('returns the token that is stored for the active wallet at this moment', () => {
        const w = mk(A, [[A, 'tok-a']]);
        assert.equal(auth.liveSessionFor(w.deps(A)).token, 'tok-a');
        w.store.remember(A, 'tok-a2', DAY);
        assert.equal(auth.liveSessionFor(w.deps(A)).token, 'tok-a2', 'a token read earlier was used');
    });
    test('refuses when the active wallet is not the one the panel was opened for', () => {
        const w = mk(A, [[A, 'tok-a']]);
        w.s.wallet = B;
        assert.throws(() => auth.liveSessionFor(w.deps(A)), { message: MSG });
    });
    test('null when the wallet has no token (expired or forgotten meanwhile)', () => {
        const w = mk(A, [[B, 'tok-b']]);
        assert.equal(auth.liveSessionFor(w.deps(A)), null);
    });
    test('the same key in another SS58 encoding is not a change', () => {
        const w = mk(addr(1, 42), [[A, 'tok-a']]);
        assert.equal(auth.liveSessionFor(w.deps(A)).token, 'tok-a');
    });
});

// ─── the labels panel ───────────────────────────────────────────────────────

const LIFT = ['fetchLabelsJson', 'renderAccountLabelEditor', 'ensureLabelSession', 'labelVote', 'labelReport', 'labelVeto',
    'labelDeleteMine', 'liveLabelSession', 'getDiscussSession', 'discussAuthStore', 'reconcileDiscussSession', 'logoutDiscussToken'];

function panel({ wallet = A, stored = [], onPrompt = null } = {}) {
    const win = new Window({ url: 'https://explorer.test/account/' + X, settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    const doc = win.document;
    const slot = doc.createElement('div');
    slot.id = 'account-label-editor';
    doc.body.appendChild(slot);
    const local = memStorage();
    const state = { wallet };
    const now = Date.now();
    if (stored.length) local.setItem(KEY, JSON.stringify({ v: 3, ...{ expiresAt: now + DAY, ...stored[0] } }));
    const calls = [], alerts = [];
    const labels = [{ signer: B, label: 'Treasury', score: 1, reportCount: 0, viewerVote: 0, createdAt: 1 }];
    const fetchFn = async (url, init = {}) => {
        const bearer = ((init.headers && init.headers.Authorization) || '').replace(/^Bearer /, '');
        calls.push({ url: String(url), method: init.method || 'GET', bearer });
        return { ok: true, status: 200, json: async () => ({ labels }), text: async () => '' };
    };
    const env = {
        ...auth,
        DISCUSS_TOKEN_KEY: KEY, document: doc, localStorage: local, fetch: fetchFn, CSS: { escape: s => s },
        getStoredWallet: () => state.wallet, isSameAddress: same,
        addressLabelsCache: new Map(), invalidateAddressLabelCache: () => {}, ensureAddressLabel: () => {},
        discussSignIn: async () => false,
        alert: (m) => { alerts.push(String(m)); }, confirm: () => true,
        prompt: () => { if (onPrompt) onPrompt(state); return 'spam'; },
        stakingEscapeHtml: escapeHtml, stakingShortAddress: (a) => String(a).slice(0, 6), formatLocalDateTime: () => 'today', helpIcon: () => ''
    };
    const code = LIFT.map(n => {
        const at = SCRIPT.indexOf(`function ${n}(`);
        const pre = SCRIPT.slice(Math.max(0, at - 6), at) === 'async ' ? 'async ' : '';
        return pre + bodyOf(SCRIPT, n);
    }).join('\n');
    const fns = new Function(...Object.keys(env), code + '\nreturn { renderAccountLabelEditor, labelVote, labelReport, labelVeto, labelDeleteMine, reconcileDiscussSession };')(...Object.values(env));
    return {
        doc, slot, state, local, calls, alerts, fns,
        async open() { await fns.renderAccountLabelEditor(X); await flush(); },
        writes: () => calls.filter(c => c.method !== 'GET' && !c.url.startsWith('/api/auth/')),
        logouts: () => calls.filter(c => c.url === '/api/auth/logout').map(c => c.bearer),
        status: () => doc.getElementById('account-label-status').textContent
    };
}
const STORED = [{ token: 'tok-a', address: A }];

describe('Save in the labels panel', () => {
    test('sends the active wallet\'s current token', async () => {
        const p = await (async () => { const q = panel({ stored: STORED }); await q.open(); return q; })();
        p.local.setItem(KEY, JSON.stringify({ v: 3, token: 'tok-a2', address: A, expiresAt: Date.now() + DAY }));
        p.doc.getElementById('account-label-input').value = 'Cold storage';
        p.doc.getElementById('account-label-save').click(); await flush();
        assert.equal(p.writes().length, 1);
        assert.equal(p.writes()[0].bearer, 'tok-a2', 'the token read when the panel was drawn was used');
    });
    test('after an account switch: refused, nothing sent, the user is told', async () => {
        const p = panel({ stored: STORED }); await p.open();
        p.state.wallet = B;
        p.doc.getElementById('account-label-input').value = 'Cold storage';
        p.doc.getElementById('account-label-save').click(); await flush();
        assert.deepEqual(p.writes(), [], 'the old account\'s token was sent after the switch');
        assert.equal(p.status().startsWith(MSG), true, p.status());
    });
});

describe('the labels panel after a wallet switch', () => {
    test('the old token is revoked and gone, so a Save refuses and sends nothing, with that token or any other', async () => {
        const p = panel({ stored: STORED }); await p.open();
        p.state.wallet = B;
        p.fns.reconcileDiscussSession();   // what onWalletChanged does
        await flush();
        assert.deepEqual(p.logouts(), ['tok-a'], 'the old token was not revoked');
        assert.equal(p.local.getItem(KEY), null, 'the old token is still in storage');
        p.doc.getElementById('account-label-input').value = 'Cold storage';
        p.doc.getElementById('account-label-save').click(); await flush();
        assert.deepEqual(p.writes(), [], 'a write went out after the switch');
        assert.equal(p.status().startsWith(MSG), true, p.status());
    });
});

describe('Vote and Report in the labels panel', () => {
    test('a vote after an account switch is refused, with nothing sent', async () => {
        const p = panel({ stored: STORED }); await p.open();
        p.state.wallet = B;
        p.slot.querySelector('.label-vote-btn').click(); await flush();
        assert.deepEqual(p.writes(), []);
        assert.deepEqual(p.alerts, [MSG]);
    });
    test('a vote with the same wallet still goes out, with its token', async () => {
        const p = panel({ stored: STORED }); await p.open();
        p.slot.querySelector('.label-vote-btn').click(); await flush();
        assert.equal(p.writes().length, 1);
        assert.equal(p.writes()[0].bearer, 'tok-a');
    });
    test('the wallet switches while the report prompt is open: refused, nothing sent', async () => {
        const p = panel({ stored: STORED, onPrompt: (s) => { s.wallet = B; } }); await p.open();
        p.slot.querySelector('.label-report-btn').click(); await flush();
        assert.deepEqual(p.writes(), [], 'the report went out under the account that was active before the prompt');
        assert.deepEqual(p.alerts, [MSG]);
    });
    test('a report with the same wallet still goes out', async () => {
        const p = panel({ stored: STORED }); await p.open();
        p.slot.querySelector('.label-report-btn').click(); await flush();
        assert.equal(p.writes().length, 1);
        assert.equal(p.writes()[0].bearer, 'tok-a');
    });
});

// ─── lib: a token for a wallet that changed after verify; two tabs ──────────

describe('sign-in: the wallet changes after verify', () => {
    test('the token the server just issued is revoked, not only dropped', async () => {
        const state = { wallet: A }, storage = memStorage(), revoked = [];
        const store = auth.createDiscussAuth({ storage, key: KEY, isSame: same, wallet: () => state.wallet });
        const res = (body) => ({ ok: true, status: 200, json: async () => body });
        const fetchFn = async (url) => {
            if (url === '/api/auth/challenge') return res({ message: 'm' });
            state.wallet = B;   // the user switched while verify was in flight
            return res({ token: 'tok-new', address: A, expiresIn: DAY });
        };
        await assert.rejects(auth.signInForDiscussion({
            address: A, fetchFn, getSigner: async () => ({ signRaw: async () => ({ signature: '0x01' }) }),
            wallet: () => state.wallet, isSame: same, auth: store, onEvicted: (t) => revoked.push(...t)
        }), /wallet changed/i);
        assert.equal(store.list().length, 0);
        assert.deepEqual(revoked, ['tok-new'], 'the server session stayed alive for its full 7 days');
    });
    test('a throwing revoke callback does not change the outcome', async () => {
        const state = { wallet: A }, store = auth.createDiscussAuth({ storage: memStorage(), key: KEY, isSame: same, wallet: () => state.wallet });
        const res = (body) => ({ ok: true, status: 200, json: async () => body });
        const fetchFn = async (url) => { if (url === '/api/auth/challenge') return res({ message: 'm' }); state.wallet = B; return res({ token: 't', expiresIn: DAY }); };
        await assert.rejects(auth.signInForDiscussion({
            address: A, fetchFn, getSigner: async () => ({ signRaw: async () => ({ signature: '0x01' }) }),
            wallet: () => state.wallet, isSame: same, auth: store, onEvicted: () => { throw new Error('boom'); }
        }), /wallet changed/i);
    });
});

describe('remember() with two tabs: a token for an address that is no longer active must not win', () => {
    const mkw = (wallet, storage = memStorage()) => {
        const state = { wallet };
        return { state, storage, store: auth.createDiscussAuth({ storage, key: KEY, isSame: same, wallet: () => state.wallet }) };
    };
    test('the wallet is already another one: nothing is written, the new token is handed back for revocation', () => {
        const w = mkw(B);
        const r = w.store.remember(A, 'tok-a', DAY);
        assert.equal(w.storage.getItem(KEY), null);
        assert.equal(r.stored, false);
        assert.deepEqual(r.evicted, ['tok-a']);
    });
    test('the wallet changes just as we write: our token is taken back out and revoked', () => {
        const base = memStorage(); let w;
        const storage = { getItem: k => base.getItem(k), removeItem: k => base.removeItem(k), setItem(k, v) { base.setItem(k, v); w.state.wallet = B; } };
        w = mkw(A, storage);
        const r = w.store.remember(A, 'tok-a', DAY);
        assert.equal(base.getItem(KEY), null, 'a token for a wallet that is no longer active stayed in storage');
        assert.equal(r.stored, false);
        assert.ok(r.evicted.includes('tok-a'));
    });
    test('the other tab overwrote the slot with the new wallet\'s own token: ours loses, theirs is left alone', () => {
        const base = memStorage(); let w;
        const storage = { getItem: k => base.getItem(k), removeItem: k => base.removeItem(k),
            setItem(k, v) { base.setItem(k, JSON.stringify({ v: 3, token: 'tok-b', address: B, expiresAt: Date.now() + DAY })); w.state.wallet = B; } };
        w = mkw(A, storage);
        const r = w.store.remember(A, 'tok-a', DAY);
        assert.equal(JSON.parse(base.getItem(KEY)).token, 'tok-b', 'the other tab\'s sign-in was wiped');
        assert.equal(r.stored, false);
        assert.ok(r.evicted.includes('tok-a'));
    });
    test('the normal case still stores, and replacing the same account\'s older token revokes the old one', () => {
        const w = mkw(A);
        assert.equal(w.store.remember(A, 'tok-a', DAY).stored, true);
        const r = w.store.remember(A, 'tok-a2', DAY);
        assert.deepEqual(r.evicted, ['tok-a']);
        assert.equal(w.store.current().token, 'tok-a2');
    });
});

describe('the single sign-in policy is written down', () => {
    test('lib/discussion-auth.js says one token is kept, and no longer talks about 8 tokens or MAX_SESSIONS', () => {
        const src = readRepo('lib/discussion-auth.js', import.meta.url);
        assert.match(src, /one (sign-in|token)[^\n]*localStorage|localStorage[^\n]*one (sign-in|token)/i);
        assert.doesNotMatch(src, /8 tokens|MAX_SESSIONS|up to 8/i);
    });
    test('script.js has no eviction code left', () => {
        assert.doesNotMatch(readRepo('script.js', import.meta.url), /onEvicted: tokens => tokens\.forEach/);
    });
});
