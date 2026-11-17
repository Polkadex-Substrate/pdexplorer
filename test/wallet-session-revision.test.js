// Issue #70: a pending signature must not outlive the wallet session it was
// started in. The broadcast guard used to compare only addresses, so three
// transitions while the wallet was still signing let the old request go out:
//
//   A -> Disconnect -> A again
//   A -> B -> A
//   A from one extension -> A from another (same public key)
//
// and the same three done in ANOTHER TAB (the storage the tabs share).
//
// These run the real submitSignedTx (script.js) in a wallet-world tab
// (test/helpers/wallet-world.js: the real wallet session, real extension
// lookup) with the real trackSignedTx (lib/tx-submit.js). Only the chain and
// the wallet's signature are synthetic: signAsync is held open until the test
// releases it, and send() only counts. Nothing is ever broadcast anywhere.
//
// Addresses are synthetic (32 bytes of one repeated value). They belong to no one.

import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { trackSignedTx } from '../lib/tx-submit.js';
import { buildTxModel } from '../lib/tx-status.js';
import { bodyOf } from './helpers/source.js';
import { makeProfile, openTab, fakeExtension, addr } from './helpers/wallet-world.js';

const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const A = addr(1), B = addr(2);
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

const openTabs = [];
const closeTabs = () => { while (openTabs.length) { try { openTabs.pop().close(); } catch (e) { /* already closed */ } } };

const fakeButton = () => ({ disabled: false, attrs: {}, innerHTML: 'Go', textContent: '',
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } });

// Two extensions: polkadot-js holds A and B, talisman holds A too (in the
// generic encoding, so the same key reaches the page in two spellings).
function world() {
    const profile = makeProfile({ extensions: [
        fakeExtension('polkadot-js', [{ address: addr(1, 42), name: 'One' }, { address: addr(2, 42), name: 'Two' }]),
        fakeExtension('talisman', [{ address: addr(1, 0), name: 'One (Talisman)' }])
    ] });
    const tab = openTab(profile, { path: '/wallet' });
    openTabs.push(tab);
    const api = {
        registry: {}, on() {}, off() {},
        consts: { balances: { existentialDeposit: 1n } },
        query: { system: { account: async () => ({ nonce: 0, data: { free: 10n ** 20n, reserved: 0n, frozen: 0n } }) } },
        rpc: { chain: { getHeader: async () => ({ number: { toNumber: () => 9 } }) } }
    };
    const calls = { sign: 0, send: 0, signAndSend: 0, errors: [] };
    const fee = { hold: null };
    const signature = deferred();
    const signed = { nonce: 4, send: () => { calls.send++; return Promise.resolve(() => {}); } };
    const tx = {
        paymentInfo: async () => { if (fee.hold) await fee.hold.promise; return { partialFee: 1n }; },
        signAsync: () => { calls.sign++; return signature.promise; },
        signAndSend: () => { calls.signAndSend++; return Promise.resolve(() => {}); }
    };
    const button = fakeButton();
    Object.assign(tab.ctx, {
        globalApi: api, liveRuntimeError: () => null, isMobileDevice: () => false,
        multisigStore: { find: () => null },
        showTxStatus: (a, st, ev, err, ex) => buildTxModel(a, st, ev, err, ex),
        trackSignedTx,
        confirm: () => true, alert: () => {}
    });
    vm.runInContext('async ' + bodyOf(SCRIPT, 'submitSignedTx'), tab.ctx);
    tab.fn('selectWallet')(A, 'polkadot-js');
    const w = {
        profile, tab, calls, button, fee,
        broadcasts: () => calls.send + calls.signAndSend,
        submit: () => tab.fn('submitSignedTx')({ buildTx: () => tx, label: 'Test', button, idleText: 'Go', onError: (m) => calls.errors.push(m) }),
        // Start a submission and wait until the wallet has been asked to sign.
        async startAndHoldSignature() {
            const done = w.submit();
            await flush();
            assert.equal(calls.sign, 1, 'the wallet was not asked to sign');
            return { done };   // wrapped: an async function returning the promise itself would wait for it
        },
        releaseSignature: () => signature.resolve(signed)
    };
    return w;
}

// The stale-request message: says why and what to do next.
function assertStaleRefusal(w, { signed }) {
    assert.equal(w.broadcasts(), 0, 'the old signature was broadcast after the wallet session changed');
    assert.equal(w.calls.errors.length, 1, 'the refusal was not reported: ' + JSON.stringify(w.calls.errors));
    assert.match(w.calls.errors[0], /out of date/i, 'the message does not say the request became stale');
    assert.match(w.calls.errors[0], /start (it|the action) again/i, 'the message does not say how to carry on');
    assert.match(w.calls.errors[0], signed ? /nothing was sent/i : /nothing was signed/i);
    assert.equal(w.button.disabled, false, 'the button stayed busy, so a fresh action cannot be started');
}

