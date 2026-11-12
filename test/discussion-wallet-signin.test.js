// Discussion board: a connected wallet must not meet a sign-in wall.
//
// Reported 12 Nov on /democracy/referendum/38: the header showed the wallet as
// connected (My Account, the address underneath), yet the Discussion panel said
// "Sign in with your Substrate wallet to join this discussion" with a "Sign in
// with wallet" button. The causes, all in the code before this change:
//
//   1. renderThread drew the sign-in wall whenever there was no token for the
//      active wallet, whether or not a wallet was connected.
//   2. One token slot for the whole browser (pdex_discuss_session held a single
//      { token, address }): signing in with a second account overwrote the first.
//   3. Every switch of account revoked the old token (lib/wallet-session.js
//      select), so switching back meant signing again.
//   4. The client never knew when the token expired (7 days on the server); an
//      expired one surfaced as a failed post and the wall again.
//
// What a user sees now: connected with no valid token, the composer straight
// away, "Posting as <account>" and one line saying the wallet will ask to
// confirm it is them. The first Post (or Save of an edit) asks the wallet for
// the signature and then posts, in one click. (Later the same day the CEO
// asked for a single sign-in bound to the active wallet: see wallet-switch.test.js.)
// The token is remembered for the active wallet until it expires. Not connected: "Connect a wallet to comment", which
// opens the global connector.
//
// The browser parts run the REAL renderThread / submitDiscussionPost from
// script.js (lifted by name, as the other discussion tests do) on a happy-dom
// page, against a fake server and a fake wallet extension. Addresses are
// synthetic (32 bytes of one repeated value); they belong to no one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { decodeAddress } from '@polkadot/util-crypto';
import * as edit from '../lib/discussion-edit.js';
import * as links from '../lib/discussion-links.js';
import * as lifecycle from '../lib/discussion-lifecycle.js';
import * as composer from '../lib/discussion-composer.js';
import * as auth from '../lib/discussion-auth.js';
import { orderSources } from '../lib/wallet-session.js';
import { escapeHtml } from '../lib/html-escape.js';
import { closeControlHtml } from '../lib/close-control.js';
import { itemPathForThread } from '../lib/gov-detail.js';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';
import { addr, memStorage } from './helpers/wallet-world.js';

const SCRIPT = readRepo('script.js', import.meta.url);
const SERVER = stripComments(readRepo('server.js', import.meta.url));
const KEY = 'pdex_discuss_session';
const DAY = 24 * 60 * 60 * 1000;
const A = addr(1), B = addr(2), C = addr(3);
const A42 = addr(1, 42);   // the same key as A, in the extension's encoding

const same = (a, b) => {
    if (!a || !b) return false;
    try { return Buffer.from(decodeAddress(a)).equals(Buffer.from(decodeAddress(b))); } catch (e) { return false; }
};
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

// ─── lib/discussion-auth.js: the store ──────────────────────────────────────

