// R6 of the post-action refresh (design cto-team/plans/2026-11-22-post-action-refresh-design.md, sections 2,
// 3 rows 31 to 41, 4 "Second tab" and 9 "R6"; UX cto-team/plans/2026-11-22-post-action-refresh-ux.md U5, U10):
// the server actions (labels, discussion posts and edits, the discussion sign-in, the validator alert follow)
// notify the core once the SERVER confirmed them, and the other open tabs of the same browser follow through
// the known-results store's storage event: the same account only, never in a signed-out tab, never on a server
// failure, silently.
//
// Two tabs are two vm contexts, each with its own happy-dom document and its own copy of the REAL script.js
// code (the label editor and its actions, the discussion thread, the store and core lines), sharing ONE
// localStorage whose writes reach the OTHER tab as storage events when the test delivers them (a browser
// delivers them asynchronously, in order). The server is a fake that keeps labels and posts.
// Accounts are synthetic (32 bytes of one repeated value). DOM nodes are compared with assert.ok(a === b).

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { encodeAddress } from '@polkadot/util-crypto';
import { createPostAction } from '../lib/post-action.js';
import { createKnownResults } from '../lib/known-results.js';
import { effectsFor } from '../lib/action-effects.js';
import { caughtUp, pollDeadlineMs } from '../lib/freshness.js';
import { escapeHtml } from '../lib/html-escape.js';
import { DISCUSS_TOKEN_KEY, createDiscussAuth, signInForDiscussion, sendAsWallet, liveSessionFor, discussComposerHtml, discussErrorText } from '../lib/discussion-auth.js';
import { canEdit as canEditPost, renderPostList, renderEarlierDiscussion, wireEditing } from '../lib/discussion-edit.js';
import { readLinkedPostId, renderCopyLinkButton, wirePermalinks, focusLinkedPost } from '../lib/discussion-links.js';
import { composerHtml, wireComposer } from '../lib/discussion-composer.js';
import { renderLifecycleLinks } from '../lib/discussion-lifecycle.js';
import { closeControlHtml } from '../lib/close-control.js';
import { itemPathForThread } from '../lib/gov-detail.js';
import { mountAlertsControl } from '../lib/validator-alerts-view.js';
import { flush } from './helpers/tx-harness.js';
import { bodyOf, readRepo, stripComments } from './helpers/source.js';

// lib/server-refresh.js is new in R6: loaded so that a missing module fails the tests that need it, by name.
let SR = null;
before(async () => { SR = await import('../lib/server-refresh.js').catch(() => null); });
const needSR = () => { assert.ok(SR, 'lib/server-refresh.js is missing (R6: the server actions\' refresh, here and in the other tabs)'); return SR; };

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const ME = addr(181), X = addr(182), Y = addr(183);
const same = (a, b) => a === b;
const SCRIPT = readRepo('script.js', import.meta.url);
const has = (start) => SCRIPT.includes(start);
const line = (start) => { const i = SCRIPT.indexOf(start); assert.ok(i >= 0, 'not in script.js: ' + start); return SCRIPT.slice(i, SCRIPT.indexOf('\n', i)); };
const fn = (name) => { const b = bodyOf(SCRIPT, name); return (SCRIPT.includes('async ' + b.slice(0, 40)) ? 'async ' : '') + b; };
const optFn = (name) => (SCRIPT.includes(`function ${name}(`) ? fn(name) : '');

