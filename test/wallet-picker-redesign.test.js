// The Switch wallet / Connect wallet page, redesigned (spec:
// cto-team/plans/2026-11-11-switch-wallet-redesign.md).
//
// The old page printed the copy for both moments at once: in switch mode the
// user read a "Connected as" box, a green "Detected" banner, the first-connect
// paragraph and only then the list, where the current account appeared a
// second time. The account list is now the page; everything else is one line,
// behind a disclosure, or gone.
//
// Layers tested here:
//   1. lib/wallet-picker.js        pure: filtering, grouping, row markup
//   2. lib/wallet-picker-view.js   the page, mounted into a happy-dom document
//   3. lib/multisig-view.js        the collapsed multisig section (compact)
//   4. script.js                   the real wallet functions (helpers/wallet-world.js):
//                                  switch returns to ?returnTo=, which must be same-origin
//
// Addresses are synthetic (32 bytes of one repeated value). They belong to no one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import { escapeHtml } from '../lib/html-escape.js';
import { closeControlHtml } from '../lib/close-control.js';
import { filterAccounts, buildAccountListHtml, sourceLabel, SEARCH_THRESHOLD } from '../lib/wallet-picker.js';
import { mountWalletPicker } from '../lib/wallet-picker-view.js';
import { createMultisigUI } from '../lib/multisig-view.js';
import { normalizeMultisig } from '../lib/multisig.js';
import { makeProfile, openTab, fakeExtension, settle } from './helpers/wallet-world.js';

const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

const addr = (n, prefix = 88) => encodeAddress(new Uint8Array(32).fill(n), prefix);
const A = addr(21), B = addr(22), C = addr(23), D = addr(24);
const same = (a, b) => { try { return Buffer.from(decodeAddress(a)).equals(Buffer.from(decodeAddress(b))); } catch (e) { return false; } };
const valid = (a) => { try { decodeAddress(a); return true; } catch (e) { return false; } };
const short = (a) => String(a).slice(0, 8) + '...' + String(a).slice(-6);
const acct = (n, name, source = 'polkadot-js') => ({ address: addr(n), name, source });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// ─── the page, in a real (happy-dom) document ───────────────────────────────