describe('the token store holds one sign-in, for the active wallet', () => {
    const mk = (o = {}) => {
        const storage = memStorage();
        let wallet = o.wallet || '';
        let clock = o.now || 1_000_000;
        const store = auth.createDiscussAuth({ storage, key: KEY, isSame: same, wallet: () => wallet, now: () => clock });
        return { storage, store, setWallet: (w) => { wallet = w; }, tick: (ms) => { clock += ms; } };
    };
    const rows = (w) => { const v = JSON.parse(w.storage.getItem(KEY) || 'null'); return v ? (Array.isArray(v.sessions) ? v.sessions : [v]) : []; };

    test('a second account replaces the first: one token in storage, the old one handed back for revocation', () => {
        const w = mk({ wallet: A });
        w.store.remember(A, 'tok-a', 7 * DAY);
        assert.equal(w.store.current().token, 'tok-a');
        w.setWallet(B);
        const r = w.store.remember(B, 'tok-b', 7 * DAY);
        assert.deepEqual(r.evicted, ['tok-a'], 'the previous account\'s token was not handed back to be revoked');
        assert.equal(rows(w).length, 1, 'more than one token in storage');
        assert.equal(w.store.sessionFor(A), null, 'the old account still has a token');
        assert.equal(w.store.current().token, 'tok-b');
        w.setWallet(C);
        assert.equal(w.store.current(), null, 'an account with no token of its own borrowed another one');
        w.setWallet('');
        assert.equal(w.store.current(), null, 'no connected wallet means no posting identity');
    });

    test('the same key in another SS58 encoding is the same account', () => {
        const w = mk({ wallet: A42 });
        w.store.remember(A42, 'tok-a', 7 * DAY);
        assert.equal(w.store.current().token, 'tok-a');
        const r = w.store.remember(A, 'tok-a2', 7 * DAY);
        assert.equal(w.store.list().length, 1, 'one account, one entry');
        assert.deepEqual(r.evicted, ['tok-a']);
        assert.equal(w.store.sessionFor(A).token, 'tok-a2');
    });

    test('an expired token is not offered; reconcile drops it from storage without a pointless revoke', () => {
        const w = mk({ wallet: A });
        w.store.remember(A, 'tok-a', 7 * DAY);
        w.tick(7 * DAY - 1);
        assert.equal(w.store.current().token, 'tok-a');
        w.tick(2);
        assert.equal(w.store.current(), null, 'an expired token was offered for posting');
        assert.deepEqual(w.store.reconcile(A), []);
        assert.equal(w.storage.getItem(KEY), null);
    });

    test('reconcile keeps the active wallet\'s token and returns every other token for revocation', () => {
        const w = mk({ wallet: A });
        w.store.remember(A, 'tok-a', DAY);
        assert.deepEqual(w.store.reconcile(A), [], 'the active wallet\'s own token was revoked');
        assert.equal(w.store.current().token, 'tok-a');
        assert.deepEqual(w.store.reconcile(B), ['tok-a']);
        assert.equal(w.storage.getItem(KEY), null);
        w.store.remember(A, 'tok-a2', DAY);
        assert.deepEqual(w.store.reconcile(''), ['tok-a2'], 'a disconnected browser kept a token');
        assert.equal(w.storage.getItem(KEY), null);
    });

    test('data from the previous single slot ({ token, address }) is migrated: kept for its own wallet, revoked for another', () => {
        const w = mk({ wallet: A });
        w.storage.setItem(KEY, JSON.stringify({ token: 'old', address: A }));
        assert.equal(w.store.current().token, 'old', 'everyone signed in today would be asked to sign again');
        assert.deepEqual(w.store.reconcile(A), []);
        assert.deepEqual(rows(w).map(s => s.token), ['old']);
        assert.equal(JSON.parse(w.storage.getItem(KEY)).v, 3, 'the legacy shape was not rewritten');
        const x = mk({ wallet: B });
        x.storage.setItem(KEY, JSON.stringify({ token: 'old', address: A }));
        assert.deepEqual(x.store.reconcile(B), ['old']);
        assert.equal(x.storage.getItem(KEY), null);
    });

    test('data from the 8-slot map ({ v: 2, sessions }) is migrated: the active wallet\'s token stays, the rest are revoked', () => {
        const far = 1_000_000 + DAY;
        const w = mk({ wallet: B });
        w.storage.setItem(KEY, JSON.stringify({ v: 2, sessions: [
            { token: 'tok-a', address: A, expiresAt: far }, { token: 'tok-b', address: B, expiresAt: far }, { token: 'tok-c', address: C, expiresAt: far }] }));
        assert.equal(w.store.current().token, 'tok-b');
        assert.deepEqual(w.store.reconcile(B).sort(), ['tok-a', 'tok-c']);
        assert.deepEqual(rows(w).map(s => s.token), ['tok-b']);
        assert.equal(w.store.current().token, 'tok-b');
        const none = mk({ wallet: '' });
        none.storage.setItem(KEY, JSON.stringify({ v: 2, sessions: [{ token: 'tok-a', address: A, expiresAt: far }, { token: 'tok-b', address: B, expiresAt: far }] }));
        assert.deepEqual(none.store.reconcile('').sort(), ['tok-a', 'tok-b']);
        assert.equal(none.storage.getItem(KEY), null);
    });

    test('forgetToken drops that token; takeAll empties the store and returns the token to revoke', () => {
        const w = mk({ wallet: A });
        w.store.remember(A, 'tok-a', DAY);
        w.store.forgetToken('other');
        assert.equal(w.store.current().token, 'tok-a', 'forgetting some other token dropped this one');
        w.store.forgetToken('tok-a');
        assert.equal(w.store.sessionFor(A), null);
        w.store.remember(A, 'tok-a3', DAY);
        assert.deepEqual(w.store.takeAll(), ['tok-a3']);
        assert.equal(w.storage.getItem(KEY), null);
        w.storage.setItem(KEY, JSON.stringify({ v: 2, sessions: [{ token: 'x', address: A }, { token: 'y', address: B }] }));
        assert.deepEqual(w.store.takeAll().sort(), ['x', 'y'], 'a legacy multi-token store kept a token past Disconnect');
    });

    test('there is no multi-token store left in the module', () => {
        assert.equal(auth.MAX_SESSIONS, undefined);
    });

    test('unreadable or throwing storage never throws into the page', () => {
        const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); } };
        const s = auth.createDiscussAuth({ storage: boom, key: KEY, isSame: same, wallet: () => A });
        assert.doesNotThrow(() => { s.current(); s.remember(A, 't', DAY); s.forgetToken('t'); s.takeAll(); s.reconcile(A); });
        const junk = memStorage(); junk.setItem(KEY, '{not json');
        assert.equal(auth.createDiscussAuth({ storage: junk, key: KEY, isSame: same, wallet: () => A }).current(), null);
    });
});