// --- one browser: shared storage, a fake server, tabs ---
function browser() {
    const data = new Map();
    const tabs = [];
    const queue = [];
    const world = { tabs, queue, fail: false, fetches: [], labels: new Map(), threads: new Map(), wallet: ME };
    const write = (from, key, value) => {
        const oldValue = data.has(key) ? data.get(key) : null;
        if (value === null) data.delete(key); else data.set(key, String(value));
        for (const t of tabs) if (t !== from) queue.push({ tab: t, ev: { key, oldValue, newValue: value === null ? null : String(value) } });
    };
    world.storageFor = (tab) => ({
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => write(tab, k, v),
        removeItem: (k) => write(tab, k, null),
        key: (i) => Array.from(data.keys())[i] ?? null,
        get length() { return data.size; },
        clear: () => { for (const k of Array.from(data.keys())) write(tab, k, null); }
    });
    // The browser hands every queued storage event to its tab, in order.
    world.deliver = async () => { while (queue.length) { const { tab, ev } = queue.shift(); for (const f of tab.storageListeners.slice()) f(ev); } await flush(); await flush(); };
    world.signIn = (address = ME) => { data.set(DISCUSS_TOKEN_KEY, JSON.stringify({ v: 3, token: 'tok-' + address.slice(0, 6), address, expiresAt: null })); };
    world.signOut = (tab) => { write(tab, DISCUSS_TOKEN_KEY, null); };
    world.raw = data;
    // the server
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
    const signerOf = (init) => { const h = (init && init.headers) || {}; const a = String(h.Authorization || h.authorization || ''); const tok = a.replace(/^Bearer /, ''); return tok ? ME : null; };
    world.fetch = (tab) => async (url, init = {}) => {
        const method = (init.method || 'GET').toUpperCase();
        world.fetches.push({ tab: tab.name, method, url: String(url) });
        let m = String(url).match(/^\/api\/labels\/([^/?]+)$/);
        if (m) {
            const a = decodeURIComponent(m[1]);
            const rows = world.labels.get(a) || [];
            if (method === 'GET') {
                const top = rows.slice().sort((p, q) => q.score - p.score)[0] || null;
                return json(200, { labels: rows.map(r => ({ ...r })), topLabel: top ? { label: top.label, signer: top.signer, isSelf: top.isSelf } : null });
            }
            if (world.fail) return json(500, { error: 'Server error, try again.' });
            const signer = signerOf(init);
            if (method === 'POST') {
                const { label } = JSON.parse(init.body);
                const others = rows.filter(r => r.signer !== signer);
                world.labels.set(a, [...others, { label, signer, isSelf: signer === a, score: 0, reportCount: 0, vetoed: false, viewerVote: 0, createdAt: 1 }]);
                return json(200, { ok: true });
            }
            if (method === 'DELETE') { world.labels.set(a, rows.filter(r => r.signer !== signer)); return json(200, { ok: true }); }
        }
        m = String(url).match(/^\/api\/discussions\/([^/?]+)(\/posts)?$/);
        if (m) {
            const id = decodeURIComponent(m[1]);
            const t = world.threads.get(id) || { thread: { id, title: 'Referendum 7', status: 'open', links: null }, posts: [] };
            world.threads.set(id, t);
            if (method === 'GET') return json(200, { thread: t.thread, posts: t.posts.slice(), earlier: [] });
            if (world.fail) return json(500, { error: 'Server error, try again.' });
            const { content } = JSON.parse(init.body);
            t.posts.push({ id: t.posts.length + 1, threadId: id, author: signerOf(init), content, createdAt: 2, editedAt: null });
            return json(200, { thread: t.thread, posts: t.posts.slice() });
        }
        return json(404, { error: 'not found' });
    };
    return world;
}

const SCRIPT_PARTS = () => [
    line('const addressTopLabelCache = new Map();'), line('const addressLabelsCache   = new Map();'),
    fn('invalidateAddressLabelCache'), fn('fetchAddressLabel'), fn('fetchLabelsJson'), optFn('applyAddressLabelToDom'), fn('ensureAddressLabel'),
    fn('renderAccountLabelEditor'), fn('ensureLabelSession'), fn('liveLabelSession'),
    fn('labelVote'), fn('labelDeleteMine'), fn('labelReport'), fn('labelVeto'),
    fn('discussAuthStore'), fn('getDiscussSession'), fn('discussSignInFor'), fn('discussSend'),
    fn('fetchDiscussionThread'), fn('renderThread'), fn('submitDiscussionPost'),
    line('const knownResults = createKnownResults('), line('const postAction = createPostAction('),
    has('const serverRefresh = createServerRefresh(') ? line('const serverRefresh = createServerRefresh(') : '',
    'globalThis.__tab = { knownResults, postAction, renderAccountLabelEditor, ensureAddressLabel, fetchDiscussionThread, submitDiscussionPost };'
].join('\n');

