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
import { makeProfile, openTab, fakeExtension, addr, memStorage } from './helpers/wallet-world.js';

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

describe('#70 follow-up 2: the multisig review captures the revision when it opens', () => {
    test('lib/multisig-view.js passes the revision taken at review open as expectedRevision', () => {
        const src = readFileSync(new URL('../lib/multisig-view.js', import.meta.url), 'utf8');
        assert.match(src, /expectedRevision:\s*startRevision/, 'the signer transaction does not carry the revision taken at open');
        assert.match(src, /const startRevision = revision\(\)/, 'the revision is not taken where startAddress is');
        assert.ok(src.indexOf('const startRevision') < src.indexOf('const assertContext'), 'the revision must be read before any wait');
    });
    test('script.js hands the review the live wallet-session revision, and submitSignedTx and Clear identity use it', () => {
        assert.match(bodyOf(SCRIPT, 'submitSignedTx').split('\n')[0], /expectedRevision/);
        assert.match(bodyOf(SCRIPT, 'submitSignedTx'), /signingCheck\(expectedWallet, expectedRevision\)/);
        assert.match(bodyOf(SCRIPT, 'submitClearIdentity'), /expectedRevision/);
        assert.match(SCRIPT, /revision:\s*\(\)\s*=>\s*walletSession\.revision\(\)/);
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