// ─── a page with the real thread view ───────────────────────────────────────

const LIFT = ['fetchDiscussionThread', 'renderThread', 'submitDiscussionPost', 'getDiscussSession', 'discussAuthStore',
    'discussSignInFor', 'discussSend', 'getWalletSigner', 'isSameAddress', 'logoutDiscussToken'];

// One browser tab: localStorage, a connected wallet (or none), one wallet
// extension holding A and B (and C), and a server that issues tokens and
// rejects posts whose token it does not know.
function page({ wallet = A, stored = [], rejectSign = false, path = '/discussions/t1', posts = [], serverForgets = false } = {}) {
    const win = new Window({ url: 'https://explorer.test' + path, settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    const doc = win.document;
    const root = doc.createElement('div');
    root.id = 'discussions-content';
    doc.body.appendChild(root);
    const local = memStorage();
    const state = { wallet };
    const server = { tokens: new Map(), calls: [], posts: posts.slice(), nextId: 100, issued: 0 };
    const now = Date.now();
    if (stored.length) local.setItem(KEY, JSON.stringify({ v: 2, sessions: stored.map(s => ({ expiresAt: now + DAY, ...s })) }));
    for (const s of stored) if (!serverForgets) server.tokens.set(s.token, s.address);
    const signCalls = [];
    const ext = {
        enable: async () => ({
            accounts: { get: async () => [A, B, C].map(a => ({ address: addr(decodeAddress(a)[0], 42) })) },
            signer: { signRaw: async (req) => {
                signCalls.push(req);
                if (typeof rejectSign === 'function') return rejectSign(req, state);
                if (rejectSign) throw new Error('Cancelled');
                return { signature: '0x01' };
            } }
        })
    };
    const thread = { id: 't1', kind: 'referendum', title: 'Referendum 38', status: 'open', postCount: 0 };
    const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)) });
    const fetchFn = async (url, init = {}) => {
        url = String(url);
        const method = init.method || 'GET';
        const bearer = ((init.headers && init.headers.Authorization) || '').replace(/^Bearer /, '');
        server.calls.push({ url, method, bearer, body: init.body });
        if (url === '/api/auth/challenge') return reply(200, { message: 'sign me', address: JSON.parse(init.body).address });
        if (url === '/api/auth/verify') {
            const a = JSON.parse(init.body).address;
            const token = 'tok-issued-' + (++server.issued);
            server.tokens.set(token, a);
            return reply(200, { token, address: a, expiresIn: 7 * DAY });
        }
        if (url === '/api/auth/logout') { server.tokens.delete(bearer); return reply(200, { ok: true }); }
        const t = { ...thread, postCount: server.posts.length };
        if (url === '/api/discussions/t1' && method === 'GET') return reply(200, { thread: t, posts: server.posts });
        if (url === '/api/discussions/t1/posts' && method === 'POST') {
            if (!server.tokens.has(bearer)) return reply(401, { error: 'Sign in with your wallet to post.' });
            server.posts.push({ id: ++server.nextId, threadId: 't1', author: server.tokens.get(bearer), content: JSON.parse(init.body).content, createdAt: 1 });
            return reply(200, { thread: { ...thread, postCount: server.posts.length }, posts: server.posts });
        }
        const m = /^\/api\/discussions\/t1\/posts\/(\d+)$/.exec(url);
        if (m && method === 'PATCH') {
            if (!server.tokens.has(bearer)) return reply(401, { error: 'Sign in with your wallet to edit.' });
            const p = server.posts.find(x => x.id === Number(m[1]));
            p.content = JSON.parse(init.body).content; p.editedAt = 2;
            return reply(200, { thread: { ...thread, postCount: server.posts.length }, posts: server.posts });
        }
        return reply(404, { error: 'not found' });
    };
    const env = {
        ...edit, ...links, ...lifecycle, ...composer, ...auth,
        canEditPost: edit.canEdit, itemPathForThread, closeControlHtml, orderSources, decodeAddress,
        DISCUSS_TOKEN_KEY: KEY,
        document: doc,
        window: { location: { pathname: path, search: '', hash: '', origin: 'https://explorer.test' }, injectedWeb3: { 'polkadot-js': ext } },
        localStorage: local, navigator: {},
        fetch: fetchFn,
        alert: () => {},
        getStoredWallet: () => state.wallet,
        walletSession: { source: () => 'polkadot-js' },
        stakingEscapeHtml: escapeHtml, stakingShortAddress: (a) => String(a).slice(0, 6) + '...' + String(a).slice(-4),
        formatLocalDateTime: () => 'today', helpIcon: () => ''
    };
    const code = LIFT.map(n => {
        const at = SCRIPT.indexOf(`function ${n}(`);
        const pre = SCRIPT.slice(Math.max(0, at - 6), at) === 'async ' ? 'async ' : '';
        return pre + bodyOf(SCRIPT, n);
    }).join('\n');
    const fns = new Function(...Object.keys(env), code + '\nreturn { fetchDiscussionThread, renderThread, getDiscussSession };')(...Object.values(env));
    return {
        root, doc, local, state, server, signCalls, fns,
        async open(opts = {}) { await fns.fetchDiscussionThread('t1', false, root, opts); await flush(); },
        html: () => root.innerHTML,
        text: () => root.textContent.replace(/\s+/g, ' '),
        q: (sel) => root.querySelector(sel),
        async type(text) { const ta = root.querySelector('#discuss-post-input'); ta.value = text; },
        async post() { root.querySelector('#discuss-post-btn').click(); await flush(); },
        postCalls: () => server.calls.filter(c => c.url === '/api/discussions/t1/posts' && c.method === 'POST'),
        authCalls: () => server.calls.filter(c => c.url.startsWith('/api/auth/')).map(c => c.url.slice('/api/auth/'.length)),
        stored: () => JSON.parse(local.getItem(KEY) || 'null')
    };
}