function openTab(world, name, { path = '/' } = {}) {
    const win = new Window({ url: 'http://localhost' + path });
    const doc = win.document;
    const tab = { name, win, doc, storageListeners: [], alerts: [] };
    world.tabs.push(tab);
    const storage = world.storageFor(tab);
    const fakeWin = { localStorage: storage, addEventListener: (type, f) => { if (type === 'storage') tab.storageListeners.push(f); }, location: win.location, CSS: win.CSS };
    const ctx = {
        window: fakeWin, document: doc, localStorage: storage, navigator: { clipboard: { writeText: async () => {} } }, CSS: win.CSS, console,
        setTimeout, clearTimeout, queueMicrotask, Promise, URLSearchParams, Date, Math, JSON, Map, Set, Array, Object, String, Number, Error,
        fetch: world.fetch(tab), alert: (m) => tab.alerts.push(m), confirm: () => true, prompt: () => '',
        globalApi: { genesisHash: { toHex: () => '0x' + 'aa'.repeat(32) } },
        isSameAddress: same, getStoredWallet: () => world.wallet, walletSession: { signingCheck: () => () => true },
        stakingEscapeHtml: escapeHtml, stakingShortAddress: (a) => String(a).slice(0, 6), formatLocalDateTime: (t) => 'T' + t, helpIcon: () => '',
        createKnownResults, createPostAction, effectsFor, caughtUp, pollDeadlineMs,
        createServerRefresh: SR && SR.createServerRefresh, applyAddressLabel: SR && SR.applyAddressLabel,
        DISCUSS_TOKEN_KEY, createDiscussAuth, signInForDiscussion, sendAsWallet, liveSessionFor, discussComposerHtml, discussErrorText,
        canEditPost, renderPostList, renderEarlierDiscussion, wireEditing, readLinkedPostId, renderCopyLinkButton, wirePermalinks, focusLinkedPost,
        composerHtml, wireComposer, renderLifecycleLinks, closeControlHtml, itemPathForThread,
        logoutDiscussToken: () => {}, getWalletSigner: async () => null, discussSignIn: async () => false
    };
    vm.createContext(ctx);
    vm.runInContext(SCRIPT_PARTS(), ctx);
    tab.api = ctx.__tab;
    tab.q = (s) => doc.querySelector(s);
    return tab;
}

// An account page: the address cell with its pill, and the label editor.
async function accountPage(tab, a) {
    tab.doc.body.innerHTML = `<table><tr><td class="address-cell address-with-label" data-address="${a}">${a}</td></tr></table><div id="account-label-editor"></div>`;
    tab.api.ensureAddressLabel(a);
    await tab.api.renderAccountLabelEditor(a);
    await flush();
}
const pill = (tab, a) => { const n = tab.doc.querySelector(`.address-with-label[data-address="${a}"] .addr-label`); return n ? n.textContent : null; };
const editorText = (tab) => (tab.q('#account-label-editor') || { textContent: '' }).textContent;
async function saveLabel(tab, text) {
    tab.q('#account-label-input').value = text;
    tab.q('#account-label-save').click();
    await flush(); await flush();
}

