// Second review of the wallet-aware branch: the gaps between "the wallet was
// checked" and "something was signed, sent, stored or painted".
//
//   1. send() re-checks the wallet after the fee preflight and again after the
//      wallet signed, before anything is broadcast (lib/tx-submit.js), and
//      submitSignedTx gives every caller that check by default.
//   2. Proxy add and remove sign for the address the page was drawn for; a tab
//      restored from the back-forward cache or woken up re-reads the session.
//   3. A success callback repaints the dashboard only while it is still on screen.
//   4. Clear identity: the confirm() dialog sits between the check and the
//      submit, so the submit carries the address it was checked for.
//   5. Discussion sign-in keeps the token only if the wallet that signed is
//      still the active one.
//   6. (in test/wallet-aware-pages.test.js) the staking rewards page leaves the
//      wallet's address out of the URL.
//
// Addresses are synthetic (32 bytes of one repeated value). They belong to no one.

import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { trackSignedTx, signAndSendOptions } from '../lib/tx-submit.js';
import { buildTxModel, SIGNING_CAP_MS } from '../lib/tx-status.js';
import { pickSigningAccount } from '../lib/wallet-session.js';
import { bodyOf, stripComments } from './helpers/source.js';
import { makeProfile, openTab, fakeExtension, addr } from './helpers/wallet-world.js';

const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const CODE = stripComments(SCRIPT);
const W1 = addr(1), W2 = addr(2);
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

function lift(name) {
    const at = SCRIPT.indexOf(`function ${name}(`);
    assert.ok(at !== -1, 'script.js has no function ' + name);
    const pre = SCRIPT.slice(Math.max(0, at - 6), at) === 'async ' ? 'async ' : '';
    return pre + bodyOf(SCRIPT, name) + '\n';
}
// More real script.js functions in a wallet-world tab (test/helpers/wallet-world.js).
const addFns = (tab, names) => vm.runInContext(names.map(lift).join(''), tab.ctx);
const twoAccounts = () => fakeExtension('polkadot-js', [{ address: addr(1, 42), name: 'One' }, { address: addr(2, 42), name: 'Two' }]);

// ─── 1. lib/tx-submit.js: send() with stillValid ─────────────────────────────

const fakeButton = () => ({ disabled: false, attrs: {}, innerHTML: 'Go', textContent: '',
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } });

// A tx whose fee check and signing can be interrupted by a wallet change.
function sendWorld({ duringFee, duringSign } = {}) {
    let valid = true;
    const calls = { sign: 0, send: 0, signAndSend: 0, signOptions: null, onError: [], onSuccess: 0 };
    let statusCb = null;
    const api = {
        registry: {}, on() {}, off() {},
        consts: { balances: { existentialDeposit: 1n } },
        query: { system: { account: async () => ({ nonce: 0, data: { free: 10n ** 20n, reserved: 0n, frozen: 0n } }) } },
        rpc: { chain: { getHeader: async () => ({ number: { toNumber: () => 9 } }) } }
    };
    const signed = { nonce: 4, send: (cb) => { calls.send++; statusCb = cb; return Promise.resolve(() => {}); } };
    const tx = {
        paymentInfo: async () => { if (duringFee) valid = false; return { partialFee: 1n }; },
        signAsync: async (_addr, o) => { calls.sign++; calls.signOptions = o; if (duringSign) valid = false; return signed; },
        signAndSend: () => { calls.signAndSend++; return Promise.resolve(() => {}); }
    };
    const button = fakeButton();
    const shown = [];
    const run = trackSignedTx({
        api, button, idleText: 'Go', action: { id: 'a', key: 'proxy.add', params: {} },
        show: (a, st, ev, err, ex) => { const m = buildTxModel(a, st, ev, err, ex); shown.push(m); return m; },
        onError: (t) => calls.onError.push(t), onSuccess: () => { calls.onSuccess++; }
    });
    return { run, tx, api, button, calls, shown, stillValid: () => valid, emit: async (status) => { statusCb({ status, txHash: { toHex: () => '0x01' } }); await flush(); } };
}

