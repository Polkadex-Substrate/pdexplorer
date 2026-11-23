// Issue #70 follow-ups (review lows), on top of test/wallet-session-revision.test.js.
//
//   1. The discussion "Sign in with wallet" (signRaw) compared addresses only, so
//      A -> Disconnect -> A, or the same key from another extension, while the
//      wallet was signing still stored a token. It now takes the same
//      wallet-session revision and source check as a transaction.
//   2. A flow that captured its wallet before a confirm() (Clear identity) must
//      capture the session revision at that moment, not later at submit entry.
//      The multisig review does the same when it opens.
//   3. The refusals before the wallet is asked all use one stale-request wording.
//   4. The multisig member signer path and the WalletConnect signer path obey the
//      same rule as an extension account.
//
// Real submitSignedTx / submitClearIdentity / discussSignInFor from script.js run
// in the wallet-world tab (test/helpers/wallet-world.js). Chain and wallet
// signatures are synthetic and held open by the test; nothing is ever broadcast.
// Addresses are synthetic.

import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { trackSignedTx } from '../lib/tx-submit.js';
import { buildTxModel } from '../lib/tx-status.js';
import { signInForDiscussion, createDiscussAuth } from '../lib/discussion-auth.js';
import { bodyOf } from './helpers/source.js';
import { makeProfile, openTab, fakeExtension, addr, memStorage, C } from './helpers/wallet-world.js';
import { createMultisigUI } from '../lib/multisig-view.js';
import { normalizeMultisig } from '../lib/multisig.js';
import { createPostAction } from '../lib/post-action.js';
import { createKnownResults } from '../lib/known-results.js';
import { effectsFor } from '../lib/action-effects.js';

const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const A = addr(1), B = addr(2), M = addr(9);
const STALE = 'This request is out of date because your wallet changed. Start again.';
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

const openTabs = [];
const closeTabs = () => { while (openTabs.length) { try { openTabs.pop().close(); } catch (e) { /* already closed */ } } };
const fakeButton = () => ({ disabled: false, attrs: {}, innerHTML: 'Go', textContent: '',
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } });

function fakeWcGate(accounts) {
    const g = {
        enabled: true, connected: true, disconnects: 0,
        signer: { wc: true, signPayload: async () => ({ id: 1, signature: '0x' }), signRaw: async () => ({ id: 2, signature: '0x' }) },
        providers() {
            if (!g.connected) return {};
            return { walletconnect: { enable: async () => ({ accounts: { get: async () => accounts.map(a => ({ ...a })) }, signer: g.signer }) } };
        },
        isConnected: () => g.connected, peerName: () => 'Test phone',
        connect: async () => accounts, disconnect: async () => { g.disconnects++; g.connected = false; }, restore: async () => accounts
    };
    return g;
}