describe('R6 rows 33 to 37: a label saved on an account page shows on the same account in another open tab', () => {
    test('tab A saves a label for X: tab A and tab B (same account, signed in) show it without a reload', async () => {
        needSR();
        const w = browser(); w.signIn();
        const A = openTab(w, 'A'), B = openTab(w, 'B');
        await accountPage(A, X); await accountPage(B, X);
        assert.equal(pill(B, X), null);
        await saveLabel(A, 'Cold storage');
        assert.equal(pill(A, X), 'Cold storage', 'this tab: the pill');
        assert.match(editorText(A), /Cold storage/, 'this tab: the editor');
        await w.deliver();
        assert.equal(pill(B, X), 'Cold storage', 'the other tab: the pill of the same account');
        assert.match(editorText(B), /Cold storage/, 'the other tab: the editor of the same account');
        assert.deepEqual(B.alerts, [], 'silently');
    });
    test('a tab showing ANOTHER account does not read or change anything', async () => {
        needSR();
        const w = browser(); w.signIn();
        const A = openTab(w, 'A'), C = openTab(w, 'C');
        await accountPage(A, X); await accountPage(C, Y);
        const before = C.q('#account-label-editor').innerHTML;
        const reads = w.fetches.filter(f => f.tab === 'C').length;
        await saveLabel(A, 'Exchange');
        await w.deliver();
        assert.equal(w.fetches.filter(f => f.tab === 'C').length, reads, 'tab C read something for another account');
        assert.equal(C.q('#account-label-editor').innerHTML, before);
        assert.equal(pill(C, Y), null);
    });
    test('a signed-out tab does not follow: the sign-out lands before the other tab takes the notice', async () => {
        needSR();
        const w = browser(); w.signIn();
        const A = openTab(w, 'A'), B = openTab(w, 'B');
        await accountPage(A, X); await accountPage(B, X);
        const reads = w.fetches.filter(f => f.tab === 'B').length;
        await saveLabel(A, 'Treasury');
        w.signOut(A);
        await w.deliver();
        assert.equal(pill(B, X), null, 'a signed-out tab drew the label');
        assert.equal(w.fetches.filter(f => f.tab === 'B').length, reads, 'a signed-out tab re-read the labels');
    });
    test('a server failure shows nothing new: the error in this tab, no notice, the other tab untouched', async () => {
        needSR();
        const w = browser(); w.signIn();
        const A = openTab(w, 'A'), B = openTab(w, 'B');
        await accountPage(A, X); await accountPage(B, X);
        w.fail = true;
        const readsB = w.fetches.filter(f => f.tab === 'B').length;
        await saveLabel(A, 'Nope');
        assert.match(A.q('#account-label-status').textContent, /Server error/);
        assert.equal(pill(A, X), null);
        const stored = JSON.parse(w.raw.get('pdex_known_results') || '[]');
        assert.equal(stored.filter(e => e.op === 'notice').length, 0, 'a notice was written for a failed request');
        await w.deliver();
        assert.equal(w.fetches.filter(f => f.tab === 'B').length, readsB);
        assert.equal(pill(B, X), null);
    });
    test('delete: the pill leaves in both tabs once the server confirmed', async () => {
        needSR();
        const w = browser(); w.signIn();
        w.labels.set(X, [{ label: 'Old name', signer: ME, isSelf: false, score: 0, reportCount: 0, vetoed: false, viewerVote: 0, createdAt: 1 }]);
        const A = openTab(w, 'A'), B = openTab(w, 'B');
        await accountPage(A, X); await accountPage(B, X);
        assert.equal(pill(A, X), 'Old name'); assert.equal(pill(B, X), 'Old name');
        A.q('.label-delete-btn').click();
        await flush(); await flush();
        assert.equal(pill(A, X), null, 'this tab');
        await w.deliver();
        assert.equal(pill(B, X), null, 'the other tab');
    });
    test('U5: the other tab keeps a label being typed; its pill still follows', async () => {
        needSR();
        const w = browser(); w.signIn();
        const A = openTab(w, 'A'), B = openTab(w, 'B');
        await accountPage(A, X); await accountPage(B, X);
        const typing = B.q('#account-label-input');
        typing.value = 'half writ';
        await saveLabel(A, 'Validator');
        await w.deliver();
        assert.ok(B.q('#account-label-input') === typing, 'the field being typed in was replaced');
        assert.equal(typing.value, 'half writ');
        assert.equal(pill(B, X), 'Validator');
    });
    test('a notice is taken once, and a tab opened after it does not replay it', async () => {
        needSR();
        const w = browser(); w.signIn();
        const A = openTab(w, 'A'), B = openTab(w, 'B');
        await accountPage(A, X); await accountPage(B, X);
        await saveLabel(A, 'One');
        await w.deliver();
        const reads = w.fetches.filter(f => f.tab === 'B').length;
        w.queue.push({ tab: B, ev: { key: 'pdex_known_results', oldValue: w.raw.get('pdex_known_results'), newValue: w.raw.get('pdex_known_results') } });
        await w.deliver();
        assert.equal(w.fetches.filter(f => f.tab === 'B').length, reads, 'the same notice was taken twice');
        const D = openTab(w, 'D');
        await accountPage(D, X);
        const readsD = w.fetches.filter(f => f.tab === 'D').length;
        w.queue.push({ tab: D, ev: { key: 'pdex_known_results', oldValue: null, newValue: w.raw.get('pdex_known_results') } });
        await w.deliver();
        assert.equal(w.fetches.filter(f => f.tab === 'D').length, readsD, 'a notice from before the tab opened was replayed');
    });
});