describe('connected with a valid token: the composer, no sign-in', () => {
    test('a thread page shows the composer and "Signed in as", with no sign-in button', async () => {
        const p = page({ wallet: A, stored: [{ token: 'tok-a', address: A }] });
        await p.open();
        assert.ok(p.q('#discuss-post-input'), 'no composer');
        assert.equal(p.q('#discuss-signin-btn'), null, 'a signed-in user was shown the sign-in wall');
        assert.doesNotMatch(p.text(), /Sign in with your Substrate wallet/);
        assert.match(p.text(), /Signed in as/);
    });

    test('the same token is used on a governance item page (embedded board) and on the thread page', async () => {
        const stored = [{ token: 'tok-a', address: A }];
        const thread = page({ wallet: A, stored });
        await thread.open();
        await thread.type('from the thread page'); await thread.post();
        const item = page({ wallet: A, stored, path: '/democracy/referendum/38' });
        await item.open({ embedded: true });
        assert.equal(item.q('#discuss-signin-btn'), null, 'the item page asked again for a sign-in the thread page already had');
        await item.type('from the item page'); await item.post();
        for (const p of [thread, item]) {
            assert.deepEqual(p.signCalls, [], 'the wallet was asked to sign again');
            assert.equal(p.postCalls().length, 1);
            assert.equal(p.postCalls()[0].bearer, 'tok-a');
        }
    });
});