// opts.wc: sign with the paired phone (the account is addr(1, 0) from WalletConnect).
// opts.member: the active wallet is the multisig M; A signs as a member (multisig-view.js path).
function world({ wc = false, member = false } = {}) {
    const ext = fakeExtension('polkadot-js', [{ address: addr(1, 42), name: 'One' }, { address: addr(2, 42), name: 'Two' }]);
    const talisman = fakeExtension('talisman', [{ address: addr(1, 0), name: 'One (Talisman)' }]);
    const profile = makeProfile({ extensions: wc ? [] : [ext, talisman] });
    const gate = wc ? fakeWcGate([{ address: addr(1, 0), name: 'Phone account' }]) : null;
    if (gate) profile.wcGate = gate;
    const tab = openTab(profile, { path: '/wallet' });
    openTabs.push(tab);
    const api = {
        registry: {}, on() {}, off() {},
        consts: { balances: { existentialDeposit: 1n } },
        query: { system: { account: async () => ({ nonce: 0, data: { free: 10n ** 20n, reserved: 0n, frozen: 0n } }) } },
        rpc: { chain: { getHeader: async () => ({ number: { toNumber: () => 9 } }) } }
    };
    const calls = { sign: 0, send: 0, signAndSend: 0, errors: [], signers: [] };
    const hold = { build: null, enable: null };
    const signature = deferred();
    const signed = { nonce: 4, send: () => { calls.send++; return Promise.resolve(() => {}); } };
    const tx = {
        paymentInfo: async () => ({ partialFee: 1n }),
        signAsync: (_a, opts) => { calls.sign++; calls.signers.push(opts && opts.signer); return signature.promise; },
        signAndSend: () => { calls.signAndSend++; return Promise.resolve(() => {}); }
    };
    const button = fakeButton();
    const multisigFind = { value: () => null };
    const reviews = [];
    Object.assign(tab.ctx, {
        globalApi: api, liveRuntimeError: () => null, isMobileDevice: () => false,
        multisigStore: { find: (a) => multisigFind.value(a) },
        multisigUI: { mountAccounts() {}, review: async (r) => { reviews.push(r); } },
        showTxStatus: (a, st, ev, err, ex) => buildTxModel(a, st, ev, err, ex),
        postAction: createPostAction({ effects: effectsFor, known: createKnownResults({ storage: null }) }),   // R1: submitSignedTx observes every submission (real core)
        trackSignedTx, WALLET_CHANGED_STALE: STALE, confirm: () => true, alert: () => {}
    });
    vm.runInContext('async ' + bodyOf(SCRIPT, 'submitSignedTx'), tab.ctx);
    const origEnable = ext.provider.enable;
    ext.provider.enable = async () => { if (hold.enable) await hold.enable.promise; return origEnable(); };
    if (wc) tab.fn('selectWallet')(addr(1, 0), 'walletconnect');
    else if (member) { multisigFind.value = () => ({ name: 'Team' }); tab.fn('selectWallet')(M, 'polkadot-js'); }
    else tab.fn('selectWallet')(A, 'polkadot-js');
    const w = {
        profile, tab, calls, button, hold, ext, gate, reviews, multisigFind, signed, tx, api,
        broadcasts: () => calls.send + calls.signAndSend,
        submit: (extra = {}) => tab.fn('submitSignedTx')({ buildTx: () => (hold.build ? hold.build.promise.then(() => tx) : tx), label: 'Test', button, idleText: 'Go',
            onError: (m) => calls.errors.push(m),
            ...(member ? { signingAccount: { address: addr(1, 42), source: 'polkadot-js', name: 'One' }, multisigHandled: true } : {}), ...extra }),
        async startAndHoldSignature(extra) {
            const done = w.submit(extra);
            await flush();
            assert.equal(calls.sign, 1, 'the wallet was not asked to sign');
            return { done };
        },
        releaseSignature: () => signature.resolve(signed)
    };
    return w;
}

function assertStaleSigned(w) {
    assert.equal(w.broadcasts(), 0, 'the old signature was broadcast after the wallet session changed');
    assert.equal(w.calls.errors.length, 1, JSON.stringify(w.calls.errors));
    assert.match(w.calls.errors[0], /out of date/i);
    assert.match(w.calls.errors[0], /nothing was sent/i);
    assert.equal(w.button.disabled, false);
}

describe('#70 follow-up 3: the refusals before the wallet is asked use the stale-request wording', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => { mock.timers.reset(); closeTabs(); });

    test('multisig wallet: the session changes while the call is built, so the review is never opened', async () => {
        const w = world();
        w.multisigFind.value = () => ({ name: 'Team' });
        w.hold.build = deferred();
        const done = w.submit();
        await flush();
        w.tab.fn('selectWallet')(B, 'polkadot-js');
        w.tab.fn('selectWallet')(A, 'polkadot-js');
        w.hold.build.resolve();
        await done; await flush();
        assert.equal(w.reviews.length, 0, 'the multisig review opened for a stale request');
        assert.deepEqual(w.calls.errors, [STALE]);
    });

    test('the session changes while the extension is asked for its accounts: refused, wallet never asked to sign', async () => {
        const w = world();
        w.hold.enable = deferred();
        const done = w.submit();
        await flush();
        w.tab.fn('selectWallet')(B, 'polkadot-js');
        w.tab.fn('selectWallet')(A, 'polkadot-js');
        w.hold.enable.resolve();
        await done; await flush();
        assert.equal(w.calls.sign, 0);
        assert.deepEqual(w.calls.errors, [STALE]);
    });

    test('the session changes while the transaction is built (after the wallet lookup): refused', async () => {
        const w = world();
        w.hold.build = deferred();
        const done = w.submit();
        await flush();
        w.tab.fn('selectWallet')(B, 'polkadot-js');
        w.tab.fn('selectWallet')(A, 'polkadot-js');
        w.hold.build.resolve();
        await done; await flush();
        assert.equal(w.calls.sign, 0);
        assert.deepEqual(w.calls.errors, [STALE]);
    });
});