describe('send() re-checks the wallet before signing and before broadcasting', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => mock.timers.reset());

    test('the wallet changes while the fee is checked: the wallet is never asked', async () => {
        const w = sendWorld({ duringFee: true });
        w.run.start();
        await w.run.send(w.tx, 'addr', {}, { stillValid: w.stillValid });
        assert.equal(w.calls.sign + w.calls.signAndSend, 0, 'the wallet was asked to sign for an account that is no longer active');
        assert.deepEqual(w.calls.onError, ['Your wallet changed; nothing was signed.']);
        assert.equal(w.button.disabled, false, 'the button stayed busy');
    });

    test('the wallet changes while it is signing: the signed transaction is not broadcast', async () => {
        const w = sendWorld({ duringSign: true });
        w.run.start();
        await w.run.send(w.tx, 'addr', {}, { stillValid: w.stillValid });
        assert.equal(w.calls.sign, 1);
        assert.equal(w.calls.send + w.calls.signAndSend, 0, 'broadcast after the wallet changed');
        assert.deepEqual(w.calls.onError, ['Your wallet changed after signing; nothing was sent.']);
        assert.equal(w.button.disabled, false);
    });

    test('the wallet changes while the fee check finds a shortfall: the wallet-changed message wins', async () => {
        const w = sendWorld({ duringFee: true });
        w.api.query.system.account = async () => ({ nonce: 0, data: { free: 0n, reserved: 0n, frozen: 0n } });
        w.run.start();
        await w.run.send(w.tx, 'addr', {}, { stillValid: w.stillValid });
        assert.deepEqual(w.calls.onError, ['Your wallet changed; nothing was signed.']);
        assert.equal(w.calls.sign + w.calls.signAndSend, 0);
    });

    test('a signature that arrives after the signing cap ended the card is not broadcast', async () => {
        const w = sendWorld();
        let release;
        w.tx.signAsync = () => new Promise((res) => { release = () => res({ nonce: 4, send: (cb) => { w.calls.send++; return Promise.resolve(() => {}); } }); });
        w.run.start();
        const sending = w.run.send(w.tx, 'addr', {}, { stillValid: w.stillValid });
        await flush();
        mock.timers.tick(SIGNING_CAP_MS + 1);
        await flush();
        assert.equal(w.shown.at(-1).stage === 'signing', false, 'the cap did not end the card');
        release();
        await sending;
        await flush();
        assert.equal(w.calls.send + w.calls.signAndSend, 0, 'a transaction was broadcast after the card said it timed out');
    });

    test('the wallet stays: signed with the same options, then sent, and the lifecycle runs as before', async () => {
        const w = sendWorld();
        const signer = {};
        w.run.start();
        await w.run.send(w.tx, 'addr', signer, { stillValid: w.stillValid });
        assert.deepEqual(w.calls.signOptions, signAndSendOptions(signer));
        assert.equal(w.calls.send, 1);
        assert.equal(w.calls.signAndSend, 0);
        await w.emit({ type: 'Ready' });
        assert.equal(w.shown.at(-1).stage, 'broadcast');
        assert.deepEqual(w.calls.onError, []);
    });

    test('a wallet that refuses to sign is still reported, and nothing is sent', async () => {
        const w = sendWorld();
        w.tx.signAsync = async () => { throw new Error('Cancelled'); };
        w.run.start();
        await w.run.send(w.tx, 'addr', {}, { stillValid: w.stillValid });
        assert.equal(w.calls.send, 0);
        assert.equal(w.calls.onError.length, 1);
        assert.equal(w.button.disabled, false);
    });
});

// ─── submitSignedTx: one default check for every caller ──────────────────────

function signingTab({ path = '/wallet/' + W1 } = {}) {
    const ext = twoAccounts();
    const profile = makeProfile({ extensions: [ext] });
    profile.local.setItem('pdex_wallet_address', W1);
    profile.local.setItem('pdex_wallet_source', 'polkadot-js');
    const tab = openTab(profile, { path });
    const sends = [];
    const errors = [];
    Object.assign(tab.ctx, {
        globalApi: { registry: {}, tx: { identity: { clearIdentity: () => ({ id: 'clearIdentity' }) } } }, liveRuntimeError: () => null, isMobileDevice: () => false,
        multisigStore: { find: () => null },
        showTxStatus: (a, stage, ev, err) => { const m = { stage, text: typeof err === 'string' ? err : '' }; errors.push(m.text); return m; },
        trackSignedTx: () => ({ start() {}, buildFailed(e) { errors.push(e.message); }, send: async (tx, address, signer, opts) => { sends.push({ tx, address, opts }); } }),
        confirm: () => true, alert: () => {}
    });
    addFns(tab, ['submitSignedTx']);
    return { tab, ext, profile, sends, errors };
}