describe('connected without a token: compose first, sign at the first Post', () => {
    test('the composer is shown at once, with the author and the one-line wallet note', async () => {
        const p = page({ wallet: A });
        await p.open();
        assert.ok(p.q('#discuss-post-input'), 'the connected user did not get a composer');
        assert.equal(p.q('#discuss-signin-btn'), null, 'the sign-in wall is still there');
        assert.match(p.text(), /Posting as/);
        assert.ok(p.text().includes('Your wallet will ask you to confirm it is you. No transaction, no fee.'));
        assert.deepEqual(p.signCalls, [], 'nothing is signed just by opening the page');
    });

    test('Post asks the wallet to sign, then posts, in one click; the token is remembered for that address', async () => {
        const p = page({ wallet: A });
        await p.open();
        await p.type('first comment');
        await p.post();
        assert.equal(p.signCalls.length, 1, 'the wallet was not asked to sign');
        assert.deepEqual(p.authCalls(), ['challenge', 'verify']);
        assert.equal(p.postCalls().length, 1, 'the post was not sent after signing');
        const verifyAt = p.server.calls.findIndex(c => c.url === '/api/auth/verify');
        const postAt = p.server.calls.findIndex(c => c.url === '/api/discussions/t1/posts');
        assert.ok(verifyAt < postAt, 'posted before signing in');
        assert.equal(p.postCalls()[0].bearer, 'tok-issued-1');
        assert.ok(p.text().includes('first comment'), 'the new post is not on the board');
        const saved = p.stored();
        assert.equal(saved.token, 'tok-issued-1');
        assert.ok(same(saved.address, A));
        assert.ok(saved.expiresAt > Date.now() + 6 * DAY, 'the expiry the server gave was not kept');
        assert.match(p.text(), /Signed in as/);
        // a second post: no second signature
        await p.type('second'); await p.post();
        assert.equal(p.signCalls.length, 1, 'the remembered token was not reused');
        assert.equal(p.postCalls().length, 2);
    });

    test('rejecting the signature posts nothing and keeps the draft', async () => {
        const p = page({ wallet: A, rejectSign: true });
        await p.open();
        await p.type('a long thoughtful draft');
        await p.post();
        assert.equal(p.signCalls.length, 1);
        assert.equal(p.postCalls().length, 0, 'a post was sent without a signature');
        assert.equal(p.q('#discuss-post-input').value, 'a long thoughtful draft', 'the draft was lost');
        assert.equal(p.q('#discuss-post-btn').disabled, false, 'the Post button stayed disabled');
        const err = p.q('#discuss-post-error');
        assert.equal(err.style.display, 'block');
        assert.match(err.textContent, /cancel/i);
        assert.match(err.textContent, /not posted|Nothing was posted/i);
        assert.equal(p.local.getItem(KEY), null, 'a session was stored after a rejected signature');
    });

    test('an empty post does not ask the wallet for anything', async () => {
        const p = page({ wallet: A });
        await p.open();
        await p.type('   ');
        await p.post();
        assert.deepEqual(p.signCalls, []);
        assert.equal(p.postCalls().length, 0);
    });
});

