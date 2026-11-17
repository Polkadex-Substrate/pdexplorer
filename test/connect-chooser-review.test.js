// Connect wallet chooser, review round 1 (Fable, 16 Nov): seven findings.
//
//   1. A multisig session from before the signer wallet was remembered (source
//      'multisig', no pdex_wallet_last_source) got "No signer is shared" in the
//      review, with no way forward. Now the review offers one button; on that
//      click the installed wallets are asked (through lib/wallet-sources.js)
//      and the wallet that holds a signer is remembered.
//   2. Entering the get, apps and pairing views moved no focus. Focus goes to
//      the view's Back button; Escape and Back work from the keyboard.
//   3. A late "refused" for the remembered wallet, after "Use a different
//      wallet", left a skeleton that never cleared on Back. The answer is now
//      drawn where the user is: the line under the row, and no Back into an
//      accounts view that has nothing to show.
//   4. A paired phone that shares no account showed no line at all.
//   5. The "only lib/wallet-sources.js asks a wallet" guard saw `.enable(`
//      only. It now also sees `?.enable(`, `['enable']`, `["enable"]`,
//      `.enable.call(`, `.enable.apply(` and web3Enable from
//      @polkadot/extension-dapp.
//   6. The option rows had a fixed aria-label, so a screen reader never heard
//      "Approve the request in ..." or "2 accounts". The changing text is now
//      the row's description (aria-describedby).
//   7. Discussion sign-in in a session that recorded no wallet ended in an
//      alert. Sign-in is a click, so the installed wallets may be asked there
//      too, and the holder is remembered.
//
// Addresses are synthetic (32 bytes of one repeated value). They belong to no one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { mountChooser, fakeWallet, acct, addr, tick } from './helpers/chooser-world.js';
import { makeProfile, openTab, fakeExtension } from './helpers/wallet-world.js';
import { findEnableCalls } from '../lib/wallet-sources.js';
import { createMultisigUI } from '../lib/multisig-view.js';
import { normalizeMultisig } from '../lib/multisig.js';
import { NO_PHONE_ACCOUNT } from '../lib/wallet-picker-view.js';