describe('submitSignedTx hands send() the wallet check by default', () => {
    test('stillValid is true while the wallet it opened with is active, false once it changes', async () => {
        const w = signingTab();
        await w.tab.fn('submitSignedTx')({ buildTx: () => ({ id: 'tx' }), label: 'Test' });
        assert.equal(w.sends.length, 1);
        const check = w.sends[0].opts && w.sends[0].opts.stillValid;
        assert.equal(typeof check, 'function', 'send() was not given a wallet check');
        assert.equal(check(), true);
        w.tab.fn('selectWallet')(W2, 'polkadot-js');
        assert.equal(check(), false, 'the check did not see the switch');
    });

    test('an action opened for another wallet is refused before send()', async () => {
        const w = signingTab();
        await w.tab.fn('submitSignedTx')({ buildTx: () => ({ id: 'tx' }), label: 'Test', expectedWallet: W2 });
        assert.equal(w.sends.length, 0, 'signed for W1 when the action was opened for W2');
    });
});

// ─── 2. proxies sign for the address drawn; a restored tab re-reads the session

describe('proxy add and remove carry the address they were drawn for', () => {
    test('remove and add both pass expectedWallet: address', () => {
        assert.match(bodyOf(CODE, 'renderProxyList'), /submitSignedTx\(\{[\s\S]*?expectedWallet: address,[\s\S]*?\}\)/);
        assert.match(bodyOf(CODE, 'renderAddProxyForm'), /submitSignedTx\(\{[\s\S]*?expectedWallet: address,[\s\S]*?\}\)/);
    });
});