describe('not connected: one prompt to the global connector', () => {
    test('"Connect a wallet to comment" links to the wallet picker and back here; no composer, no sign-in', async () => {
        const p = page({ wallet: '', path: '/democracy/referendum/38' });
        await p.open({ embedded: true });
        assert.match(p.text(), /Connect a wallet to comment/);
        const a = p.q('#discuss-connect-btn');
        assert.ok(a, 'no connect control');
        assert.equal(a.getAttribute('href'), '/wallet?returnTo=' + encodeURIComponent('/democracy/referendum/38'));
        assert.equal(p.q('#discuss-post-input'), null);
        assert.equal(p.q('#discuss-signin-btn'), null, 'a separate sign-in step is still offered');
    });

    test('a stored token does not make a disconnected page look signed in', async () => {
        const p = page({ wallet: '', stored: [{ token: 'tok-a', address: A }] });
        await p.open();
        assert.equal(p.q('#discuss-post-input'), null);
        assert.equal(p.fns.getDiscussSession(), null);
    });
});

describe('sign-in with the wallet changing underneath it', () => {
    test('a leftover token for another account is revoked when this account signs in; the new account is signed in by its own signature', async () => {
        const p = page({ wallet: C, stored: [{ token: 'tok-a', address: A }] });
        await p.open();
        assert.match(p.text(), /Posting as/);
        assert.ok(p.text().includes('Your wallet will ask you to confirm'));
        await p.type('as C'); await p.post();
        assert.equal(p.signCalls.length, 1);
        assert.ok(same(p.signCalls[0].address, C), 'the signature was asked of the wrong account');
        assert.notEqual(p.postCalls()[0].bearer, 'tok-a');
        assert.ok(same(p.server.posts[0].author, C));
        assert.equal(p.stored().token, 'tok-issued-1');
        assert.ok(!p.server.tokens.has('tok-a'), 'the other account\'s token was left alive on the server');
        assert.deepEqual(p.server.calls.filter(c => c.url === '/api/auth/logout').map(c => c.bearer), ['tok-a']);
    });

    test('the wallet changes while the signature is pending: nothing is posted, nothing stored, no token issued', async () => {
        const p = page({ wallet: A, rejectSign: (req, state) => { state.wallet = B; return { signature: '0x01' }; } });
        await p.open();
        await p.type('mine'); await p.post();
        assert.equal(p.postCalls().length, 0, 'posted under an address whose token does not match the active wallet');
        assert.equal(p.fns.getDiscussSession(), null);
        assert.equal(p.local.getItem(KEY), null, 'a token for a wallet that is no longer active was stored');
        assert.match(p.q('#discuss-post-error').textContent, /wallet changed/i);
        assert.equal(p.q('#discuss-post-input').value, 'mine');
        assert.ok(!p.server.calls.some(c => c.url === '/api/auth/verify'), 'a signature for the old wallet was still sent for a token');
        assert.deepEqual(p.server.tokens.size, 0, 'a token is alive on the server');
    });

    test('the wallet changes in another tab right after verify: the token is not stored and is revoked', async () => {
        const p = page({ wallet: A });
        await p.open();
        const base = p.local, realSet = base.setItem.bind(base);
        base.setItem = (k, v) => { realSet(k, v); if (k === KEY) p.state.wallet = B; };   // the other tab switches just as we write
        await p.type('x'); await p.post();
        assert.equal(p.postCalls().length, 0);
        assert.equal(p.local.getItem(KEY), null, 'a token for an address that is no longer active won the slot');
        assert.deepEqual(p.server.calls.filter(c => c.url === '/api/auth/logout').map(c => c.bearer), ['tok-issued-1']);
    });
});