// The thread pane as the discussions page draws it.
async function threadPage(tab, id) {
    tab.doc.body.innerHTML = '<div id="discussions-content"></div>';
    await tab.api.fetchDiscussionThread(id, false, tab.q('#discussions-content'));
    await flush();
}
const postsText = (tab) => Array.from(tab.doc.querySelectorAll('.discussion-posts')).map(n => n.textContent).join(' ');

describe('R6 rows 31, 32: a discussion post appears in the thread, here and in the other tab, without a reload', () => {
    test('tab A posts: the post is in A at once, and in B (same thread) after the storage event, with no Loading paint', async () => {
        needSR();
        const w = browser(); w.signIn();
        const A = openTab(w, 'A'), B = openTab(w, 'B');
        await threadPage(A, 'ref-7'); await threadPage(B, 'ref-7');
        A.q('#discuss-post-input').value = 'First thoughts';
        const readsA = w.fetches.filter(f => f.tab === 'A' && f.method === 'GET').length;
        await A.api.submitDiscussionPost('ref-7', A.q('#discussions-content'));
        await flush();
        assert.match(postsText(A), /First thoughts/);
        assert.equal(w.fetches.filter(f => f.tab === 'A' && f.method === 'GET').length, readsA, 'this tab re-read the thread it just drew');
        const painted = [];
        new B.win.MutationObserver(() => { if (/Loading discussion/.test(B.q('#discussions-content').textContent)) painted.push(1); }).observe(B.q('#discussions-content'), { childList: true, subtree: true });
        await w.deliver(); await flush();
        assert.match(postsText(B), /First thoughts/, 'the other tab did not follow');
        assert.equal(painted.length, 0, 'the other tab painted "Loading" over the thread');
    });
    test('the other tab on ANOTHER thread does not re-read; a server failure adds nothing anywhere', async () => {
        needSR();
        const w = browser(); w.signIn();
        const A = openTab(w, 'A'), C = openTab(w, 'C');
        await threadPage(A, 'ref-7'); await threadPage(C, 'ref-8');
        const readsC = w.fetches.filter(f => f.tab === 'C').length;
        A.q('#discuss-post-input').value = 'Hello';
        await A.api.submitDiscussionPost('ref-7', A.q('#discussions-content'));
        await w.deliver();
        assert.equal(w.fetches.filter(f => f.tab === 'C').length, readsC);
        w.fail = true;
        const B = openTab(w, 'B');
        await threadPage(B, 'ref-7');
        const readsB = w.fetches.filter(f => f.tab === 'B').length;
        A.q('#discuss-post-input').value = 'Second';
        await A.api.submitDiscussionPost('ref-7', A.q('#discussions-content'));
        await w.deliver();
        assert.doesNotMatch(postsText(A), /Second/);
        assert.equal(w.fetches.filter(f => f.tab === 'B').length, readsB);
    });
    test('U5: the other tab keeps a reply being written', async () => {
        needSR();
        const w = browser(); w.signIn();
        const A = openTab(w, 'A'), B = openTab(w, 'B');
        await threadPage(A, 'ref-7'); await threadPage(B, 'ref-7');
        const draft = B.q('#discuss-post-input');
        draft.value = 'my reply in progress';
        A.q('#discuss-post-input').value = 'Posted in A';
        await A.api.submitDiscussionPost('ref-7', A.q('#discussions-content'));
        await w.deliver();
        assert.ok(B.q('#discuss-post-input') === draft, 'the reply being written was replaced');
        assert.equal(draft.value, 'my reply in progress');
    });
    test('edit (row 32): the save path tells the other tabs after it drew the server\'s answer', () => {
        const code = stripComments(bodyOf(SCRIPT, 'renderThread'));
        const at = code.indexOf('onUpdated: d => {');
        assert.ok(at !== -1, 'onUpdated draws and notifies in one block');
        const block = code.slice(at, code.indexOf('});', at));
        assert.ok(block.indexOf('renderThread(') !== -1 && block.indexOf('serverRefresh.thread(thread.id, root)') > block.indexOf('renderThread('), block);
    });
});