describe('#70 follow-up 4: the multisig member signer path', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => { mock.timers.reset(); closeTabs(); });

    test('the multisig is the active wallet, a member signs; the session goes M -> B -> M while signing: zero broadcasts', async () => {
        const w = world({ member: true });
        const { done } = await w.startAndHoldSignature();
        w.tab.fn('selectWallet')(B, 'polkadot-js');
        w.tab.fn('selectWallet')(M, 'polkadot-js');
        w.releaseSignature();
        await done; await flush();
        assertStaleSigned(w);
    });

    test('M -> Disconnect -> M while signing: zero broadcasts', async () => {
        const w = world({ member: true });
        const { done } = await w.startAndHoldSignature();
        w.tab.fn('disconnectWallet')();
        w.tab.fn('selectWallet')(M, 'polkadot-js');
        w.releaseSignature();
        await done; await flush();
        assertStaleSigned(w);
    });

    test('nothing changes: the member signs once and it is broadcast', async () => {
        const w = world({ member: true });
        const { done } = await w.startAndHoldSignature();
        w.releaseSignature();
        await done; await flush();
        assert.equal(w.calls.send, 1);
        assert.deepEqual(w.calls.errors, []);
    });
});

describe('#70 follow-up 4: the WalletConnect (phone) signer path', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => { mock.timers.reset(); closeTabs(); });

    test('signs through the phone signer, and a normal run is broadcast once', async () => {
        const w = world({ wc: true });
        const { done } = await w.startAndHoldSignature();
        assert.equal(w.calls.signers[0] && w.calls.signers[0].wc, true, 'the phone signer was not the one asked');
        w.releaseSignature();
        await done; await flush();
        assert.equal(w.calls.send, 1);
        assert.deepEqual(w.calls.errors, []);
    });

    test('phone account -> Disconnect -> the phone account again while signing: zero broadcasts', async () => {
        const w = world({ wc: true });
        const { done } = await w.startAndHoldSignature();
        w.tab.fn('disconnectWallet')();
        w.gate.connected = true;   // re-paired
        w.tab.fn('selectWallet')(addr(1, 0), 'walletconnect');
        w.releaseSignature();
        await done; await flush();
        assertStaleSigned(w);
    });

    test('phone account -> B -> the phone account while signing: zero broadcasts', async () => {
        const w = world({ wc: true });
        const { done } = await w.startAndHoldSignature();
        w.tab.fn('selectWallet')(B, 'walletconnect');
        w.tab.fn('selectWallet')(addr(1, 0), 'walletconnect');
        w.releaseSignature();
        await done; await flush();
        assertStaleSigned(w);
    });
});

describe('#70 follow-up 2: the revision is captured with expectedWallet, before any wait', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => { mock.timers.reset(); closeTabs(); });

    test('Clear identity: the wallet goes A -> B -> A while confirm() is open, so nothing is signed', async () => {
        const w = world();
        const errs = [];
        Object.assign(w.tab.ctx, {
            currentWalletData: { address: A, identity: 'Someone' },
            hideIdentityError() {}, showIdentityError: (m) => { errs.push(m); },
            confirm: () => { w.tab.fn('selectWallet')(B, 'polkadot-js'); w.tab.fn('selectWallet')(A, 'polkadot-js'); return true; }
        });
        w.api.tx = { identity: { clearIdentity: () => w.tx } };
        vm.runInContext('async ' + bodyOf(SCRIPT, 'submitClearIdentity'), w.tab.ctx);
        await w.tab.fn('submitClearIdentity')();
        await flush();
        assert.equal(w.calls.sign, 0, 'the wallet was asked to sign a request begun in the previous session');
        assert.equal(w.broadcasts(), 0);
        assert.equal(errs.length, 1, JSON.stringify(errs));
        assert.match(errs[0], /out of date/i);
    });

    test('Clear identity: nothing changes while confirm() is open, so the wallet is asked', async () => {
        const w = world();
        Object.assign(w.tab.ctx, {
            currentWalletData: { address: A, identity: 'Someone' },
            hideIdentityError() {}, showIdentityError() {}, confirm: () => true
        });
        w.api.tx = { identity: { clearIdentity: () => w.tx } };
        vm.runInContext('async ' + bodyOf(SCRIPT, 'submitClearIdentity'), w.tab.ctx);
        w.tab.fn('submitClearIdentity')();
        await flush();
        assert.equal(w.calls.sign, 1);
    });
});