describe('an expired token', () => {
    test('known to be expired: Post signs again, then posts', async () => {
        const p = page({ wallet: A, stored: [{ token: 'tok-old', address: A, expiresAt: Date.now() - 1000 }] });
        await p.open();
        assert.ok(p.q('#discuss-post-input'));
        assert.ok(p.text().includes('Your wallet will ask you to confirm'), 'an expired token was shown as signed in');
        await p.type('after a week'); await p.post();
        assert.equal(p.signCalls.length, 1);
        assert.equal(p.postCalls().length, 1);
        assert.equal(p.postCalls()[0].bearer, 'tok-issued-1');
    });

    test('rejected by the server (401) although the client thought it valid: forget it, sign once, retry once', async () => {
        const p = page({ wallet: A, stored: [{ token: 'tok-gone', address: A }], serverForgets: true });
        await p.open();
        await p.type('retry me'); await p.post();
        assert.equal(p.signCalls.length, 1);
        assert.deepEqual(p.postCalls().map(c => c.bearer), ['tok-gone', 'tok-issued-1']);
        assert.ok(p.text().includes('retry me'));
        assert.notEqual(p.stored().token, 'tok-gone', 'the dead token was kept');
        assert.equal(p.server.posts.length, 1, 'posted twice');
    });
});

describe('Edit follows the same flow', () => {
    // lib/discussion-edit.js builds the edit box with the global document.
    const withDoc = async (p, fn) => { const prev = globalThis.document; globalThis.document = p.doc; try { await fn(); } finally { globalThis.document = prev; } };
    test('connected without a token: Edit is offered on your own post, and Save signs then saves', async () => {
        const mine = { id: 7, threadId: 't1', author: A, content: 'old words', createdAt: 1 };
        const p = page({ wallet: A, posts: [mine] });
        await p.open();
        const btn = p.q('[data-edit-post="7"]');
        assert.ok(btn, 'a connected author cannot edit until signing in first');
        await withDoc(p, async () => {
            btn.click(); await flush();
            const form = p.q('.discussion-edit-form');
            form.querySelector('textarea').value = 'new words';
            form.querySelector('.discussion-edit-save').click(); await flush();
        });
        assert.equal(p.signCalls.length, 1);
        const patch = p.server.calls.filter(c => c.method === 'PATCH');
        assert.equal(patch.length, 1);
        assert.equal(patch[0].bearer, 'tok-issued-1');
        assert.ok(p.text().includes('new words'));
    });

    test('a rejected signature on Save keeps the edit box and its text', async () => {
        const mine = { id: 7, threadId: 't1', author: A, content: 'old words', createdAt: 1 };
        const p = page({ wallet: A, posts: [mine], rejectSign: true });
        await p.open();
        await withDoc(p, async () => {
            p.q('[data-edit-post="7"]').click(); await flush();
            const form = p.q('.discussion-edit-form');
            form.querySelector('textarea').value = 'unsaved';
            form.querySelector('.discussion-edit-save').click(); await flush();
        });
        assert.equal(p.server.calls.filter(c => c.method === 'PATCH').length, 0);
        assert.equal(p.q('.discussion-edit-form textarea').value, 'unsaved');
        assert.match(p.q('.discussion-edit-error').textContent, /cancel/i);
    });
});

describe('server auth is unchanged', () => {
    test('7-day session TTL, verify returns expiresIn, sessions stay keyed by token', () => {
        assert.match(SERVER, /const AUTH_SESSION_TTL = 7 \* 24 \* 60 \* 60 \* 1000;/);
        assert.match(SERVER, /res\.json\(\{ token, address, expiresIn: AUTH_SESSION_TTL \}\)/);
        assert.match(SERVER, /db\.createSession\(token, address, AUTH_SESSION_TTL\)/);
    });
});

describe('wiring', () => {
    test('script.js has no discussion sign-in wall left', () => {
        const code = stripComments(SCRIPT);
        assert.ok(!code.includes('discuss-signin-btn'), 'the sign-in button is still drawn');
        assert.ok(!code.includes('Sign in with your Substrate wallet to join'), 'the sign-in wall text is still there');
    });
    test('every 401 drops only the token that failed, never every account\'s', () => {
        const code = stripComments(SCRIPT);
        assert.ok(!/localStorage\.removeItem\(DISCUSS_TOKEN_KEY\)/.test(code), 'a 401 on one account wipes the others');
    });
});