describe('#70: a signature pending across a wallet-session change is never broadcast (same tab)', () => {
    // The signing cap (lib/tx-status.js) is a long timer: mocked, never run.
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => { mock.timers.reset(); closeTabs(); });

    test('A -> Disconnect -> A: zero broadcasts', async () => {
        const w = world();
        const { done } = await w.startAndHoldSignature();
        w.tab.fn('disconnectWallet')();
        w.tab.fn('selectWallet')(A, 'polkadot-js');
        w.releaseSignature();
        await done; await flush();
        assertStaleRefusal(w, { signed: true });
    });

    test('A -> B -> A: zero broadcasts', async () => {
        const w = world();
        const { done } = await w.startAndHoldSignature();
        w.tab.fn('selectWallet')(B, 'polkadot-js');
        w.tab.fn('selectWallet')(A, 'polkadot-js');
        w.releaseSignature();
        await done; await flush();
        assertStaleRefusal(w, { signed: true });
    });

    test('A from polkadot-js -> the same key from talisman (another encoding): zero broadcasts', async () => {
        const w = world();
        const { done } = await w.startAndHoldSignature();
        w.tab.fn('selectWallet')(addr(1, 0), 'talisman');
        assert.equal(w.tab.fn('getStoredWallet')(), A, 'same public key, so the stored address did not change');
        w.releaseSignature();
        await done; await flush();
        assertStaleRefusal(w, { signed: true });
    });

    test('A -> B -> A while the fee is being checked: the wallet is never asked', async () => {
        const w = world();
        w.fee.hold = deferred();
        const done = w.submit();
        await flush();
        assert.equal(w.calls.sign, 0);
        w.tab.fn('selectWallet')(B, 'polkadot-js');
        w.tab.fn('selectWallet')(A, 'polkadot-js');
        w.fee.hold.resolve();
        w.releaseSignature();
        await done; await flush();
        assert.equal(w.calls.sign, 0, 'the wallet was asked to sign a request from the previous session');
        assertStaleRefusal(w, { signed: false });
    });
});

describe('#70: the same transitions made in another tab invalidate the pending request', () => {
    // The other tab writes the shared localStorage. This tab is not told
    // anything (a backgrounded or suspended page may not run its storage
    // listener before the wallet answers); the check itself must see it.
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => { mock.timers.reset(); closeTabs(); });

    test('another tab: A -> Disconnect -> A', async () => {
        const w = world();
        const { done } = await w.startAndHoldSignature();
        const other = openTab(w.profile, { path: '/wallet' }); openTabs.push(other);
        other.fn('disconnectWallet')();
        other.fn('selectWallet')(A, 'polkadot-js');
        w.releaseSignature();
        await done; await flush();
        assertStaleRefusal(w, { signed: true });
    });

    test('another tab: A -> B -> A', async () => {
        const w = world();
        const { done } = await w.startAndHoldSignature();
        const other = openTab(w.profile, { path: '/wallet' }); openTabs.push(other);
        other.fn('selectWallet')(B, 'polkadot-js');
        other.fn('selectWallet')(A, 'polkadot-js');
        w.releaseSignature();
        await done; await flush();
        assertStaleRefusal(w, { signed: true });
    });

    test('another tab: same key from another extension, and this tab heard it (syncExternal)', async () => {
        const w = world();
        const { done } = await w.startAndHoldSignature();
        const other = openTab(w.profile, { path: '/wallet' }); openTabs.push(other);
        other.fn('selectWallet')(addr(1, 0), 'talisman');
        w.tab.fn('walletSession').syncExternal();   // what the 'storage' listener runs
        w.releaseSignature();
        await done; await flush();
        assertStaleRefusal(w, { signed: true });
    });

    test('another tab: Disconnect then connect A again, and this tab heard both (syncExternal after each)', async () => {
        const w = world();
        const { done } = await w.startAndHoldSignature();
        const other = openTab(w.profile, { path: '/wallet' }); openTabs.push(other);
        other.fn('disconnectWallet')();
        w.tab.fn('walletSession').syncExternal();
        other.fn('selectWallet')(A, 'polkadot-js');
        w.tab.fn('walletSession').syncExternal();
        w.releaseSignature();
        await done; await flush();
        assertStaleRefusal(w, { signed: true });
    });
});

describe('#70: an unchanged session still signs and broadcasts', () => {
    // The signing cap (lib/tx-status.js) is a long timer: mocked, never run.
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => { mock.timers.reset(); closeTabs(); });

    test('nothing changes: one broadcast, no error', async () => {
        const w = world();
        const { done } = await w.startAndHoldSignature();
        w.releaseSignature();
        await done; await flush();
        assert.equal(w.calls.send, 1);
        assert.deepEqual(w.calls.errors, []);
    });

    test('re-selecting the same account from the same extension is not a change', async () => {
        const w = world();
        const { done } = await w.startAndHoldSignature();
        w.tab.fn('selectWallet')(A, 'polkadot-js');
        w.releaseSignature();
        await done; await flush();
        assert.equal(w.calls.send, 1);
        assert.deepEqual(w.calls.errors, []);
    });

    test('the tab waking up with nothing changed elsewhere (syncExternal) is not a change', async () => {
        const w = world();
        const { done } = await w.startAndHoldSignature();
        w.tab.fn('walletSession').syncExternal();
        w.releaseSignature();
        await done; await flush();
        assert.equal(w.calls.send, 1);
        assert.deepEqual(w.calls.errors, []);
    });
});