// Sprint 7 B5: these were source-text assertions; now the behaviour itself.
describe('#70 follow-up 2: the multisig review captures the revision when it opens', () => {
    // The review's modal, a stand-in as in test/multisig-review-note.test.js.
    let saved;
    beforeEach(() => { saved = { document: globalThis.document, MutationObserver: globalThis.MutationObserver }; });
    afterEach(() => { globalThis.document = saved.document; globalThis.MutationObserver = saved.MutationObserver; });
    function reviewWorld() {
        const mk = (id) => ({ id, disabled: false, textContent: '', value: '0', style: {}, listeners: {}, innerHTML: '',
            addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }, focus() {}, select() {}, querySelector() { return null; },
            fire(type) { return Promise.all((this.listeners[type] || []).map(fn => fn())); } });
        const modal = mk('multisig-review-modal');
        const content = mk('multisig-review-content');
        let parts = {};
        Object.defineProperty(content, 'innerHTML', { get() { return ''; }, set(html) {
            const call = html.includes('<textarea') ? mk('call') : null;
            if (call) call.value = (/<textarea[^>]*>([^<]*)<\/textarea>/.exec(html) || [])[1] || '';
            parts = { select: mk('signer'), textarea: call, '#multisig-review-details': mk('details'), '[role="alert"]': mk('error'), '#multisig-review-sign': mk('sign'), '#multisig-review-load': mk('load') };
        } });
        content.querySelector = (sel) => parts[sel] || null;
        globalThis.document = { getElementById: (id) => (id === modal.id ? modal : id === content.id ? content : null), querySelectorAll: () => [modal] };
        globalThis.MutationObserver = class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} };
        const multisig = normalizeMultisig({ signers: [A, B, C], threshold: 2, name: 'Team wallet' });
        const tx = { method: { toHex: () => '0xabcd' }, paymentInfo: async () => ({ partialFee: { toString: () => '15000000000' } }) };
        const api = {
            genesisHash: { toHex: () => '0x' + '00'.repeat(32) }, runtimeVersion: { specVersion: { toString: () => '392' } },
            registry: { createType: (_t, hex) => ({ toHex: () => hex, toU8a: () => new Uint8Array([4, 0]), section: 'balances', method: 'transferKeepAlive', toHuman: () => ({}) }) },
            query: { multisig: { multisigs: async () => ({ isNone: true }) } },
            consts: { multisig: { maxSignatories: 100, depositBase: '1', depositFactor: '1' } }
        };
        api.tx = Object.assign(() => ({ paymentInfo: async () => ({ weight: { refTime: 1000, proofSize: 100 } }) }), { multisig: { asMulti: () => tx, asMultiThreshold1: () => tx, approveAsMulti: () => tx } });
        const submits = [];
        let rev = 'r1';
        const ui = createMultisigUI({ store: { find: () => multisig }, storage: { getItem: () => null, setItem() {} }, api: () => api,
            accounts: async () => [{ address: A, name: 'Alice', source: 'talisman' }], selected: () => multisig.address, select() {},
            submit: async (o) => { submits.push(o); }, refresh() {}, fetchJson: async () => ({}), revision: () => rev });
        return { ui, multisig, submits, setRevision: (r) => { rev = r; }, sign: () => parts['#multisig-review-sign'].fire('click') };
    }
    test('the revision is read when the review opens, before any wait: a later session change does not move it', async () => {
        const r = reviewWorld();
        const opened = r.ui.review({ multisig: r.multisig, callHex: '0x0400' });
        r.setRevision('r2');   // the session changes while the review loads (before its first await settles)
        await opened;
        await r.sign();
        assert.equal(r.submits.length, 1);
        assert.equal(r.submits[0].expectedRevision, 'r1', 'the signer transaction does not carry the revision taken at open');
        assert.equal(r.submits[0].expectedWallet, r.multisig.address);
    });
    test('script.js hands the review the live wallet-session revision (multisigUIDeps)', () => {
        const w = world();
        vm.runInContext(bodyOf(SCRIPT, 'multisigUIDeps'), w.tab.ctx);
        Object.assign(w.tab.ctx, { fetchApiJson: async () => ({}), validatorCallGuard: async () => [], validatorCallNote: async () => '' });
        const deps = w.tab.fn('multisigUIDeps')();
        const session = w.tab.fn('walletSession');
        assert.equal(deps.revision(), session.revision());
        const before = deps.revision();
        w.tab.fn('selectWallet')(B, 'polkadot-js');
        assert.notEqual(deps.revision(), before, 'the review would read a revision that never changes');
        assert.equal(deps.revision(), session.revision());
    });
    test('submitSignedTx refuses a revision from an earlier session even when the address is the same again', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const w = world();
            const old = w.tab.fn('walletSession').revision();
            w.tab.fn('selectWallet')(B, 'polkadot-js');
            w.tab.fn('selectWallet')(A, 'polkadot-js');
            await w.submit({ expectedWallet: A, expectedRevision: old });
            await flush();
            assert.equal(w.calls.sign, 0, 'the wallet was asked to sign for a request from the previous session');
            assert.equal(w.broadcasts(), 0);
        } finally { mock.timers.reset(); closeTabs(); }
    });
});