describe('a tab restored from the back-forward cache or woken up re-reads the wallet session', () => {
    test('followWalletElsewhere: a change written while the tab slept is announced and a dashboard of the old wallet follows', async () => {
        const profile = makeProfile({ extensions: [twoAccounts()] });
        profile.local.setItem('pdex_wallet_address', W1);
        const tab = openTab(profile, { path: '/wallet/' + W1 });
        addFns(tab, ['followWalletElsewhere']);
        tab.ctx.walletRouteAfterChange = (await import('../lib/wallet-aware.js')).walletRouteAfterChange;
        const seen = [];
        tab.fn('walletSession').onActiveAccountChange(e => seen.push(e.current));
        profile.local.setItem('pdex_wallet_address', W2);       // another tab, while this one was frozen
        tab.fn('followWalletElsewhere')();
        await tab.settle();
        assert.deepEqual(seen, [W2]);
        assert.equal(tab.ctx.window.location.pathname, '/wallet/' + W2);
        tab.fn('followWalletElsewhere')();                       // nothing new: nothing announced
        assert.deepEqual(seen, [W2]);
    });

    test('wired to storage, pageshow (persisted) and visibilitychange (visible)', () => {
        assert.match(CODE, /window\.addEventListener\('pageshow', \(e\) => \{ if \(e\.persisted\) followWalletElsewhere\(\);/);
        assert.match(CODE, /document\.addEventListener\('visibilitychange', \(\) => \{ if \(document\.visibilityState === 'visible'\) \{ followWalletElsewhere\(\);/);
        assert.match(CODE, /window\.addEventListener\('storage', \(e\) => \{[\s\S]{0,200}followWalletElsewhere\(\);/);
    });
});

// ─── 3. success callbacks repaint only the dashboard still on screen ─────────

describe('a success callback repaints the dashboard only while it is still shown', () => {
    function dashTab(path) {
        const profile = makeProfile({ extensions: [twoAccounts()] });
        profile.local.setItem('pdex_wallet_address', W1);
        const tab = openTab(profile, { path });
        addFns(tab, ['refreshWalletDashboardFor']);
        return tab;
    }
    const dashFetches = (tab, who = W1) => tab.log.fetches.filter(f => f.url.startsWith('/api/wallet/') && f.url.includes(encodeURIComponent(who))).length;

    test('same wallet, on its dashboard: repainted', () => {
        const tab = dashTab('/wallet/' + W1);
        tab.fn('refreshWalletDashboardFor')(W1);
        assert.ok(dashFetches(tab) > 0, 'not repainted');
    });

    test('after a switch, on another page, or on another address\'s dashboard: left alone', () => {
        const a = dashTab('/wallet/' + W1);
        a.fn('selectWallet')(W2, 'polkadot-js');
        const before = dashFetches(a);
        a.fn('refreshWalletDashboardFor')(W1);
        assert.equal(dashFetches(a), before, 'the old account was painted after a switch');
        const b = dashTab('/council');
        b.fn('refreshWalletDashboardFor')(W1);
        assert.equal(dashFetches(b), 0, 'painted a dashboard over another page');
        const c = dashTab('/wallet/' + addr(3));
        c.fn('refreshWalletDashboardFor')(W1);
        assert.equal(dashFetches(c), 0, 'painted the wallet over another address being viewed');
    });

    test('no success callback calls fetchWalletDashboard directly any more', () => {
        assert.doesNotMatch(CODE, /setTimeout\(\(\) => fetchWalletDashboard\(/);
        assert.equal((CODE.match(/setTimeout\(\(\) => refreshWalletDashboardFor\(data\.address\), 2500\)/g) || []).length, 8);
        assert.match(CODE, /refresh: address => refreshWalletDashboardFor\(address\)/);
    });
});

// ─── 4. clear identity: the confirm() gap ────────────────────────────────────

describe('clear identity signs only for the account the dialog was opened for', () => {
    test('a switch while the confirm dialog is open: nothing signed, the modal says why', async () => {
        const w = signingTab();
        const shown = [];
        const doc = w.tab.ctx.document;
        Object.assign(w.tab.ctx, {
            currentWalletData: { address: W1 },
            hideIdentityError() {}, showIdentityError: (m) => { shown.push(m); },
            document: { ...doc, getElementById: (id) => doc.getElementById(id) || { style: {} } },
            confirm: () => { w.tab.fn('selectWallet')(W2, 'polkadot-js'); return true; }
        });
        addFns(w.tab, ['submitClearIdentity']);
        await w.tab.fn('submitClearIdentity')();
        assert.equal(w.sends.length, 0, 'signed clearIdentity for the account switched to during the dialog');
        assert.match(shown.join(' '), /wallet changed/i);
    });
});

// ─── 5. discussion sign-in keeps the token only for the wallet that signed ───

describe('discussion sign-in', () => {
    function signInTab({ switchDuringSign }) {
        const ext = twoAccounts();
        const profile = makeProfile({ extensions: [ext] });
        profile.local.setItem('pdex_wallet_address', W1);
        const tab = openTab(profile, { path: '/discussions' });
        const alerts = [], posts = [];
        Object.assign(tab.ctx, {
            alert: (m) => alerts.push(m),
            fetch: async (url, init) => {
                posts.push(String(url));
                const u = String(url);
                const body = u.endsWith('/challenge') ? { message: 'sign me' } : u.endsWith('/verify') ? { token: 'T-' + JSON.parse(init.body).address } : {};
                return { ok: true, status: 200, json: async () => body };
            }
        });
        ext.signer.signRaw = async () => { if (switchDuringSign) tab.fn('selectWallet')(W2, 'polkadot-js'); return { signature: '0x01' }; };
        addFns(tab, ['discussSignIn']);
        return { tab, alerts, posts, token: () => profile.local.getItem('pdex_discuss_session') };
    }

    test('the wallet stays: the token is stored for it', async () => {
        const w = signInTab({ switchDuringSign: false });
        assert.equal(await w.tab.fn('discussSignIn')(), true);
        assert.equal(JSON.parse(w.token()).address, W1);
    });

    test('the wallet changes while the signature is asked for: no token is kept, the user is told', async () => {
        const w = signInTab({ switchDuringSign: true });
        assert.equal(await w.tab.fn('discussSignIn')(), false);
        assert.equal(w.token(), null, 'a session for the old wallet was stored under the new one');
        assert.ok(!w.posts.some(u => u.endsWith('/verify')), 'the old wallet\'s signature was still sent for a session');
        assert.match(w.alerts.join(' '), /wallet changed/i);
    });
});