describe('R6 row 38: an alert follow shows its state; the core hears only a confirmed follow', () => {
    const mount = async (post) => {
        const win = new Window({ url: 'http://localhost/validate/x' });
        const el = win.document.createElement('div');
        win.document.body.appendChild(el);
        const notes = [];
        await mountAlertsControl(el, { stash: X, esc: escapeHtml, fetchJson: async () => ({ enabled: true, maxPerEmail: 5 }), postJson: post, notify: (o) => notes.push(o) });
        el.querySelector('#validate-alerts-email').value = 'someone@example.com';
        el.querySelector('#validate-alerts-form').dispatchEvent(new win.Event('submit', { cancelable: true }));
        await flush();
        return { el, notes };
    };
    test('confirmed by the server: the message shows, and the core is told about this stash\'s alerts', async () => {
        const { el, notes } = await mount(async () => ({ message: 'If this address can receive alerts, a confirmation email is on its way.' }));
        assert.match(el.querySelector('#validate-alerts-msg').textContent, /confirmation email is on its way/);
        assert.deepEqual(notes, [{ account: X, domains: ['alerts'], reason: 'server' }]);
    });
    test('a server failure: its message, and nothing for the core', async () => {
        const { el, notes } = await mount(async () => { throw new Error('Could not set up alerts. Try again.'); });
        assert.match(el.querySelector('#validate-alerts-msg').textContent, /Could not set up alerts/);
        assert.deepEqual(notes, []);
    });
    test('the status page hands the core\'s notify to the alerts control', () => {
        const src = stripComments(readRepo('lib/validator-status-view.js', import.meta.url));
        assert.match(src, /mountAlertsControl\([^\n]*notify: [^\n]*\.notify\(o\)/);
    });
});

// --- the core and the store (lib/post-action.js server(), lib/known-results.js op 'notice') ---
function pair({ sessionA = () => ME, sessionB = () => ME, genesis } = {}) {
    const w = browser();
    const mk = (name, session) => {
        const tab = { name, storageListeners: [] };
        w.tabs.push(tab);
        const known = createKnownResults({ storage: w.storageFor(tab), same, listen: (f) => tab.storageListeners.push(f), genesis });
        const post = createPostAction({ effects: effectsFor, known, same, session, setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (t) => clearTimeout(t) });
        return { ...tab, known, post, tab };
    };
    return { w, A: mk('A', sessionA), B: mk('B', sessionB) };
}
const listen = (post, domains, shown) => {
    const got = [];
    post.subscribe(domains, { account: () => shown, reload: (c) => { got.push(c); return null; } });
    return got;
};

describe('R6 core: server() and the notices other tabs take', () => {
    test('server(): this tab\'s subscribers of that account and domain reload at once; a notice is stored for the others', () => {
        const { w, A } = pair();
        const here = listen(A.post, ['labels'], X);
        assert.equal(typeof A.post.server, 'function', 'post-action has no server()');
        A.post.server({ account: X, domains: ['labels'], who: ME });
        assert.equal(here.length, 1);
        assert.equal(here[0].reason, 'server'); assert.equal(here[0].origin, 'self'); assert.equal(here[0].account, X);
        const stored = JSON.parse(w.raw.get('pdex_known_results'));
        assert.deepEqual(stored.map(e => [e.op, e.account, e.domain, e.value]), [['notice', X, 'labels', ME]]);
    });
    test('the other tab: same account and signed in as the actor -> reload with origin other-tab; other account or signed out -> nothing', async () => {
        let bSession = ME;
        const { w, A, B } = pair({ sessionB: () => bSession });
        const sameAcct = listen(B.post, ['labels'], X), other = listen(B.post, ['labels'], Y), chain = listen(B.post, ['balance'], X);
        A.post.server({ account: X, domains: ['labels'], who: ME });
        await w.deliver();
        assert.equal(sameAcct.length, 1); assert.equal(sameAcct[0].origin, 'other-tab'); assert.equal(sameAcct[0].account, X);
        assert.equal(other.length, 0, 'another account reloaded');
        assert.equal(chain.length, 0, 'a notice repainted the chain domains of the other tab');
        bSession = null;
        A.post.server({ account: X, domains: ['labels'], who: ME });
        await w.deliver();
        assert.equal(sameAcct.length, 1, 'a signed-out tab followed');
        bSession = Y;
        A.post.server({ account: X, domains: ['labels'], who: ME });
        await w.deliver();
        assert.equal(sameAcct.length, 1, 'a tab signed in as someone else followed');
    });
    test('no actor (who null): this tab only, nothing stored; a domain that is not a server domain is ignored', () => {
        const { w, A } = pair();
        const here = listen(A.post, ['alerts'], X);
        A.post.server({ account: X, domains: ['alerts'] });
        A.post.server({ account: X, domains: ['balance'], who: ME });
        assert.equal(here.length, 1);
        assert.equal(w.raw.get('pdex_known_results') ?? null, null);
    });
    test('a proof written by the other tab still repaints its chain subscribers; server-only subscribers are not part of that', async () => {
        const { w, A, B } = pair({ genesis: () => '0xg' });
        const chain = listen(B.post, ['balance'], X), labels = listen(B.post, ['labels'], X);
        A.known.add([{ op: 'remove', account: X, domain: 'rewards.unpaid', key: '1:v', block: 5, txHash: '0x1' }]);
        await w.deliver();
        assert.equal(chain.length, 1);
        assert.equal(labels.length, 0);
        B.post.resume(); B.post.accountChanged(X);
        assert.equal(labels.length, 0, 'resume or a wallet switch re-read a server-only component');
    });
    test('a notice is never an overlay: not applied, not listed, no bound; written while the genesis is unknown', () => {
        let g = null;
        const { A } = pair({ genesis: () => g });
        A.post.server({ account: X, domains: ['labels'], who: ME });
        assert.equal(A.known.notices().length, 1);
        g = '0xg';
        assert.equal(A.known.list('labels', X).length, 0);
        assert.equal(A.known.apply('labels', X, [{ key: A.known.notices()[0].key }]).rows.length, 1);
        assert.equal(A.known.nextBound(), null);
    });
    test('notices are capped and never push out a proof (maxEntries)', () => {
        const w = browser();
        const tab = { storageListeners: [] }; w.tabs.push(tab);
        const known = createKnownResults({ storage: w.storageFor(tab), maxEntries: 5, maxNotices: 3 });
        known.add([1, 2, 3, 4].map(i => ({ op: 'remove', account: X, domain: 'rewards.unpaid', key: `${i}:v`, block: i, txHash: '0x' + i })));
        for (let i = 0; i < 6; i++) known.add([{ op: 'notice', account: X, domain: 'labels', key: 'n' + i, value: ME }]);
        assert.equal(known.list('rewards.unpaid', X).length, 4, 'a notice evicted a proof');
        assert.deepEqual(known.notices().map(n => n.key), ['n5']);
        const k2 = createKnownResults({ storage: w.storageFor(tab), maxEntries: 50, maxNotices: 3 });
        for (let i = 0; i < 6; i++) k2.add([{ op: 'notice', account: X, domain: 'labels', key: 'm' + i, value: ME }]);
        assert.deepEqual(k2.notices().map(n => n.key), ['m3', 'm4', 'm5']);
    });
    test('a notice ages out after a minute', () => {
        let t = 1_000_000;
        const w = browser();
        const tab = { storageListeners: [] }; w.tabs.push(tab);
        const known = createKnownResults({ storage: w.storageFor(tab), now: () => t });
        known.add([{ op: 'notice', account: X, domain: 'labels', key: 'n1', value: ME }]);
        t += 59_000; assert.equal(known.notices().length, 1);
        t += 2_000; assert.equal(known.notices().length, 0);
    });
});

describe('R6 wiring in script.js', () => {
    const code = stripComments(SCRIPT);
    test('every label write tells the core only after the server answered ok (save, vote, delete, report, veto)', () => {
        for (const name of ['labelVote', 'labelDeleteMine', 'labelReport', 'labelVeto']) {
            const b = stripComments(bodyOf(SCRIPT, name));
            const okAt = b.search(/if \(!res\.ok \|\| data\.error\) throw/);
            const at = b.indexOf('serverRefresh.labels(address)');
            assert.ok(okAt !== -1 && at > okAt, `${name}: serverRefresh.labels(address) after the server's ok`);
        }
        const editor = stripComments(bodyOf(SCRIPT, 'renderAccountLabelEditor'));
        const save = editor.slice(editor.indexOf("saveBtn.addEventListener('click'"));
        assert.ok(save.indexOf('serverRefresh.labels(address)') > save.search(/Failed to save label/), 'save: after the server\'s ok');
    });
    test('the discussion post tells the core after drawing the server\'s answer; the thread registers where it is drawn', () => {
        const b = stripComments(bodyOf(SCRIPT, 'submitDiscussionPost'));
        assert.ok(b.indexOf('serverRefresh.thread(threadId, root)') > b.indexOf('renderThread(data.thread'));
        assert.match(stripComments(bodyOf(SCRIPT, 'renderThread')), /serverRefresh\.threadShown\(root, thread\.id, opts\)/);
    });
    test('the core is told who is signed in; the sign-in tells the other tabs', () => {
        assert.match(line('const postAction = createPostAction('), /session: \(\) => \(getDiscussSession\(\) \|\| \{\}\)\.address \|\| null/);
        assert.match(stripComments(bodyOf(SCRIPT, 'discussSignInFor')), /serverRefresh\.signedIn\(address\)/);
    });
    test('leftover: the multisig review gets no whole-wallet remount fallback (the core is always there)', () => {
        const deps = stripComments(bodyOf(SCRIPT, 'multisigUIDeps'));
        assert.doesNotMatch(deps, /refresh: address => refreshWalletDashboardFor/);
        assert.match(deps, /post: \(\) => postAction/);
    });
    test('the label pill is drawn by lib/server-refresh.js; script.js keeps no copy', () => {
        assert.ok(!code.includes('function applyAddressLabelToDom('), 'script.js still has its own applyAddressLabelToDom');
        assert.match(stripComments(bodyOf(SCRIPT, 'ensureAddressLabel')), /applyAddressLabel\(document, address, top\)/);
    });
});

describe('R6 characterisation: the label pill is drawn as before', () => {
    test('one pill per container, replaced not doubled, self vs community class and title', () => {
        const { applyAddressLabel } = needSR();
        const win = new Window({ url: 'http://localhost/' });
        const doc = win.document;
        doc.body.innerHTML = `<div class="address-with-label" data-address="${X}">${X}</div><span class="address-with-label" data-address="${X}"><span class="addr-label">old</span>x</span><div class="address-with-label" data-address="${Y}">y</div>`;
        applyAddressLabel(doc, X, { label: 'Owner', isSelf: true });
        const nodes = doc.querySelectorAll(`[data-address="${X}"] .addr-label`);
        assert.equal(nodes.length, 2);
        for (const n of nodes) {
            assert.equal(n.className, 'addr-label'); assert.equal(n.textContent, 'Owner');
            assert.equal(n.title, 'Self-set label (signed by the address owner)');
            assert.ok(n.parentNode.firstChild === n);
        }
        applyAddressLabel(doc, X, { label: 'Suggested', isSelf: false });
        const again = doc.querySelectorAll(`[data-address="${X}"] .addr-label`);
        assert.equal(again.length, 2);
        assert.equal(again[0].className, 'addr-label community');
        assert.equal(again[0].title, 'Community-suggested label · click the address to see other suggestions');
        assert.equal(doc.querySelectorAll(`[data-address="${Y}"] .addr-label`).length, 0);
        applyAddressLabel(doc, X, null);
        assert.equal(doc.querySelectorAll(`[data-address="${X}"] .addr-label`).length, 2, 'no label: nothing removed (as before)');
    });
});