// Sprint 7 B4: proxy add and remove take the revision of the session the view was drawn in, like Clear identity.
describe('Sprint 7 B4: proxy add and remove carry the wallet-session revision', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => { mock.timers.reset(); closeTabs(); });
    const root = (w) => w.tab.ctx.document.getElementById('wallet-dashboard');
    function proxyCtx(w, extra = {}) {
        Object.assign(w.tab.ctx, {
            fetchApiJson: async () => ({ proxies: [{ delegate: B, proxyType: 'Staking', delay: 0 }], deposit: '1' }),
            stakingFormatNumber: String, stakingFormatPDEX: String, chainDelegate: (d) => d, ss58PrefixOf: () => 88, renderApiError() {},
            cachedProxyTypes: ['Staking', 'Any'], VALIDATE_ON: false, proxyPrefill: () => null, proxyDelegateProblem: () => null, renderRecipientRefusal() {},
            ...extra
        });
        w.api.tx = { proxy: { removeProxy: () => w.tx, addProxy: () => w.tx } };
        for (const f of ['renderProxyList', 'renderAddProxyForm']) vm.runInContext('async ' + bodyOf(SCRIPT, f), w.tab.ctx);
    }
    const switchAndBack = (w) => { w.tab.fn('selectWallet')(B, 'polkadot-js'); w.tab.fn('selectWallet')(A, 'polkadot-js'); };

    test('Remove: the wallet goes A -> B -> A while confirm() is open, so nothing is signed', async () => {
        const w = world();
        root(w).innerHTML = '<div id="wallet-proxy-list"></div>';
        proxyCtx(w, { confirm: () => { switchAndBack(w); return true; } });
        await w.tab.fn('renderProxyList')(A, true);
        root(w).querySelector('.proxy-remove-btn').click();
        await flush();
        assert.equal(w.calls.sign, 0, 'the wallet was asked to sign a removal begun in the previous session');
        assert.equal(w.broadcasts(), 0);
    });
    test('Remove: nothing changes, so the wallet is asked', async () => {
        const w = world();
        root(w).innerHTML = '<div id="wallet-proxy-list"></div>';
        proxyCtx(w, { confirm: () => true });
        await w.tab.fn('renderProxyList')(A, true);
        root(w).querySelector('.proxy-remove-btn').click();
        await flush();
        assert.equal(w.calls.sign, 1);
    });
    test('Add: the wallet goes A -> B -> A after the form was drawn, so nothing is signed', async () => {
        const w = world();
        root(w).innerHTML = '<div id="wallet-proxy-add"></div>';
        proxyCtx(w);
        await w.tab.fn('renderAddProxyForm')(A);
        const input = root(w).querySelector('#proxy-add-delegate'), submit = root(w).querySelector('#proxy-add-submit');
        switchAndBack(w);   // the dashboard repaints; the form drawn for the old session is still on screen until then
        input.value = B;
        submit.click();
        await flush();
        assert.equal(w.calls.sign, 0, 'the wallet was asked to sign an add begun in the previous session');
        assert.equal(w.broadcasts(), 0);
    });
    test('Add: nothing changes, so the wallet is asked', async () => {
        const w = world();
        root(w).innerHTML = '<div id="wallet-proxy-add"></div>';
        proxyCtx(w);
        await w.tab.fn('renderAddProxyForm')(A);
        root(w).querySelector('#proxy-add-delegate').value = B;
        root(w).querySelector('#proxy-add-submit').click();
        await flush();
        assert.equal(w.calls.sign, 1);
    });
});