const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const view = (w) => w.q('section.wallet-picker').getAttribute('data-view');
const problem = (w, li) => { const p = li && li.querySelector('.wallet-option-problem'); return p ? p.textContent.replace(/\s+/g, ' ').trim() : ''; };
// Comparing elements with assert.equal makes node print a diff of two happy-dom
// trees, which runs out of memory; compare by identity and name the element.
const focused = (w, el, msg = '') => { const a = w.doc.activeElement; assert.ok(a === el, `${msg ? msg + ': ' : ''}focus is on ${a ? a.outerHTML.slice(0, 120) : 'nothing'}`); };
const described = (w, el) => (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
    .map(id => { const d = w.doc.getElementById(id); return d ? d.textContent.replace(/\s+/g, ' ').trim() : '<missing #' + id + '>'; }).join(' | ');

// ─── 1. a legacy multisig session finds its signer on a click ──────────────

// The review in a real (happy-dom) document: the modal and its content box.
function reviewWorld(t, { accounts = [], canAsk = true, found = [] } = {}) {
    const win = new Window({ url: 'https://explorer.test/wallet', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    const doc = win.document;
    doc.body.innerHTML = '<div id="multisig-review-modal" class="modal" style="display:none"><div id="multisig-review-content"></div></div>';
    const saved = { document: globalThis.document, MutationObserver: globalThis.MutationObserver };
    globalThis.document = doc;
    globalThis.MutationObserver = win.MutationObserver;
    t.after(() => { globalThis.document = saved.document; globalThis.MutationObserver = saved.MutationObserver; win.happyDOM.close(); });
    const [S1, S2, S3] = [addr(31), addr(32), addr(33)];
    const multisig = normalizeMultisig({ signers: [S1, S2, S3], threshold: 2, name: 'Team wallet' });
    const asks = [];
    const API = {};
    const ui = createMultisigUI({
        store: { find: () => multisig, list: () => [multisig] }, storage: { getItem: () => null, setItem() {} }, api: () => API,
        accounts: async () => accounts, selected: () => multisig.address, select() {},
        submit: async () => {}, refresh() {}, fetchJson: async () => ({}),
        canAskWallets: () => canAsk,
        askWallets: async (signers) => { asks.push(signers); return typeof found === 'function' ? found() : found; }
    });
    const content = doc.getElementById('multisig-review-content');
    return { doc, ui, multisig, asks, content, S1, S2, open: () => ui.review({ multisig, mode: 'initiate' }) };
}

describe('1. a multisig session with no remembered signer wallet', () => {
    test('the review asks nothing on its own and offers one button; its click asks the wallets, and the signer it finds is offered', async (t) => {
        const signer = { address: addr(32), name: 'Bob', source: 'talisman' };   // addr(32) is a signer
        const r = reviewWorld(t, { found: [signer] });
        await r.open();
        assert.equal(r.asks.length, 0, 'the wallets were asked before the click');
        const btn = r.content.querySelector('#multisig-review-ask');
        assert.ok(btn, 'no button to find the signer');
        assert.equal(btn.tagName, 'BUTTON');
        assert.match(btn.textContent, /Find my signer/);
        assert.ok(!/No signer is shared/.test(r.content.textContent), 'the dead end is still shown');
        btn.click();
        await tick(5);
        assert.equal(r.asks.length, 1);
        assert.deepEqual(r.asks[0], r.multisig.signers);
        const select = r.content.querySelector('#multisig-review-signer');
        assert.ok(select, 'the review did not continue with the signer found');
        assert.match(select.textContent, /Bob \(talisman\)/);
    });

    test('nothing found: the line in the alert, and the button stays for another try', async (t) => {
        const r = reviewWorld(t, { found: [{ address: addr(50), name: 'Not a signer', source: 'talisman' }] });
        await r.open();
        r.content.querySelector('#multisig-review-ask').click();
        await tick(5);
        assert.match(r.content.querySelector('[role="alert"]').textContent, /No signer is shared by your wallet extension/);
        assert.equal(r.content.querySelector('#multisig-review-ask').disabled, false);
        assert.ok(!r.content.querySelector('#multisig-review-signer'));
    });

    test('a remembered wallet (no legacy case): the existing line, and no button', async (t) => {
        const r = reviewWorld(t, { canAsk: false });
        await r.open();
        assert.match(r.content.textContent, /No signer is shared by your wallet extension/);
        assert.ok(!r.content.querySelector('#multisig-review-ask'));
        assert.equal(r.asks.length, 0);
    });

    test('script.js: opening the review asks no wallet; the click asks each installed wallet once, remembers the holder, and the next review reads it', async () => {
        const S = addr(2), M = addr(9);
        const profile = makeProfile({ extensions: [fakeExtension('polkadot-js', [{ address: addr(1, 42), name: 'Alice' }]), fakeExtension('talisman', [{ address: addr(2, 42), name: 'Bob' }])] });
        profile.local.setItem('pdex_wallet_address', M);
        profile.local.setItem('pdex_wallet_source', 'multisig');
        const tab = openTab(profile, { path: '/wallet/' + M });
        const counts = () => Object.fromEntries(profile.extensions.map(e => [e.key, e.enableCalls]));
        assert.deepEqual(await tab.fn('getInjectedAccounts')({ retries: 1, retryDelayMs: 1 }), []);
        assert.deepEqual(counts(), { 'polkadot-js': 0, talisman: 0 }, 'opening the review asked a wallet');
        assert.equal(tab.fn('canAskWalletsForSigners')(), true);
        const found = await tab.fn('askWalletsForSigners')([S, addr(3)]);
        assert.deepEqual(found.map(a => [a.name, a.source]), [['Bob', 'talisman']]);
        assert.deepEqual(counts(), { 'polkadot-js': 1, talisman: 1 });
        assert.equal(tab.read('pdex_wallet_last_source'), 'talisman', 'the wallet that holds the signer was not remembered');
        assert.equal(tab.read('pdex_wallet_source'), 'multisig', 'the multisig stays the connected account');
        assert.equal(tab.fn('canAskWalletsForSigners')(), false, 'with a remembered wallet the review no longer offers to ask them all');
        const next = await tab.fn('getInjectedAccounts')({ retries: 1, retryDelayMs: 1 });
        assert.ok(next.some(a => a.name === 'Bob'));
        assert.deepEqual(counts(), { 'polkadot-js': 1, talisman: 1 }, 'the next review asked again');
        tab.close();
    });

    test('script.js: the multisig UI gets both, and the button is the only caller', () => {
        assert.ok(SCRIPT.includes('canAskWallets: canAskWalletsForSigners, askWallets: askWalletsForSigners'), 'createMultisigUI is not given the legacy signer lookup');
        const calls = SCRIPT.split('\n').filter(l => /askWalletsForSigners\(/.test(l) && !/function askWalletsForSigners/.test(l) && !l.trim().startsWith('//'));
        assert.deepEqual(calls, [], 'script.js calls askWalletsForSigners itself');
    });
});

// ─── 2. focus on entering a view ───────────────────────────────────────────

describe('2. entering the get, apps and pairing views moves focus to Back', () => {
    test('get: focus on Back; Escape returns to the Get row', async (t) => {
        const w = mountChooser(t, {});
        await w.picker.ready;
        w.action('get').click();
        assert.equal(view(w), 'get');
        const back = w.q('#wallet-picker-back');
        assert.equal(back.tagName, 'BUTTON');
        focused(w, back, 'focus stayed on a row that is no longer shown');
        w.key(back, 'Escape');
        assert.equal(view(w), 'options');
        focused(w, w.action('get'));
    });

    test('apps (phone browser): focus on Back; Back returns to the apps row', async (t) => {
        const w = mountChooser(t, { onMobile: true });
        await w.picker.ready;
        w.action('apps').click();
        assert.equal(view(w), 'apps');
        focused(w, w.q('#wallet-picker-back'));
        w.q('#wallet-picker-back').click();
        assert.equal(view(w), 'options');
        focused(w, w.action('apps'));
    });

    test('pairing: focus on Back; Escape cancels the pairing and returns to the phone row', async (t) => {
        const w = mountChooser(t, { wallets: [fakeWallet('polkadot-js', [acct(21, 'A')])], phone: true });
        await w.picker.ready;
        w.action('phone').click();
        await tick(0);
        assert.equal(view(w), 'pairing');
        focused(w, w.q('#wallet-picker-back'));
        w.key(w.doc.activeElement, 'Escape');
        await w.settle();
        assert.equal(view(w), 'options');
        assert.equal(w.phone.cancels, 1);
        focused(w, w.action('phone'));
    });
});

// ─── 3. a late answer for the remembered wallet ────────────────────────────

describe('3. a late answer from the remembered wallet is drawn where the user is', () => {
    const held = (opts) => fakeWallet('polkadot-js', [acct(21, 'A'), acct(22, 'B')], { hold: true, ...opts });
    const mount = (t, pj) => mountChooser(t, { wallets: [pj, fakeWallet('talisman', [acct(23, 'T')])], current: addr(21), currentSource: 'polkadot-js', lastSource: 'polkadot-js' });

    test('refused after "Use a different wallet": the line under its row, no Back into an empty accounts view, no skeleton', async (t) => {
        const pj = held({ reject: true });
        const w = mount(t, pj);
        await tick(0);
        assert.equal(view(w), 'accounts');
        w.q('#wallet-picker-different').click();
        assert.equal(view(w), 'options');
        pj.release();
        await w.settle();
        await w.picker.ready;
        assert.equal(view(w), 'options');
        assert.match(problem(w, w.row('polkadot-js').closest('li')), /Polkadot\.js did not allow this site\./);
        const back = w.q('#wallet-picker-back');
        if (w.visible(back)) { back.click(); await w.settle(); }
        assert.ok(!w.q('.wallet-skel-account'), 'a skeleton that will never fill');
        assert.equal(view(w), 'options');
        assert.equal(w.visible(w.q('#wallet-picker-back')), false, 'Back leads to an accounts view with nothing to show');
    });

    test('Back while still waiting, then the answer: the accounts are drawn (ok) or the options with the line (refused); never a skeleton', async (t) => {
        for (const reject of [false, true]) {
            const pj = held({ reject });
            const w = mount(t, pj);
            await tick(0);
            w.q('#wallet-picker-different').click();
            w.q('#wallet-picker-back').click();
            assert.equal(view(w), 'accounts');
            pj.release();
            await w.settle();
            await w.picker.ready;
            assert.ok(!w.q('.wallet-skel-account'), 'reject=' + reject + ': skeleton left');
            if (reject) {
                assert.equal(view(w), 'options');
                assert.match(problem(w, w.row('polkadot-js').closest('li')), /did not allow/);
            } else {
                assert.equal(view(w), 'accounts');
                assert.equal(w.qa('#wallet-accounts .wallet-account-btn').length, 1);
            }
        }
    });

    test('ok after "Use a different wallet": the row reads its count, and Back shows the accounts', async (t) => {
        const pj = held();
        const w = mount(t, pj);
        await tick(0);
        w.q('#wallet-picker-different').click();
        pj.release();
        await w.settle();
        await w.picker.ready;
        assert.equal(w.row('polkadot-js').querySelector('.wallet-option-action').textContent.trim(), '2 accounts');
        w.q('#wallet-picker-back').click();
        assert.equal(view(w), 'accounts');
        assert.ok(!w.q('.wallet-skel-account'));
        assert.equal(w.qa('#wallet-accounts .wallet-account-btn').length, 1);
    });
});

// ─── 4. a paired phone with no account ─────────────────────────────────────

describe('4. a paired phone that shares no Polkadex account', () => {
    test('one line under the phone row, announced; Try again reads the phone again and lists a new account', async (t) => {
        const w = mountChooser(t, { wallets: [fakeWallet('polkadot-js', [acct(21, 'A')])], phone: { connected: true, accounts: [] } });
        await w.picker.ready;
        w.action('phone').click();
        await w.settle();
        assert.equal(view(w), 'options');
        const li = w.action('phone').closest('li');
        assert.equal(problem(w, li).replace(/\s*Try again$/, ''), NO_PHONE_ACCOUNT);
        assert.equal(w.q('#wallet-picker-live').textContent.trim(), NO_PHONE_ACCOUNT);
        focused(w, w.action('phone'));
        w.phone.accounts.push(acct(70, 'My Nova account'));
        li.querySelector('.wallet-option-retry').click();
        await w.settle();
        assert.equal(view(w), 'accounts');
        assert.equal(w.qa('#wallet-accounts .wallet-account-btn').length, 1);
        assert.equal(w.enables()['polkadot-js'], 0, 'Try again on the phone asked an extension');
    });
});

// ─── 5. the guard sees every way of asking a wallet ────────────────────────

describe('5. the guard: every shape of asking a wallet outside lib/wallet-sources.js', () => {
    const PLANTED = [
        'const a = await provider?.enable(APP);',
        "const b = await injected[k]['enable'](APP);",
        'const c = await injected[k]["enable"](APP);',
        'const d = await injected[k].enable.call(injected[k], APP);',
        'const e = await injected[k].enable.apply(injected[k], [APP]);',
        "import { web3Enable } from '@polkadot/extension-dapp';",
        "const { web3Accounts } = await import('@polkadot/extension-dapp');",
        'const f = await injected[k].enable (APP);'
    ];
    test('each planted shape is reported, by file and line, with the code', () => {
        const src = ['// a comment that says provider?.enable( is fine', ...PLANTED].join('\n');
        const found = findEnableCalls([{ file: 'lib/planted.js', src }], { allow: ['lib/wallet-sources.js'] });
        assert.deepEqual(found.map(f => f.line), PLANTED.map((_, i) => i + 2), found.map(f => f.message).join('\n'));
        for (const f of found) assert.ok(f.message.startsWith(`lib/planted.js:${f.line} `) && f.message.endsWith(PLANTED[f.line - 2]), f.message);
    });

    test('a multi-line import of web3Enable is reported', () => {
        const src = "import {\n    web3Accounts,\n    web3Enable\n} from '@polkadot/extension-dapp';\n";
        const found = findEnableCalls([{ file: 'lib/planted.js', src }]);
        assert.ok(found.some(f => f.line === 3), found.map(f => f.message).join('\n'));
        assert.ok(found.some(f => f.line === 4), found.map(f => f.message).join('\n'));
    });

    test('look-alikes are not reported: .enabled(, typeof x.enable, an "enable" property read, comments', () => {
        const src = [
            'if (wcGate.enabled) start();',
            'const ok = typeof provider.enable === \'function\';',
            'feature.enabled(true);',
            '/* injected[k].enable.call(x) */',
            ' * provider?.enable(APP)',
            'const label = "enable notifications";'
        ].join('\n');
        assert.deepEqual(findEnableCalls([{ file: 'lib/x.js', src }]), []);
    });
});

// ─── 6. the rows' changing text reaches a screen reader ────────────────────

describe('6. option rows: the waiting line and the account count are announced', () => {
    test('waiting, still waiting and "2 accounts" are the row\'s description; the name stays the label', async (t) => {
        const pj = fakeWallet('polkadot-js', [acct(21, 'A'), acct(22, 'B')], { hold: true });
        const w = mountChooser(t, { wallets: [pj, fakeWallet('talisman', [acct(23, 'T')])], slowMs: 20 });
        await w.picker.ready;
        assert.equal(w.row('polkadot-js').getAttribute('aria-label'), 'Connect with Polkadot.js');
        w.row('polkadot-js').click();
        await tick(0);
        assert.match(described(w, w.row('polkadot-js')), /Approve the request in Polkadot\.js\./);
        await tick(40);
        assert.match(described(w, w.row('polkadot-js')), /Still waiting\. Look for a Polkadot\.js popup, or open the extension\./);
        pj.release();
        await w.settle();
        w.q('#wallet-picker-back').click();
        assert.match(described(w, w.row('polkadot-js')), /2 accounts/);
        const ids = w.qa('[id]').map(e => e.id);
        assert.equal(new Set(ids).size, ids.length, 'duplicate ids');
    });

    test('a problem line is part of the row\'s description', async (t) => {
        const w = mountChooser(t, { wallets: [fakeWallet('talisman', [], { reject: true })] });
        await w.picker.ready;
        w.row('talisman').click();
        await w.settle();
        assert.match(described(w, w.row('talisman')), /Talisman did not allow this site\./);
    });
});

// ─── 7. discussion sign-in in a session that recorded no wallet ────────────

describe('7. discussion sign-in, legacy session (no wallet recorded)', () => {
    test('the click asks each installed wallet once, signs with the holder and remembers it; the next sign-in asks only that one', async () => {
        const A = addr(1);
        const profile = makeProfile({ extensions: [fakeExtension('polkadot-js', [{ address: addr(2, 42), name: 'Bob' }]), fakeExtension('talisman', [{ address: addr(1, 42), name: 'Alice' }])] });
        profile.local.setItem('pdex_wallet_address', A);
        const tab = openTab(profile, { path: '/discussions' });
        const counts = () => Object.fromEntries(profile.extensions.map(e => [e.key, e.enableCalls]));
        const signer = await tab.fn('getWalletSigner')(A);
        assert.equal(signer && signer.extKey, 'talisman');
        assert.deepEqual(counts(), { 'polkadot-js': 1, talisman: 1 });
        assert.equal(tab.read('pdex_wallet_last_source'), 'talisman');
        assert.equal((await tab.fn('getWalletSigner')(A)).extKey, 'talisman');
        assert.deepEqual(counts(), { 'polkadot-js': 1, talisman: 1 }, 'the second sign-in asked again');
        tab.close();
    });
});