function mount(t, opts = {}) {
    const window = new Window({ url: 'https://explorer.test/wallet', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    t.after(() => window.happyDOM.close());
    const doc = window.document;
    const root = doc.createElement('div');
    root.id = 'wallet-dashboard';
    doc.body.appendChild(root);
    const calls = { select: [], disconnect: 0, multisig: [], closes: 0, loads: 0 };
    let list = 'accounts' in opts ? opts.accounts : [acct(21, 'Alice'), acct(22, 'Bob')];
    const deps = {
        doc, current: opts.current || '', currentSource: opts.currentSource || '', onMobile: !!opts.onMobile, hash: opts.hash || '',
        getAccounts: opts.getAccounts || (async () => { calls.loads++; return list === null ? null : list.map(a => ({ ...a })); }),
        select: (a, s) => calls.select.push([a, s]),
        disconnect: opts.disconnect || (() => { calls.disconnect++; }),
        isSame: same, isValid: valid, esc: escapeHtml, shortAddr: short,
        helpHtml: '<a href="/help/connecting-wallet" class="help-inline-icon" title="How wallets work on Polkadex Explorer" aria-label="How wallets work on Polkadex Explorer"></a>',
        closeHtml: closeControlHtml({ parent: 'home' }),
        mobileCardsHtml: '<div class="mobile-wallet-grid">CARDS</div>', currentUrl: 'https://explorer.test/wallet',
        clipboard: { writeText: async () => {} },
        mountMultisig: (el, o) => { calls.multisig.push(o); el.innerHTML = '<div class="ms-stub">MS</div>'; },
        slowMs: opts.slowMs
    };
    const picker = mountWalletPicker(root, deps);
    root.querySelector('.close-control').addEventListener('click', () => { calls.closes++; });
    const q = (s) => root.querySelector(s);
    const qa = (s) => Array.from(root.querySelectorAll(s));
    const text = () => root.textContent.replace(/\s+/g, ' ');
    return { window, doc, root, calls, picker, q, qa, text, setAccounts: (v) => { list = v; } };
}
const key = (w, el, k) => el.dispatchEvent(new w.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
const type = (w, input, v) => { input.value = v; input.dispatchEvent(new w.window.Event('input', { bubbles: true })); };

describe('switching state (a wallet is connected)', () => {
    test('title, one subtitle line, and the current account exactly once, as a Current row that is not a button', async (t) => {
        const w = mount(t, { current: A, currentSource: 'polkadot-js' });
        await w.picker.ready;
        assert.equal(w.q('#wallet-picker-title').textContent.trim(), 'Switch wallet');
        assert.equal(w.q('.wallet-picker-sub').textContent.trim(), 'Choose the account you want to use.');
        const rows = w.qa('[data-address]').filter(e => same(e.getAttribute('data-address'), A));
        assert.equal(rows.length, 1, 'the current account appears once');
        const cur = rows[0];
        assert.notEqual(cur.tagName, 'BUTTON', 'the Current row is not clickable');
        assert.equal(cur.getAttribute('aria-current'), 'true');
        assert.match(cur.textContent, /Alice/);
        assert.equal(cur.querySelector('.wallet-account-badge').textContent.trim(), 'Current');
        const dis = cur.querySelector('#wallet-picker-disconnect');
        assert.ok(dis && dis.tagName === 'BUTTON', 'Disconnect sits on the current row');
        assert.equal(dis.textContent.trim(), 'Disconnect');
        assert.equal(dis.getAttribute('title'), 'Disconnect this wallet from Polkadex Explorer');
        assert.equal(w.qa('.wallet-account-btn').length, 1, 'only Bob is a button');
    });

    test('the removed elements are gone: Connected-as box, Keep this wallet, Detected banner, intro paragraph', async (t) => {
        const w = mount(t, { current: A, currentSource: 'polkadot-js' });
        await w.picker.ready;
        const html = w.root.innerHTML;
        for (const gone of ['Connected as', 'wallet-picker-stay', 'Keep this wallet', 'wallet-current-banner', 'wallet-env-banner', 'Detected',
            'Substrate', 'Connect a Substrate wallet', 'look up any address without connecting', 'Account not listed?', 'Pick another account']) {
            assert.ok(!html.includes(gone), gone + ' is still on the page');
        }
        assert.equal(w.q('.wallet-create-line'), null, 'switch mode does not offer Create a wallet');
        assert.equal(w.qa('.wallet-picker-footnote').length, 1, 'one safety line');
        assert.match(w.q('.wallet-picker-footnote').textContent, /Polkadex Explorer never moves funds on its own\. Every transaction needs your approval in your wallet\./);
    });

    test('clicking another account switches to it (the page then navigates; see the script.js tests below)', async (t) => {
        const w = mount(t, { current: A, currentSource: 'polkadot-js' });
        await w.picker.ready;
        w.q('.wallet-account-btn[data-address="' + B + '"]').click();
        assert.deepEqual(w.calls.select, [[B, 'polkadot-js']]);
    });

    test('Disconnect calls disconnect, with no confirmation', async (t) => {
        const w = mount(t, { current: A, currentSource: 'polkadot-js' });
        await w.picker.ready;
        w.q('#wallet-picker-disconnect').click();
        assert.equal(w.calls.disconnect, 1);
    });

    test('the same key in two extensions: one Current row, in the extension it was picked from', async (t) => {
        const w = mount(t, { current: A, currentSource: 'talisman', accounts: [acct(21, 'Alice pj', 'polkadot-js'), { ...acct(21, 'Alice ta', 'talisman'), address: addr(21, 42) }] });
        await w.picker.ready;
        const cur = w.qa('[aria-current="true"]');
        assert.equal(cur.length, 1);
        assert.equal(cur[0].getAttribute('data-source'), 'talisman');
        assert.equal(w.qa('.wallet-account-badge').length, 1);
        assert.equal(w.qa('.wallet-account-group')[0].getAttribute('data-source'), 'talisman', 'the current group is listed first');
    });

    test('a typed read-only address still gets one Current row, in a group of its own, so Disconnect has a home', async (t) => {
        const w = mount(t, { current: D, currentSource: '' });
        await w.picker.ready;
        const g = w.qa('.wallet-account-group')[0];
        assert.equal(g.getAttribute('data-source'), '');
        assert.match(g.querySelector('.wallet-group-head').textContent, /Read-only address/);
        assert.ok(g.querySelector('[aria-current="true"] #wallet-picker-disconnect'));
        assert.equal(w.qa('[aria-current="true"]').length, 1);
    });

    test('a connected multisig gets a Current row under "Multisig wallet"', async (t) => {
        const w = mount(t, { current: D, currentSource: 'multisig' });
        await w.picker.ready;
        const g = w.qa('.wallet-account-group')[0];
        assert.match(g.querySelector('.wallet-group-head').textContent, /Multisig wallet/);
        assert.ok(g.querySelector('[aria-current="true"]'));
    });
});

describe('first connect (nothing connected)', () => {
    test('title, subtitle, no Current row, no Disconnect, and the Create a wallet line', async (t) => {
        const w = mount(t);
        await w.picker.ready;
        assert.equal(w.q('#wallet-picker-title').textContent.trim(), 'Connect wallet');
        assert.equal(w.q('.wallet-picker-sub').textContent.trim(), 'Choose an account to open your dashboard.');
        assert.equal(w.q('[aria-current]'), null);
        assert.equal(w.q('#wallet-picker-disconnect'), null);
        assert.equal(w.qa('.wallet-account-btn').length, 2);
        assert.match(w.q('.wallet-create-line').textContent, /New to Polkadex\? Create a wallet/);
        assert.ok(w.q('.wallet-picker-footnote'));
        assert.equal(w.q('section.wallet-picker').getAttribute('data-mode'), 'connect');
    });
});

describe('edge states', () => {
    test('no extension (desktop): heading, install links, Refresh, and View any address open', async (t) => {
        const w = mount(t, { accounts: null });
        await w.picker.ready;
        const empty = w.q('.wallet-picker-empty');
        assert.equal(empty.querySelector('h3').textContent.trim(), 'No wallet found in this browser');
        assert.match(empty.textContent, /Install a wallet extension, then refresh\./);
        assert.match(empty.textContent, /Get Polkadot\.js/);
        assert.match(empty.textContent, /Talisman/);
        assert.match(empty.textContent, /SubWallet/);
        assert.ok(empty.querySelector('.wallet-picker-refresh-btn'));
        assert.equal(w.q('#wallet-picker-view').open, true, 'View any address is open: it is the one thing the user can do');
        assert.equal(w.q('#wallet-picker-footnote').hidden, true, 'no safety line: nothing to approve yet');
        assert.equal(w.q('#wallet-picker-missing').hidden, true);
        assert.equal(w.q('#wallet-mobile-section').hidden, false, 'Wallet on your phone? is offered');
        assert.equal(w.q('#wallet-mobile-section').open, false);
        assert.ok(w.q('.wallet-create-line'));
    });

    test('no extension on a phone: the wallet app cards are shown open, with Copy link', async (t) => {
        const w = mount(t, { accounts: null, onMobile: true });
        await w.picker.ready;
        assert.match(w.q('.wallet-picker-empty').textContent, /Phone browsers cannot use wallet extensions\. Open this page inside your wallet app instead\./);
        const phone = w.q('#wallet-mobile-section');
        assert.equal(phone.open, true);
        assert.match(phone.textContent, /Open in your wallet app/);
        assert.match(phone.textContent, /CARDS/);
        assert.equal(w.q('#wallet-copy-btn').textContent.trim(), 'Copy link');
    });

    test('in a wallet app with accounts listed, the phone cards collapse to "Wallet on your phone?"', async (t) => {
        const w = mount(t, { onMobile: true });
        await w.picker.ready;
        const phone = w.q('#wallet-mobile-section');
        assert.equal(phone.hidden, false);
        assert.equal(phone.open, false);
        assert.equal(phone.querySelector('summary').textContent.trim(), 'Wallet on your phone?');
    });

    test('on desktop with accounts listed there is no phone section and View any address is collapsed', async (t) => {
        const w = mount(t);
        await w.picker.ready;
        assert.equal(w.q('#wallet-mobile-section').hidden, true);
        assert.equal(w.q('#wallet-picker-view').open, false);
        assert.equal(w.q('#wallet-picker-view summary').textContent.trim(), 'View any address');
    });

    test('in switch mode with no extension, the Current row is shown above the empty state', async (t) => {
        const w = mount(t, { accounts: null, current: A, currentSource: 'polkadot-js' });
        await w.picker.ready;
        assert.ok(w.q('[aria-current="true"] #wallet-picker-disconnect'));
        assert.ok(w.q('.wallet-picker-empty'));
        const html = w.q('#wallet-accounts').innerHTML;
        assert.ok(html.indexOf('aria-current') < html.indexOf('wallet-picker-empty'));
    });

    test('zero accounts shared: one message with three steps and a full Refresh button; no "Don\'t see your account?"', async (t) => {
        const w = mount(t, { accounts: [] });
        await w.picker.ready;
        const empty = w.q('.wallet-picker-empty');
        assert.equal(empty.querySelector('h3').textContent.trim(), 'Your wallet did not share any accounts');
        const steps = Array.from(empty.querySelectorAll('ol li')).map(li => li.textContent.trim());
        assert.deepEqual(steps, ['Open your wallet extension and unlock it.', 'Allow Polkadex Explorer to see at least one account.', 'Press Refresh.']);
        assert.equal(empty.querySelector('.wallet-picker-refresh-btn').textContent.trim(), 'Refresh');
        assert.equal(w.q('#wallet-picker-missing').hidden, true);
        assert.equal(w.q('#wallet-picker-footnote').hidden, false);
        w.setAccounts([acct(23, 'Carol')]);
        empty.querySelector('.wallet-picker-refresh-btn').click();
        await w.picker.idle();
        assert.equal(w.qa('.wallet-account-btn').length, 1, 'Refresh picks up the account just allowed');
    });

    test('search appears above 8 accounts, not at 8; the label and group headers carry counts only then', async (t) => {
        const eight = Array.from({ length: SEARCH_THRESHOLD }, (_, i) => acct(30 + i, 'Account ' + i));
        const w8 = mount(t, { accounts: eight });
        await w8.picker.ready;
        assert.equal(w8.q('#wallet-picker-search-wrap').hidden, true);
        assert.equal(w8.q('#wallet-picker-count-label').textContent.trim(), 'Your accounts');
        assert.ok(!/\(\d+\)/.test(w8.q('.wallet-group-head').textContent));
        const w9 = mount(t, { accounts: [...eight, acct(60, 'Account 8')] });
        await w9.picker.ready;
        assert.equal(w9.q('#wallet-picker-search-wrap').hidden, false);
        assert.equal(w9.q('#wallet-picker-count-label').textContent.trim(), 'Your accounts (9)');
        assert.match(w9.q('.wallet-group-head').textContent, /Polkadot\.js \(9\)/);
    });

    test('20+ accounts across two extensions: search filters as you type, groups with no match disappear, no match offers Clear search', async (t) => {
        const many = [
            ...Array.from({ length: 14 }, (_, i) => acct(30 + i, 'Polka ' + i, 'polkadot-js')),
            ...Array.from({ length: 9 }, (_, i) => acct(60 + i, 'Tali ' + i, 'talisman'))
        ];
        const w = mount(t, { accounts: many });
        await w.picker.ready;
        assert.equal(w.q('#wallet-picker-count-label').textContent.trim(), 'Your accounts (23)');
        const search = w.q('#wallet-picker-search');
        assert.equal(search.getAttribute('placeholder'), 'Search by name or address');
        assert.equal(search.getAttribute('inputmode'), 'search');
        assert.notEqual(w.doc.activeElement, search, 'the search field does not steal focus on load');
        type(w, search, 'tali 1');
        assert.equal(w.qa('.wallet-account-btn').length, 1);
        assert.equal(w.qa('.wallet-account-group').length, 1, 'the Polkadot.js group disappeared');
        assert.match(w.q('#wallet-picker-live').textContent, /1 account matches/);
        type(w, search, 'zzz');
        assert.equal(w.qa('.wallet-account-btn').length, 0);
        assert.match(w.q('.wallet-picker-nomatch').textContent, /No account matches "zzz"\. Clear search/);
        w.q('.wallet-picker-nomatch button').click();
        assert.equal(search.value, '');
        assert.equal(w.qa('.wallet-account-btn').length, 23);
    });

    test('a pasted full address in another network format finds its row (matched by public key)', async (t) => {
        const many = Array.from({ length: 10 }, (_, i) => acct(30 + i, 'Account ' + i));
        const w = mount(t, { accounts: many });
        await w.picker.ready;
        type(w, w.q('#wallet-picker-search'), addr(35, 0));
        const rows = w.qa('.wallet-account-btn');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].getAttribute('data-address'), addr(35));
    });

    test('multiple extensions: one group each, with an icon tile and the name; current group first', async (t) => {
        const w = mount(t, { current: C, currentSource: 'talisman', accounts: [acct(21, 'Alice', 'polkadot-js'), acct(22, 'Bob', 'subwallet-js'), acct(23, 'Carol', 'talisman')] });
        await w.picker.ready;
        const groups = w.qa('.wallet-account-group');
        assert.deepEqual(groups.map(g => g.getAttribute('data-source')), ['talisman', 'polkadot-js', 'subwallet-js']);
        for (const g of groups) {
            const head = g.querySelector('.wallet-group-head');
            assert.equal(g.getAttribute('role'), 'group');
            assert.equal(g.getAttribute('aria-labelledby'), head.id);
            const tile = head.querySelector('.wallet-ext-tile');
            assert.equal(tile.getAttribute('aria-hidden'), 'true');
        }
        assert.deepEqual(groups.map(g => g.querySelector('.wallet-ext-tile').textContent.trim()), ['TA', 'PJ', 'SW']);
        assert.deepEqual(groups.map(g => g.querySelector('.wallet-group-head').textContent.replace(/^\s*\w\w\s*/, '').trim()), ['Talisman', 'Polkadot.js', 'SubWallet']);
    });

    test('loading: skeleton rows and "Looking for wallets..."; after the slow threshold, the popup hint', async (t) => {
        let release;
        const w = mount(t, { getAccounts: () => new Promise(r => { release = r; }), slowMs: 20 });
        assert.ok(w.qa('.wallet-skel-account').length >= 2);
        assert.equal(w.q('#wallet-picker-status').textContent.trim(), 'Looking for wallets...');
        const r = w.q('#wallet-picker-refresh');
        assert.equal(r.disabled, true);
        assert.equal(r.getAttribute('aria-busy'), 'true');
        await tick(40);
        assert.equal(w.q('#wallet-picker-status').textContent.trim(), 'Waiting for your wallet. Check for a popup from your wallet extension.');
        release([acct(21, 'Alice')]);
        await w.picker.ready;
        assert.equal(r.disabled, false);
        assert.equal(r.getAttribute('aria-busy'), 'false');
        assert.equal(w.q('#wallet-picker-status').textContent.trim(), '');
        assert.equal(w.q('#wallet-picker-live').textContent.trim(), '1 account found.');
    });

    test('Refresh keeps the rows on screen while it asks again, then replaces them', async (t) => {
        const w = mount(t);
        await w.picker.ready;
        w.setAccounts([acct(21, 'Alice'), acct(22, 'Bob'), acct(23, 'Carol')]);
        w.q('#wallet-picker-refresh').click();
        assert.equal(w.qa('.wallet-account-btn').length, 2, 'no flash to empty');
        assert.equal(w.qa('.wallet-skel-account').length, 0);
        await w.picker.idle();
        assert.equal(w.qa('.wallet-account-btn').length, 3);
        assert.equal(w.q('#wallet-picker-live').textContent.trim(), '3 accounts found.');
    });
});

describe('"Don\'t see your account?"', () => {
    test('a collapsed disclosure that says what to do and offers Refresh accounts', async (t) => {
        const w = mount(t);
        await w.picker.ready;
        const d = w.q('#wallet-picker-missing');
        assert.equal(d.tagName, 'DETAILS');
        assert.equal(d.open, false);
        assert.equal(d.hidden, false);
        assert.equal(d.querySelector('summary').textContent.trim(), "Don't see your account?");
        assert.match(d.textContent, /Your wallet only shows the accounts you have allowed for this site\./);
        assert.match(d.textContent, /Open your wallet extension and allow Polkadex Explorer to see the account\./);
        assert.match(d.textContent, /Using a different wallet extension\? Install or unlock it, then refresh\./);
        const loads = w.calls.loads;
        const btn = d.querySelector('.wallet-picker-refresh-btn');
        assert.equal(btn.textContent.trim(), 'Refresh accounts');
        btn.click();
        await w.picker.idle();
        assert.equal(w.calls.loads, loads + 1);
    });
});

describe('keyboard and screen reader', () => {
    test('a labelled section, list semantics, row names, and one polite live region', async (t) => {
        const w = mount(t, { current: A, currentSource: 'polkadot-js' });
        await w.picker.ready;
        const sec = w.q('section.wallet-picker');
        assert.equal(sec.getAttribute('aria-labelledby'), 'wallet-picker-title');
        assert.equal(w.q('#wallet-picker-title').getAttribute('tabindex'), '-1');
        const ul = w.q('.wallet-account-list');
        assert.equal(ul.tagName, 'UL');
        assert.equal(ul.getAttribute('role'), 'list');
        assert.ok(Array.from(ul.children).every(li => li.tagName === 'LI'));
        const bob = w.q('.wallet-account-btn');
        assert.equal(bob.getAttribute('aria-label'), `Switch to Bob, ${short(B)}, Polkadot.js`);
        assert.equal(bob.getAttribute('type'), 'button');
        const cur = w.q('[aria-current="true"]');
        assert.match(cur.textContent.replace(/\s+/g, ' '), /current account/);
        assert.equal(w.qa('[aria-live="polite"]').length, 1);
        const refresh = w.q('#wallet-picker-refresh');
        assert.equal(refresh.getAttribute('aria-label'), 'Refresh accounts');
        assert.equal(refresh.getAttribute('title'), 'Refresh accounts');
        assert.equal(w.q('.close-control').getAttribute('aria-label'), 'Close');
    });

    test('tab order: close, help, refresh, rows (current row skipped, its Disconnect included), then the disclosures', async (t) => {
        const w = mount(t, { current: A, currentSource: 'polkadot-js' });
        await w.picker.ready;
        const focusables = w.qa('button:not([disabled]), a[href], summary, input')
            .filter(el => !el.closest('[hidden]') && !(el.closest('details') && !el.closest('details').open && el.tagName !== 'SUMMARY'));
        const names = focusables.map(el => el.id || el.className || el.tagName);
        const pos = (pred) => focusables.findIndex(pred);
        const iClose = pos(e => e.classList.contains('close-control'));
        const iHelp = pos(e => e.classList.contains('help-inline-icon'));
        const iRefresh = pos(e => e.id === 'wallet-picker-refresh');
        const iDis = pos(e => e.id === 'wallet-picker-disconnect');
        const iBob = pos(e => e.classList.contains('wallet-account-btn'));
        const iMissing = pos(e => e.tagName === 'SUMMARY' && e.closest('#wallet-picker-missing'));
        const iView = pos(e => e.tagName === 'SUMMARY' && e.closest('#wallet-picker-view'));
        assert.ok(iClose < iHelp && iHelp < iRefresh && iRefresh < iDis && iDis < iBob && iBob < iMissing && iMissing < iView, names.join(' | '));
    });

    test('Escape clears the search first, and only closes the page on a second press', async (t) => {
        const many = Array.from({ length: 10 }, (_, i) => acct(30 + i, 'Account ' + i));
        const w = mount(t, { accounts: many });
        await w.picker.ready;
        const search = w.q('#wallet-picker-search');
        type(w, search, 'Account 3');
        assert.equal(w.qa('.wallet-account-btn').length, 1);
        key(w, search, 'Escape');
        assert.equal(search.value, '');
        assert.equal(w.qa('.wallet-account-btn').length, 10);
        assert.equal(w.calls.closes, 0, 'the first Escape only cleared the search');
        key(w, search, 'Escape');
        assert.equal(w.calls.closes, 1, 'the second Escape closes the page through the X');
    });

    test('the search clear button empties the field', async (t) => {
        const many = Array.from({ length: 10 }, (_, i) => acct(30 + i, 'Account ' + i));
        const w = mount(t, { accounts: many });
        await w.picker.ready;
        type(w, w.q('#wallet-picker-search'), 'Account 3');
        const clear = w.q('#wallet-picker-search-clear');
        assert.equal(clear.getAttribute('aria-label'), 'Clear search');
        clear.click();
        assert.equal(w.q('#wallet-picker-search').value, '');
        assert.equal(w.qa('.wallet-account-btn').length, 10);
    });

    test('rows are native buttons, so Enter and Space work without extra code', async (t) => {
        const w = mount(t);
        await w.picker.ready;
        assert.ok(w.qa('.wallet-account-btn').every(b => b.tagName === 'BUTTON'));
    });

    test('View any address: hint, placeholder, button, and the unchanged error', async (t) => {
        const w = mount(t);
        await w.picker.ready;
        const v = w.q('#wallet-picker-view');
        assert.match(v.textContent, /Read only\. You can look, but not sign\./);
        assert.equal(w.q('#wallet-manual-input').getAttribute('placeholder'), 'Polkadex address');
        assert.equal(w.q('#wallet-manual-btn').textContent.trim(), 'View');
        w.q('#wallet-manual-input').value = 'nope';
        w.q('#wallet-manual-btn').click();
        assert.equal(w.q('#wallet-manual-error').textContent, 'That does not look like a valid Polkadex address.');
        w.q('#wallet-manual-input').value = D;
        w.q('#wallet-manual-btn').click();
        assert.deepEqual(w.calls.select, [[D, '']]);
    });
});

describe('mobile', () => {
    test('the section carries the mobile hook, and the stylesheet lays it out at 640px and 400px', async (t) => {
        const w = mount(t, { onMobile: true, current: A, currentSource: 'polkadot-js' });
        await w.picker.ready;
        assert.ok(w.q('section.wallet-picker').classList.contains('is-mobile'));
        const desk = mount(t);
        await desk.picker.ready;
        assert.ok(!desk.q('section.wallet-picker').classList.contains('is-mobile'));
        const at640 = CSS.slice(CSS.indexOf('/* Switch wallet page: mobile */'));
        assert.match(at640, /@media \(max-width: 640px\)[\s\S]*\.wallet-picker/);
        assert.match(at640, /@media \(max-width: 400px\)[\s\S]*wallet-picker-view/);
        assert.match(at640, /min-height: 44px/);
    });
});

describe('the multisig section, from the picker', () => {
    test('the picker mounts it compact, and opens it only for #multisig', async (t) => {
        const w = mount(t, { current: A, currentSource: 'polkadot-js' });
        await w.picker.ready;
        assert.equal(w.calls.multisig.length, 1);
        assert.equal(w.calls.multisig[0].compact, true);
        assert.equal(w.calls.multisig[0].open, false);
        const w2 = mount(t, { current: A, currentSource: 'polkadot-js', hash: '#multisig' });
        await w2.picker.ready;
        assert.equal(w2.calls.multisig[0].open, true);
    });
});

// ─── lib/wallet-picker (pure) ────────────────────────────────────────────────

describe('lib/wallet-picker', () => {
    const list = [acct(21, 'Alice'), acct(22, 'Bob Treasury', 'talisman'), acct(23, 'carol')];
    test('filterAccounts: case-insensitive on name and address, public key for a pasted address, all for an empty query', () => {
        assert.deepEqual(filterAccounts(list, 'TREAS', same).map(a => a.name), ['Bob Treasury']);
        assert.deepEqual(filterAccounts(list, 'CAROL', same).map(a => a.name), ['carol']);
        assert.deepEqual(filterAccounts(list, A.slice(0, 10), same).map(a => a.name), ['Alice']);
        assert.deepEqual(filterAccounts(list, addr(22, 42), same).map(a => a.name), ['Bob Treasury']);
        assert.equal(filterAccounts(list, '   ', same).length, 3);
        assert.equal(filterAccounts(list, '', same).length, 3);
    });

    test('sourceLabel: typed addresses read "Read-only address"', () => {
        assert.equal(sourceLabel(''), 'Read-only address');
        assert.equal(sourceLabel('multisig'), 'Multisig wallet');
        assert.equal(sourceLabel('polkagate'), 'PolkaGate');
    });

    test('an account name from the extension is escaped', () => {
        const html = buildAccountListHtml({ accounts: [{ address: A, name: '<img src=x onerror=alert(1)>', source: 'polkadot-js' }], current: '', currentSource: '', isSame: same, esc: escapeHtml, shortAddr: short });
        assert.ok(!html.includes('<img'));
        assert.match(html, /&lt;img/);
    });
});

// ─── lib/multisig-view, compact ──────────────────────────────────────────────

const SIGNERS = [addr(21), addr(22), addr(23)];
function msWorld(t, { saved = [], selected = A, discover, api = { genesisHash: { toHex: () => '0x00' } }, open = false } = {}) {
    const window = new Window({ url: 'https://explorer.test/wallet', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    t.after(() => window.happyDOM.close());
    const doc = window.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);
    const rows = saved.slice();
    const selects = [];
    let discoverCalls = 0;
    const ui = createMultisigUI({
        store: { list: () => rows.slice(), find: (a) => rows.find(m => same(m.address, a)) || null, save: (v) => { const m = normalizeMultisig(v); rows.push(m); return m; } },
        storage: { getItem: () => null, setItem() {} }, api: () => api, accounts: async () => [], selected: () => selected,
        select: (a, s) => selects.push([a, s]), submit: async () => {}, refresh() {}, fetchJson: async () => ({}),
        discover: (...a) => { discoverCalls++; return discover(...a); }
    });
    ui.mountAccounts(el, { compact: true, open });
    const q = (s) => el.querySelector(s);
    return { el, q, selects, discoverCalls: () => discoverCalls, ui, doc, window };
}
const team = () => normalizeMultisig({ name: 'Team wallet', signers: SIGNERS, threshold: 2 });

describe('lib/multisig-view compact: one collapsed line under the account list', () => {
    test('found: collapsed by default, the count in the summary, rows with "2 of 3" and a chevron', async (t) => {
        const m = team();
        const w = msWorld(t, { discover: async () => ({ wallets: [m], scannedEvents: 606, limited: false, unavailableBlocks: 0 }) });
        await tick(5);
        const d = w.q('details.ms-compact');
        assert.equal(d.open, false);
        const summary = d.querySelector('summary');
        assert.match(summary.textContent.replace(/\s+/g, ' '), /Multisig wallets \(1\)/);
        d.open = true;
        const row = d.querySelector('.wallet-account-btn[data-multisig]');
        assert.equal(row.getAttribute('aria-label'), 'Open Team wallet, multisig, 2 of 3 approvals');
        assert.match(row.textContent, /Team wallet/);
        assert.match(row.textContent, /2 of 3/);
        assert.ok(!row.textContent.includes('Open wallet'));
        assert.ok(row.querySelector('.bx-chevron-right'));
        assert.match(d.textContent, /Not listed\? Add a multisig wallet/);
        const html = w.el.innerHTML;
        for (const gone of ['Discovery limits', 'Refresh discovery', 'Found 1 multisig', 'recent indexed', 'multisig-discovery-note']) assert.ok(!html.includes(gone), gone);
        row.click();
        assert.deepEqual(w.selects, [[m.address, 'multisig']]);
    });

    test('the "(?)" popover carries the limits and the events-checked figure; it toggles and closes on Escape', async (t) => {
        const w = msWorld(t, { discover: async () => ({ wallets: [team()], scannedEvents: 606, limited: false, unavailableBlocks: 0 }) });
        await tick(5);
        const btn = w.q('.wp-help-btn');
        assert.equal(btn.getAttribute('aria-label'), 'About multisig wallets');
        const pop = w.doc.getElementById(btn.getAttribute('aria-controls'));
        assert.equal(btn.getAttribute('aria-expanded'), 'false');
        assert.equal(pop.hidden, true);
        btn.click();
        assert.equal(btn.getAttribute('aria-expanded'), 'true');
        assert.equal(pop.hidden, false);
        assert.equal(w.q('details.ms-compact').open, false, 'the (?) does not toggle the section');
        assert.match(pop.textContent, /A multisig is a shared wallet that needs approval from several people\. We find yours from this account's recent activity \(606 events checked\)\. Older or never-used multisigs may not appear\. If yours is missing, add it by hand\./);
        btn.dispatchEvent(new w.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(pop.hidden, true);
        assert.equal(btn.getAttribute('aria-expanded'), 'false');
    });

    test('still looking: a spinner, never a number', async (t) => {
        const w = msWorld(t, { discover: () => new Promise(() => {}) });
        await tick(5);
        const summary = w.q('details.ms-compact summary');
        assert.ok(!/\(\d+\)/.test(summary.textContent));
        assert.ok(summary.querySelector('.bx-spin'));
        assert.match(summary.textContent, /Multisig wallets, looking/);
        w.q('details.ms-compact').open = true;
        assert.match(w.q('details.ms-compact').textContent, /Looking for multisig wallets\.\.\./);
    });

    test('none found: no "(0)" badge; open, it says so and offers Add a multisig wallet', async (t) => {
        const w = msWorld(t, { discover: async () => ({ wallets: [], scannedEvents: 10, limited: false, unavailableBlocks: 0 }) });
        await tick(5);
        const d = w.q('details.ms-compact');
        assert.ok(!/\(\d+\)/.test(d.querySelector('summary').textContent));
        assert.match(d.textContent, /No multisig wallets found for this account\./);
        assert.match(d.textContent, /Add a multisig wallet/);
        assert.ok(!/Not listed\?/.test(d.textContent));
    });

    test('a partial search shows "(!)", not a count that could be wrong', async (t) => {
        const w = msWorld(t, { discover: async () => ({ wallets: [team()], scannedEvents: 1000, limited: true, unavailableBlocks: 0 }) });
        await tick(5);
        const d = w.q('details.ms-compact');
        assert.match(d.querySelector('summary').textContent, /\(!\)/);
        assert.ok(!/\(1\)/.test(d.querySelector('summary').textContent));
        assert.match(d.textContent, /We could not check everything, so a wallet may be missing\. Try again, or add it by hand\./);
    });

    test('a failed search shows "(!)" and plain words; no node says so', async (t) => {
        const w = msWorld(t, { discover: async () => { throw new Error('boom'); } });
        await tick(5);
        assert.match(w.q('details.ms-compact summary').textContent, /\(!\)/);
        assert.match(w.q('details.ms-compact').textContent, /We could not finish checking\. Try again, or add your wallet by hand\./);
        const w2 = msWorld(t, { api: null, discover: async () => ({ wallets: [] }) });
        await tick(5);
        assert.match(w2.q('details.ms-compact').textContent, /Not connected to the network yet\. Try again in a moment\./);
    });

    test('Check again re-runs the search', async (t) => {
        const w = msWorld(t, { discover: async () => ({ wallets: [], scannedEvents: 5, limited: false, unavailableBlocks: 0 }) });
        await tick(5);
        const again = w.q('.ms-check-again');
        assert.equal(again.getAttribute('aria-label'), 'Check again');
        const before = w.discoverCalls();
        again.click();
        await tick(5);
        assert.equal(w.discoverCalls(), before + 1);
    });

    test('Add a multisig wallet opens the existing form in place, with the new labels; Cancel closes it', async (t) => {
        const w = msWorld(t, { discover: async () => ({ wallets: [], scannedEvents: 5, limited: false, unavailableBlocks: 0 }) });
        await tick(5);
        const form = w.q('form.multisig-import');
        assert.equal(form.hidden, true);
        w.q('.ms-add-link').click();
        assert.equal(form.hidden, false);
        const labels = Array.from(form.querySelectorAll('label')).map(l => l.firstChild.textContent.trim());
        assert.deepEqual(labels, ['Name', 'Multisig address', 'Signer addresses', 'Approvals needed']);
        for (const n of ['name', 'address', 'signers', 'threshold']) assert.ok(form.querySelector(`[name="${n}"]`), n);
        assert.match(form.textContent, /We only check that these details match the address\. Nothing is sent\./);
        assert.equal(form.querySelector('button[type="submit"]').textContent.trim(), 'Add wallet');
        form.querySelector('.ms-cancel').click();
        assert.equal(form.hidden, true);
        assert.equal(w.q('details.ms-compact').open, true, 'Cancel keeps the section open');
    });

    test('nothing connected and nothing saved: the section is one link, "Add a multisig wallet"', async (t) => {
        const w = msWorld(t, { selected: '', discover: async () => ({ wallets: [] }) });
        await tick(5);
        assert.equal(w.q('details.ms-compact'), null);
        assert.equal(w.q('.ms-add-link').textContent.trim(), 'Add a multisig wallet');
        assert.equal(w.discoverCalls(), 0);
        w.q('.ms-add-link').click();
        assert.equal(w.q('form.multisig-import').hidden, false);
    });

    test('nothing connected, wallets saved: their count, and the nothing-connected popover text', async (t) => {
        const w = msWorld(t, { selected: '', saved: [team()], discover: async () => ({ wallets: [] }) });
        await tick(5);
        assert.match(w.q('details.ms-compact summary').textContent, /\(1\)/);
        const pop = w.doc.getElementById(w.q('.wp-help-btn').getAttribute('aria-controls'));
        assert.match(pop.textContent, /Connect an account to find yours, or add one by hand\./);
    });

    test('the connected multisig is not listed again (it is the Current row at the top of the page)', async (t) => {
        const m = team();
        const other = normalizeMultisig({ name: 'Ops', signers: SIGNERS, threshold: 3 });
        const w = msWorld(t, { selected: m.address, saved: [m, other], discover: async () => ({ wallets: [] }) });
        await tick(5);
        const rows = Array.from(w.el.querySelectorAll('[data-multisig]')).map(b => b.getAttribute('data-multisig'));
        assert.deepEqual(rows, [other.address]);
    });

    test('opens on its own only when asked (the #multisig link)', async (t) => {
        const w = msWorld(t, { open: true, discover: async () => ({ wallets: [] }) });
        await tick(5);
        assert.equal(w.q('details.ms-compact').open, true);
    });

    test('the dashboard (not compact) keeps its existing form', async (t) => {
        const window = new Window({ url: 'https://explorer.test/' });
        t.after(() => window.happyDOM.close());
        const el = window.document.createElement('div');
        window.document.body.appendChild(el);
        const ui = createMultisigUI({ store: { list: () => [], find: () => null }, storage: {}, api: () => null, accounts: async () => [], selected: () => '', select() {}, submit: async () => {}, refresh() {}, fetchJson: null });
        ui.mountAccounts(el, {});
        assert.ok(el.querySelector('section.multisig-panel h3'));
        assert.equal(el.querySelector('details.ms-compact'), null);
    });
});

// ─── script.js: switch returns to where it started ─────────────────────────

const acct42 = (n, name) => ({ address: addr(n, 42), name });
describe('script.js: switch from the header returns to the page it started on', () => {
    test('openWalletPicker from /democracy carries returnTo; clicking another account lands back on /democracy', async () => {
        const profile = makeProfile({ extensions: [fakeExtension('polkadot-js', [acct42(21, 'Alice'), acct42(22, 'Bob')])] });
        profile.local.setItem('pdex_wallet_address', A);
        profile.local.setItem('pdex_wallet_source', 'polkadot-js');
        const tab = openTab(profile, { path: '/democracy', search: '?ref=4' });
        tab.fn('openWalletPicker')();
        await settle();
        assert.equal(tab.ctx.window.location.pathname, '/wallet');
        assert.match(tab.ctx.window.location.search, /switch=1/);
        assert.match(tab.ctx.window.location.search, /returnTo=%2Fdemocracy%3Fref%3D4/);
        const bob = tab.accountButtons().find(b => same(b.getAttribute('data-address'), B));
        bob.click();
        await settle();
        assert.equal(tab.read('pdex_wallet_address'), B);
        assert.equal(tab.ctx.window.location.pathname, '/democracy');
        assert.equal(tab.ctx.window.location.search, '?ref=4');
    });

    test('a switch started on /wallet/<old> goes to the new dashboard, not back to the old one', async () => {
        const profile = makeProfile({ extensions: [fakeExtension('polkadot-js', [acct42(21, 'Alice'), acct42(22, 'Bob')])] });
        profile.local.setItem('pdex_wallet_address', A);
        const tab = openTab(profile, { path: '/wallet/' + A });
        tab.fn('openWalletPicker')();
        await settle();
        assert.ok(!/returnTo/.test(tab.ctx.window.location.search));
        tab.accountButtons().find(b => same(b.getAttribute('data-address'), B)).click();
        await settle();
        assert.equal(tab.ctx.window.location.pathname, '/wallet/' + B);
    });

    for (const [label, evil] of [['an absolute URL', 'https://evil.example/steal'], ['a protocol-relative URL', '//evil.example/steal'], ['a backslash spelling', '/\\evil.example'], ['a javascript: URL', 'javascript:alert(1)']]) {
        test(`returnTo is ignored when it is ${label}`, async () => {
            const profile = makeProfile({ extensions: [fakeExtension('polkadot-js', [acct42(21, 'Alice'), acct42(22, 'Bob')])] });
            profile.local.setItem('pdex_wallet_address', A);
            const tab = openTab(profile, { path: '/wallet', search: '?switch=1&returnTo=' + encodeURIComponent(evil) });
            await tab.visit('/wallet?switch=1&returnTo=' + encodeURIComponent(evil));
            tab.accountButtons().find(b => same(b.getAttribute('data-address'), B)).click();
            await settle();
            assert.equal(tab.ctx.window.location.pathname, '/wallet/' + B, 'left the site, or went somewhere unexpected');
        });
    }

    test('a same-origin relative returnTo is honoured', async () => {
        const profile = makeProfile({ extensions: [fakeExtension('polkadot-js', [acct42(21, 'Alice'), acct42(22, 'Bob')])] });
        profile.local.setItem('pdex_wallet_address', A);
        const tab = openTab(profile, { path: '/wallet', search: '?switch=1&returnTo=%2Fcouncil' });
        await tab.visit('/wallet?switch=1&returnTo=%2Fcouncil');
        tab.accountButtons().find(b => same(b.getAttribute('data-address'), B)).click();
        await settle();
        assert.equal(tab.ctx.window.location.pathname, '/council');
    });

    test('Disconnect from the picker lands on the first-connect state, with focus on the title', async () => {
        const profile = makeProfile({ extensions: [fakeExtension('polkadot-js', [acct42(21, 'Alice'), acct42(22, 'Bob')])] });
        profile.local.setItem('pdex_wallet_address', A);
        profile.local.setItem('pdex_wallet_source', 'polkadot-js');
        const tab = openTab(profile, { path: '/wallet', search: '?switch=1' });
        await tab.visit('/wallet?switch=1');
        assert.equal(tab.root.querySelector('#wallet-picker-title').textContent.trim(), 'Switch wallet');
        tab.root.querySelector('#wallet-picker-disconnect').click();
        await settle();
        assert.equal(tab.read('pdex_wallet_address'), null);
        const title = tab.root.querySelector('#wallet-picker-title');
        assert.equal(title.textContent.trim(), 'Connect wallet');
        assert.equal(tab.root.ownerDocument.activeElement, title);
        assert.equal(tab.root.querySelector('[aria-current]'), null);
    });

    test('script.js renders the page through lib/wallet-picker-view.js and stays under its ceiling', () => {
        assert.match(SCRIPT, /mountWalletPicker\(root, \{/);
        assert.match(SCRIPT, /compact: true/);
        assert.ok(!/buildCurrentBannerHtml|buildMissingAccountHelpHtml|wallet-env-banner/.test(SCRIPT));
        assert.ok(SCRIPT.split('\n').length < 15000);
    });

    test('the dashboard\'s multisig hint links to the open section and uses the control\'s words', () => {
        assert.match(SCRIPT, /href="\/wallet\?switch=1#multisig"[^>]*>Add a multisig wallet</);
        assert.ok(!SCRIPT.includes('Add an existing multisig'));
    });
});

describe('help text matches the words on screen', () => {
    test('connecting-wallet no longer quotes the Detected banner or a Connect button; multisig topics say "Add a multisig wallet"', async () => {
        const { HELP_TOPICS } = await import('../lib/help-topics.js');
        const all = HELP_TOPICS.map(t => t.body).join('\n');
        assert.ok(!all.includes('Detected Polkadot.js'));
        assert.ok(!all.includes('Add an existing multisig'));
        assert.ok(!/<b>Open wallet<\/b>/.test(all));
        const conn = HELP_TOPICS.find(t => t.slug === 'connecting-wallet').body;
        assert.match(conn, /View any address/);
        const sw = HELP_TOPICS.find(t => t.slug === 'switching-wallets').body;
        for (const p of ['Current', "Don't see your account?", 'Refresh accounts', 'Disconnect']) assert.ok(sw.includes(p), p);
        assert.match(all, /Add a multisig wallet/);
        const doc = readFileSync(new URL('../docs/multisig-wallets.md', import.meta.url), 'utf8');
        assert.ok(!doc.includes('Add an existing multisig'));
        assert.match(doc, /Check again/, 'the doc describes the Switch wallet form of the section');
    });

    test('no em or en dashes in the new modules', () => {
        for (const f of ['../lib/wallet-picker.js', '../lib/wallet-picker-view.js', '../lib/help-popover.js']) {
            const src = readFileSync(new URL(f, import.meta.url), 'utf8');
            assert.ok(!/[–—]/.test(src), f);
        }
    });
});