describe('#70 follow-up 1: discussion sign-in (signRaw) takes the wallet-session check', () => {
    const SOURCE_KEY = 'pdex_discuss_session';

    function signInWorld() {
        const ext = fakeExtension('polkadot-js', [{ address: addr(1, 42), name: 'One' }, { address: addr(2, 42), name: 'Two' }]);
        const talisman = fakeExtension('talisman', [{ address: addr(1, 0), name: 'One (Talisman)' }]);
        const profile = makeProfile({ extensions: [ext, talisman] });
        const tab = openTab(profile, { path: '/wallet' });
        openTabs.push(tab);
        const signature = deferred();
        ext.signer.signRaw = async () => signature.promise;
        const log = [];
        tab.ctx.fetch = (url, init) => {
            url = String(url);
            log.push(url);
            if (url === '/api/auth/challenge') return Promise.resolve({ ok: true, status: 200, json: async () => ({ message: 'sign me' }) });
            if (url === '/api/auth/verify') return Promise.resolve({ ok: true, status: 200, json: async () => ({ token: 'tok-1', expiresIn: 3600 }) });
            profile.logoutCalls.push((init && init.headers && init.headers.Authorization) || '');
            return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
        };
        vm.runInContext(bodyOf(SCRIPT, 'discussSignInFor'), tab.ctx);
        tab.fn('selectWallet')(A, 'polkadot-js');
        const run = () => tab.fn('discussSignInFor')(A).then(() => 'signed in', (e) => e.message);
        return { tab, profile, signature, log, run, stored: () => profile.local.getItem(SOURCE_KEY) };
    }

    afterEach(() => { closeTabs(); });

    test('A -> Disconnect -> A while the wallet signs: no token is stored and verify is never called', async () => {
        const s = signInWorld();
        const p = s.run();
        await flush();
        s.tab.fn('disconnectWallet')();
        s.tab.fn('selectWallet')(A, 'polkadot-js');
        s.signature.resolve({ signature: '0x01' });
        const result = await p;
        assert.match(result, /wallet changed/i);
        assert.equal(s.stored(), null, 'a token was stored for a sign-in begun in another wallet session');
        assert.ok(!s.log.includes('/api/auth/verify'), 'the signature was sent to the server');
    });

    test('A -> B -> A while the wallet signs: nothing stored', async () => {
        const s = signInWorld();
        const p = s.run();
        await flush();
        s.tab.fn('selectWallet')(B, 'polkadot-js');
        s.tab.fn('selectWallet')(A, 'polkadot-js');
        s.signature.resolve({ signature: '0x01' });
        assert.match(await p, /wallet changed/i);
        assert.equal(s.stored(), null);
        assert.ok(!s.log.includes('/api/auth/verify'));
    });

    test('the same key from another extension while the wallet signs: nothing stored', async () => {
        const s = signInWorld();
        const p = s.run();
        await flush();
        s.tab.fn('selectWallet')(addr(1, 0), 'talisman');
        assert.equal(s.tab.fn('getStoredWallet')(), A);
        s.signature.resolve({ signature: '0x01' });
        assert.match(await p, /wallet changed/i);
        assert.equal(s.stored(), null);
    });

    test('nothing changes: the token is stored', async () => {
        const s = signInWorld();
        const p = s.run();
        await flush();
        s.signature.resolve({ signature: '0x01' });
        assert.equal(await p, 'signed in');
        assert.ok(s.stored(), 'the sign-in was not stored');
    });

    test('lib: signInForDiscussion honours a valid() check between signing and verify, and after verify (the issued token is revoked)', async () => {
        const mk = () => {
            const storage = memStorage();
            const auth = createDiscussAuth({ storage, isSame: (a, b) => a === b, now: () => 1000, revoke: () => {} });
            return { storage, auth };
        };
        const res = (body) => ({ ok: true, status: 200, json: async () => body });
        const fetchFn = async (url) => (url === '/api/auth/challenge' ? res({ message: 'm' }) : res({ token: 't', expiresIn: 60 }));
        const base = (extra) => ({ address: 'X', fetchFn, getSigner: async () => ({ signRaw: async () => ({ signature: '0x' }) }), wallet: () => 'X', isSame: (a, b) => a === b, ...extra });

        let m = mk(), verifyCalled = 0;
        await assert.rejects(signInForDiscussion(base({ auth: m.auth, valid: () => false, fetchFn: async (u) => { if (u === '/api/auth/verify') verifyCalled++; return fetchFn(u); } })), /wallet changed/i);
        assert.equal(verifyCalled, 0);
        assert.equal(m.storage.getItem('pdex_discuss_session'), null);

        m = mk();
        let n = 0; const evicted = [];
        await assert.rejects(signInForDiscussion(base({ auth: m.auth, valid: () => ++n < 2, onEvicted: (t) => evicted.push(...t) })), /wallet changed/i);
        assert.deepEqual(evicted, ['t']);
        assert.equal(m.storage.getItem('pdex_discuss_session'), null);
    });
});
