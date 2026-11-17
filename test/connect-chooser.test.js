// The Connect wallet chooser (spec: cto-team/plans/2026-11-16-connect-wallet-redesign.md,
// reconciled with 2026-11-11-switch-wallet-redesign.md for the switch view).
//
// The page used to ask "which account?" before the user had said "which
// wallet?", so it enabled every extension at load, and a dismissed popup
// filled the page with a recovery wall. Now the first screen is a short list
// of ways to connect, nothing is asked until a row is clicked, accounts are the
// second step, and a problem is one line under the row that caused it.
//
// The page runs in happy-dom with fake extensions that count enable() calls,
// through the real registry (helpers/chooser-world.js).
//
// Addresses are synthetic (32 bytes of one repeated value). They belong to no one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountChooser, fakeWallet, acct, addr, short, tick } from './helpers/chooser-world.js';
import { mountPairingPanel } from '../lib/walletconnect-view.js';
import { buildGetWalletHtml, STILL_MISSING, ALLOW_LINE, FORMAT_LINE } from '../lib/wallet-onboarding.js';
import * as onboarding from '../lib/wallet-onboarding.js';
import * as picker from '../lib/wallet-picker.js';
import { DESKTOP_EXTENSIONS, CREATE_WALLET_URL } from '../lib/wallet-links.js';
import { HELP_TOPICS } from '../lib/help-topics.js';

const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const A = addr(21), B = addr(22), M = addr(29);
const twoWallets = () => [fakeWallet('polkadot-js', [acct(21, 'Polkadex Democracy Wallet'), acct(22, 'Treasury Ops')]), fakeWallet('talisman', [acct(23, 'Cold storage'), acct(24, 'Hot wallet')])];
const sub = (w) => w.q('#wallet-picker-sub').textContent.trim();
const title = (w) => w.q('#wallet-picker-title').textContent.trim();
const problem = (w, key) => { const li = w.row(key).closest('li'); const p = li.querySelector('.wallet-option-problem'); return p ? p.textContent.replace(/\s+/g, ' ').trim() : ''; };

// ─── b1. first visit, extensions installed ──────────────────────────────────

describe('first visit (options view): nothing is asked', () => {
    test('two extensions and the phone row: zero enable calls, title, one line, one row per way, More options, one footnote', async (t) => {
        const w = mountChooser(t, { wallets: twoWallets(), phone: true });
        await w.picker.ready;
        assert.equal(w.totalEnables(), 0, 'a wallet was asked before any click');
        assert.equal(title(w), 'Connect wallet');
        assert.equal(sub(w), 'Choose how to connect.');
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'options');
        assert.deepEqual(w.optionNames(), ['Polkadot.js', 'Talisman', 'Phone wallet', 'No wallet? Get one']);
        assert.match(w.action('phone').textContent, /Scan a code with Nova Wallet or SubWallet\./);
        for (const k of ['polkadot-js', 'talisman']) {
            const r = w.row(k);
            assert.equal(r.tagName, 'BUTTON');
            assert.equal(r.getAttribute('aria-label'), `Connect with ${k === 'talisman' ? 'Talisman' : 'Polkadot.js'}`);
            assert.equal(r.querySelector('.wallet-option-action').textContent.trim(), 'Connect', '"Connect" is visible text inside the button');
            assert.ok(r.querySelector('.wallet-ext-tile.is-lg'), 'a large tile');
        }
        assert.ok(!w.action('get').querySelector('.wallet-option-action'), 'the Get row has no "Connect"');
        assert.ok(w.action('get').classList.contains('is-quiet'));
        const more = w.q('#wallet-picker-more');
        assert.equal(more.tagName, 'DETAILS');
        assert.equal(more.open, false);
        assert.equal(more.querySelector('summary').textContent.trim(), 'More options');
        assert.ok(more.querySelector('#wallet-multisig-accounts') && more.querySelector('#wallet-picker-view'));
        assert.ok(w.visible(w.q('#wallet-picker-footnote')));
        assert.match(w.q('#wallet-picker-footnote').textContent, /Polkadex Explorer never moves funds on its own\. Every transaction needs your approval in your wallet\./);
        assert.equal(w.visible(w.q('#wallet-picker-back')), false, 'no Back on the root view');
    });

    test('the removed elements are gone: no account label or refresh before a wallet is chosen, no wall, no footer line', async (t) => {
        const w = mountChooser(t, { wallets: twoWallets(), phone: true });
        await w.picker.ready;
        const html = w.root.innerHTML;
        for (const gone of ['Your accounts', 'wallet-picker-count-label', 'bx-lock-alt', 'did not share any accounts', 'Press Refresh', 'I installed it',
            'wallet-create-line', 'wallet-onboarding-wc', 'Connect with your phone (WalletConnect)', 'Looking for wallets...', 'wallet-skel-account', ALLOW_LINE, 'format 88']) {
            assert.ok(!html.includes(gone), gone + ' is still on the page');
        }
        assert.equal(w.visible(w.q('#wallet-picker-refresh')), false, 'no refresh icon on the options view');
        assert.equal(w.visible(w.q('#wallet-picker-missing')), false);
        assert.equal(w.qa('.wallet-picker-footnote').length, 1);
    });

    test('fixed order: Polkadot.js, Talisman, SubWallet, PolkaGate, Nova, Fearless, then unknown keys by name', async (t) => {
        const keys = ['zeta-wallet', 'fearless-wallet', 'talisman', 'nova', 'polkagate', 'subwallet-js', 'polkadot-js', 'alpha-wallet'];
        const w = mountChooser(t, { wallets: keys.map(k => fakeWallet(k, [acct(30, 'x')])) });
        await w.picker.ready;
        assert.deepEqual(w.optionNames(), ['Polkadot.js', 'Talisman', 'SubWallet', 'PolkaGate', 'Nova Wallet', 'Fearless Wallet', 'alpha-wallet', 'zeta-wallet', 'No wallet? Get one']);
        assert.equal(w.totalEnables(), 0);
    });

    test('the phone row is there only when WalletConnect is on', async (t) => {
        const off = mountChooser(t, { wallets: twoWallets() });
        await off.picker.ready;
        assert.equal(off.action('phone'), null);
        assert.ok(!/Phone wallet|WalletConnect/.test(off.text()));
        const on = mountChooser(t, { wallets: twoWallets(), phone: true });
        await on.picker.ready;
        assert.ok(on.action('phone'));
    });
});

// ─── b2, b3. click, wait, accounts ──────────────────────────────────────────

describe('clicking a row asks that wallet only', () => {
    test('Talisman: exactly one enable, to Talisman; then its accounts, focus on the first, the count announced, nothing selected', async (t) => {
        const w = mountChooser(t, { wallets: [fakeWallet('polkadot-js', [acct(21, 'A')]), fakeWallet('talisman', [acct(23, 'Cold storage')])] });
        await w.picker.ready;
        w.row('talisman').click();
        await w.settle();
        assert.deepEqual(w.enables(), { 'polkadot-js': 0, talisman: 1 });
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'accounts');
        assert.equal(sub(w), 'Choose an account to open your dashboard.');
        assert.ok(w.visible(w.q('#wallet-picker-back')));
        assert.equal(w.q('#wallet-picker-back').textContent.trim(), 'Back');
        const rows = w.qa('#wallet-accounts .wallet-account-btn');
        assert.equal(rows.length, 1);
        assert.equal(w.doc.activeElement, rows[0], 'focus moves to the first account');
        assert.equal(w.q('#wallet-picker-live').textContent.trim(), '1 account found in Talisman.');
        assert.deepEqual(w.calls.select, [], 'no auto-select, even with one account');
        assert.match(w.q('.wallet-group-head').textContent, /Talisman/);
        assert.ok(w.q('.wallet-group-head #wallet-picker-refresh'), 'refresh sits on the wallet\'s head');
        assert.equal(w.visible(w.q('#wallet-picker-more')), false, 'one question per screen: no More options here');
        assert.ok(w.visible(w.q('#wallet-picker-missing')));
        assert.ok(w.visible(w.q('#wallet-picker-footnote')));
        rows[0].click();
        assert.deepEqual(w.calls.select, [[addr(23), 'talisman']]);
    });

    test('Back returns to the options and to the row the user came from, which now reads its account count; no second request', async (t) => {
        const w = mountChooser(t, { wallets: twoWallets() });
        await w.picker.ready;
        w.row('talisman').click();
        await w.settle();
        w.q('#wallet-picker-back').click();
        await w.settle();
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'options');
        assert.equal(w.doc.activeElement, w.row('talisman'));
        assert.equal(w.row('talisman').querySelector('.wallet-option-action').textContent.trim(), '2 accounts');
        assert.equal(w.row('polkadot-js').querySelector('.wallet-option-action').textContent.trim(), 'Connect');
        w.row('talisman').click();
        await w.settle();
        assert.equal(w.enables().talisman, 1, 'a wallet already connected this visit was asked again');
        assert.equal(w.qa('#wallet-accounts .wallet-account-btn').length, 2);
    });

    test('waiting: the row is busy and says where to look, then after 3 s the longer hint; other rows stay usable', async (t) => {
        const pj = fakeWallet('polkadot-js', [acct(21, 'A')], { hold: true });
        const w = mountChooser(t, { wallets: [pj, fakeWallet('talisman', [acct(23, 'T')])], slowMs: 20 });
        await w.picker.ready;
        w.row('polkadot-js').click();
        await tick(0);
        const r = w.row('polkadot-js');
        assert.equal(r.getAttribute('aria-busy'), 'true');
        assert.match(r.textContent, /Approve the request in Polkadot\.js\./);
        assert.equal(w.q('#wallet-picker-live').textContent.trim(), 'Asking Polkadot.js...');
        const cancel = r.closest('li').querySelector('.wallet-option-cancel');
        assert.equal(cancel.textContent.trim(), 'Cancel');
        assert.notEqual(cancel.parentElement, r, 'Cancel is not nested inside the row button');
        await tick(40);
        assert.match(w.row('polkadot-js').textContent, /Still waiting\. Look for a Polkadot\.js popup, or open the extension\./);
        assert.equal(w.row('talisman').disabled, false);
        pj.release();
        await w.settle();
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'accounts');
    });

    test('Cancel resets the row and a late answer does not navigate', async (t) => {
        const pj = fakeWallet('polkadot-js', [acct(21, 'A')], { hold: true });
        const w = mountChooser(t, { wallets: [pj] });
        await w.picker.ready;
        w.row('polkadot-js').click();
        await tick(0);
        w.row('polkadot-js').closest('li').querySelector('.wallet-option-cancel').click();
        assert.notEqual(w.row('polkadot-js').getAttribute('aria-busy'), 'true');
        assert.equal(w.doc.activeElement, w.row('polkadot-js'));
        pj.release();
        await w.settle();
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'options', 'a late answer after Cancel navigated');
        assert.equal(w.row('polkadot-js').querySelector('.wallet-option-action').textContent.trim(), 'Connect');
    });
});

// ─── b4. refused or zero accounts ───────────────────────────────────────────

describe('a problem is one line and one action, under the row that caused it', () => {
    test('refused: its own line, one Try again right after the row, announced, focus stays on the row', async (t) => {
        const pj = fakeWallet('polkadot-js', [acct(21, 'A')], { reject: true });
        const w = mountChooser(t, { wallets: [pj, fakeWallet('talisman', [acct(23, 'T')])] });
        await w.picker.ready;
        w.row('polkadot-js').click();
        await w.settle();
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'options');
        assert.equal(problem(w, 'polkadot-js'), 'Polkadot.js did not allow this site. Allow Polkadex Explorer in the extension. Try again');
        assert.equal(w.qa('.wallet-option-retry').length, 1);
        assert.equal(w.q('#wallet-picker-live').textContent.trim(), 'Polkadot.js did not allow this site. Allow Polkadex Explorer in the extension.');
        assert.equal(w.doc.activeElement, w.row('polkadot-js'));
        assert.ok(w.row('talisman'), 'the other ways to connect are still there');
        const order = w.qa('button').filter(w.visible);
        assert.equal(order.indexOf(w.q('.wallet-option-retry')), order.indexOf(w.row('polkadot-js')) + 1, 'Try again comes right after its row');
        for (const gone of ['bx-lock-alt', '<h3', '<ol']) assert.ok(!w.q('#wallet-picker-options').innerHTML.includes(gone), gone);
        pj.reject = false;
        w.q('.wallet-option-retry').click();
        await w.settle();
        assert.deepEqual(w.enables(), { 'polkadot-js': 2, talisman: 0 }, 'Try again asks that wallet only');
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'accounts');
    });

    test('zero accounts: its own line; once an account is allowed, Try again lists it', async (t) => {
        const pj = fakeWallet('polkadot-js', []);
        const w = mountChooser(t, { wallets: [pj] });
        await w.picker.ready;
        w.row('polkadot-js').click();
        await w.settle();
        assert.equal(problem(w, 'polkadot-js'), 'Polkadot.js shared no accounts. Allow one in the extension. Try again');
        pj.accounts.push(acct(21, 'Alice'));
        w.q('.wallet-option-retry').click();
        await w.settle();
        assert.equal(w.qa('#wallet-accounts .wallet-account-btn').length, 1);
    });

    test('a new click on any row clears the other problem lines', async (t) => {
        const w = mountChooser(t, { wallets: [fakeWallet('polkadot-js', [], { reject: true }), fakeWallet('talisman', [])] });
        await w.picker.ready;
        w.row('polkadot-js').click();
        await w.settle();
        assert.ok(problem(w, 'polkadot-js'));
        w.row('talisman').click();
        await w.settle();
        assert.equal(problem(w, 'polkadot-js'), '');
        assert.match(problem(w, 'talisman'), /Talisman shared no accounts/);
        assert.equal(w.qa('.wallet-option-problem').length, 1);
    });

    test('a wallet that disappeared between detection and the click says so', async (t) => {
        const w = mountChooser(t, { wallets: twoWallets() });
        await w.picker.ready;
        delete w.injected.talisman;
        w.row('talisman').click();
        await w.settle();
        assert.match(w.q('.wallet-option-problem').textContent, /Talisman is no longer available in this browser\./);
    });
});

// ─── b5. no extension, desktop; the get view ────────────────────────────────

describe('no extension on a computer', () => {
    test('no phone: "Get a wallet" is the first, primary row; no footnote (nothing to approve); More options stays', async (t) => {
        const w = mountChooser(t, {});
        await w.picker.ready;
        assert.equal(sub(w), 'No wallet found in this browser.');
        assert.deepEqual(w.optionNames(), ['Get a wallet']);
        assert.match(w.action('get').textContent, /Install a browser extension\. Takes two minutes\./);
        assert.ok(w.action('get').classList.contains('is-primary'));
        assert.equal(w.visible(w.q('#wallet-picker-footnote')), false);
        assert.ok(w.visible(w.q('#wallet-picker-more')));
        assert.equal(w.q('#wallet-picker-view').open, false, 'View any address is no longer opened for this state');
    });

    test('with the phone: Get a wallet, then Phone wallet; the footnote is back', async (t) => {
        const w = mountChooser(t, { phone: true });
        await w.picker.ready;
        assert.deepEqual(w.optionNames(), ['Get a wallet', 'Phone wallet']);
        assert.ok(w.visible(w.q('#wallet-picker-footnote')));
    });

    test('the get view: title, Back, lead, three install links that open a new tab, the seed note, Check again, the guides, phone cards collapsed', async (t) => {
        const w = mountChooser(t, {});
        await w.picker.ready;
        w.action('get').click();
        await w.settle();
        assert.equal(title(w), 'Get a wallet');
        assert.equal(sub(w), 'Install one, create an account, then come back.');
        assert.ok(w.visible(w.q('#wallet-picker-back')));
        const links = w.qa('#wallet-picker-get a.wallet-option-row');
        assert.deepEqual(links.map(a => a.getAttribute('href')), DESKTOP_EXTENSIONS.map(e => e.url));
        for (const [i, a] of links.entries()) {
            assert.equal(a.getAttribute('target'), '_blank');
            assert.equal(a.getAttribute('rel'), 'noopener');
            assert.equal(a.getAttribute('aria-label'), `Install ${DESKTOP_EXTENSIONS[i].name}, opens in a new tab`);
            assert.match(a.textContent, new RegExp(DESKTOP_EXTENSIONS[i].blurb.replace(/[.]/g, '\\.')));
            assert.equal(a.querySelector('.wallet-option-action').textContent.trim(), 'Install');
        }
        assert.match(w.q('#wallet-picker-get').textContent, /Write your seed phrase on paper\. Never share it\./);
        assert.equal(w.q('.wallet-get-check').textContent.trim(), 'Check again');
        assert.ok(w.q('#wallet-picker-get a[href="/help/set-up-a-wallet"]'));
        assert.equal(w.q('#wallet-picker-get a[href="/help/set-up-a-wallet"]').textContent.trim(), 'Set up a wallet, step by step');
        assert.ok(w.q(`#wallet-picker-get a[href="${CREATE_WALLET_URL}"]`));
        const phone = w.q('#wallet-mobile-section');
        assert.ok(w.visible(phone));
        assert.equal(phone.open, false);
        assert.equal(phone.querySelector('summary').textContent.trim(), 'Wallet on your phone?');
        assert.equal(w.visible(w.q('#wallet-picker-footnote')), false);
        assert.equal(w.visible(w.q('#wallet-picker-more')), false);
        w.q('#wallet-picker-back').click();
        assert.equal(w.doc.activeElement, w.action('get'));
    });

    test('Check again: nothing found says so and offers Reload page; found goes back to the rows', async (t) => {
        const w = mountChooser(t, {});
        await w.picker.ready;
        w.action('get').click();
        w.q('.wallet-get-check').click();
        await w.settle();
        const note = w.q('.wallet-onboarding-note');
        assert.equal(note.textContent.trim(), STILL_MISSING);
        assert.equal(note.getAttribute('role'), 'status');
        assert.equal(w.doc.activeElement, note);
        w.q('.wallet-onboarding-reload').click();
        assert.equal(w.calls.reloads, 1);
        w.injected['polkadot-js'] = fakeWallet('polkadot-js', [acct(21, 'A')]).provider;
        w.q('.wallet-get-check').click();
        await w.settle();
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'options');
        assert.ok(w.row('polkadot-js'));
    });
});

describe('detection runs again without a reload', () => {
    test('an extension that injects late appears within the retry window at mount', async (t) => {
        const w = mountChooser(t, { detectRetries: 6, detectDelayMs: 5 });
        setTimeout(() => { w.injected.talisman = fakeWallet('talisman', [acct(23, 'T')]).provider; }, 8);
        await w.picker.ready;
        assert.ok(w.row('talisman'));
        assert.equal(sub(w), 'Choose how to connect.');
    });

    test('on focus and on visibilitychange, rows appear and disappear; no wallet is asked', async (t) => {
        const w = mountChooser(t, { wallets: [fakeWallet('polkadot-js', [acct(21, 'A')])] });
        await w.picker.ready;
        const ta = fakeWallet('talisman', [acct(23, 'T')]);
        w.injected.talisman = ta.provider;
        w.window.dispatchEvent(new w.window.Event('focus'));
        await w.settle();
        assert.ok(w.row('talisman'), 'a row for the new extension');
        delete w.injected['polkadot-js'];
        w.doc.dispatchEvent(new w.window.Event('visibilitychange'));
        await w.settle();
        assert.equal(w.row('polkadot-js'), null, 'the removed extension\'s row is gone');
        assert.equal(ta.enableCalls + w.totalEnables(), 0);
    });

    test('in the get view, an extension that appears takes the user back to the rows', async (t) => {
        const w = mountChooser(t, {});
        await w.picker.ready;
        w.action('get').click();
        w.injected.talisman = fakeWallet('talisman', [acct(23, 'T')]).provider;
        w.window.dispatchEvent(new w.window.Event('focus'));
        await w.settle();
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'options');
        assert.ok(w.row('talisman'));
    });
});

// ─── b6. phones ─────────────────────────────────────────────────────────────

describe('on a phone', () => {
    test('a plain phone browser: Wallet app, Open in your wallet app, No wallet? Get one', async (t) => {
        const w = mountChooser(t, { onMobile: true, phone: true });
        await w.picker.ready;
        assert.equal(sub(w), 'Choose how to connect.');
        assert.deepEqual(w.optionNames(), ['Wallet app', 'Open in your wallet app', 'No wallet? Get one']);
        assert.match(w.action('phone').textContent, /Nova Wallet or SubWallet, without leaving this page\./);
        assert.match(w.action('apps').textContent, /Use the browser inside Nova Wallet or SubWallet\./);
        assert.ok(w.q('section.wallet-picker').classList.contains('is-mobile'));
    });

    test('Open in your wallet app: the wallet cards and Copy link, as a view with Back', async (t) => {
        const w = mountChooser(t, { onMobile: true });
        await w.picker.ready;
        w.action('apps').click();
        const phone = w.q('#wallet-mobile-section');
        assert.ok(w.visible(phone));
        assert.equal(phone.open, true);
        assert.match(phone.textContent, /CARDS/);
        assert.equal(w.q('#wallet-copy-btn').textContent.trim(), 'Copy link');
        assert.ok(w.visible(w.q('#wallet-picker-back')));
        w.q('#wallet-picker-back').click();
        assert.equal(w.doc.activeElement, w.action('apps'));
    });

    test('the get view on a phone: the cards (with the store links) open, and the guide link; no extension install rows', async (t) => {
        const w = mountChooser(t, { onMobile: true });
        await w.picker.ready;
        w.action('get').click();
        assert.equal(w.qa('#wallet-picker-get a.wallet-option-row').length, 0);
        assert.equal(w.q('#wallet-mobile-section').open, true);
        assert.ok(w.q('#wallet-picker-get a[href="/help/set-up-a-wallet"]'));
        assert.ok(!/Polkadot\.js/.test(w.q('#wallet-picker-get').textContent), 'a phone cannot install the extension');
    });

    test('inside a wallet\'s in-app browser: the injected wallet is the first row, and Open in your wallet app is hidden', async (t) => {
        const w = mountChooser(t, { onMobile: true, phone: true, wallets: [fakeWallet('nova', [acct(25, 'Nova acct')])] });
        await w.picker.ready;
        assert.deepEqual(w.optionNames(), ['Nova Wallet', 'Wallet app', 'No wallet? Get one']);
        assert.equal(w.action('apps'), null);
    });
});

// ─── b7. phone pairing ──────────────────────────────────────────────────────

describe('phone wallet pairing', () => {
    test('the pairing view: Back, the line, the panel drawn by WalletConnect; Back cancels the pairing', async (t) => {
        const w = mountChooser(t, { wallets: twoWallets(), phone: true });
        await w.picker.ready;
        w.action('phone').click();
        await tick(0);
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'pairing');
        assert.equal(sub(w), 'Scan with your phone.');
        assert.equal(w.phone.connects, 1);
        const panel = w.phone.panels[0];
        assert.ok(w.q('#wallet-picker-pairing').contains(panel));
        assert.ok(panel.hasAttribute('data-back'), 'the panel knows the view supplies Back');
        assert.ok(w.visible(w.q('#wallet-picker-footnote')));
        w.q('#wallet-picker-back').click();
        await w.settle();
        assert.equal(w.phone.cancels, 1, 'Back cancels the pairing');
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'options');
        assert.equal(w.doc.activeElement, w.action('phone'));
    });

    test('approval: the accounts view with a phone group head and End connection; nothing is selected for the user', async (t) => {
        const w = mountChooser(t, { wallets: twoWallets(), phone: true });
        await w.picker.ready;
        w.action('phone').click();
        await tick(0);
        w.phone.approve();
        await w.settle();
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'accounts');
        const head = w.q('.wallet-group-head');
        assert.match(head.textContent, /Phone wallet: Nova Wallet/);
        assert.equal(head.querySelector('.wallet-wc-disconnect').textContent.trim(), 'End connection');
        assert.equal(w.qa('#wallet-accounts .wallet-account-btn').length, 1);
        assert.deepEqual(w.calls.select, []);
        assert.equal(w.totalEnables(), 0, 'pairing the phone asked no extension');
        w.q('#wallet-picker-back').click();
        assert.match(w.action('phone').textContent, /Nova Wallet connected/);
        assert.equal(w.action('phone').querySelector('.wallet-option-action').textContent.trim(), '1 account');
    });

    test('End connection ends the phone session and returns to the options', async (t) => {
        const w = mountChooser(t, { phone: true });
        await w.picker.ready;
        w.action('phone').click();
        await tick(0);
        w.phone.approve();
        await w.settle();
        w.q('.wallet-wc-disconnect').click();
        await w.settle();
        assert.equal(w.phone.disconnects, 1);
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'options');
        assert.match(w.action('phone').textContent, /Scan a code/);
    });

    test('failure: the message in place of the status, with Try again; no Polkadex account has its own line', async (t) => {
        const w = mountChooser(t, { phone: true });
        await w.picker.ready;
        w.action('phone').click();
        await tick(0);
        w.phone.fail('The pairing code expired.');
        await w.settle();
        const panel = w.q('#wallet-picker-pairing');
        assert.match(panel.textContent, /The pairing code expired\./);
        assert.equal(panel.querySelector('[role="alert"]').textContent.trim(), 'The pairing code expired.');
        panel.querySelector('.wallet-wc-retry').click();
        await tick(0);
        assert.equal(w.phone.connects, 2);
        w.phone.fail('Your wallet did not share a Polkadex account. Check that Polkadex is enabled in the wallet, then try again.');
        await w.settle();
        assert.match(w.q('#wallet-picker-pairing').textContent, /This wallet has no Polkadex account\. Add one in the app\./);
        assert.ok(w.q('#wallet-picker-pairing .wallet-wc-retry'));
    });

    test('on a phone the line says to open the wallet app', async (t) => {
        const w = mountChooser(t, { phone: true, onMobile: true });
        await w.picker.ready;
        w.action('phone').click();
        await tick(0);
        assert.equal(sub(w), 'Open your wallet app to connect.');
    });

    test('mountPairingPanel: the three steps, "Waiting for your phone...", and no Cancel of its own when the view has Back', async (t) => {
        const { Window } = await import('happy-dom');
        const win = new Window();
        t.after(() => win.happyDOM.close());
        const el = win.document.createElement('div');
        el.setAttribute('data-back', '');
        let cancelled = 0;
        mountPairingPanel(el, { uri: 'wc:abc@2?relay-protocol=irn&symKey=00', clipboard: { writeText: async () => {} }, onCancel: () => cancelled++ });
        assert.deepEqual(Array.from(el.querySelectorAll('.wc-steps li')).map(li => li.textContent.trim()), ['Open Nova Wallet or SubWallet.', 'Tap scan.', 'Approve.']);
        assert.equal(el.querySelector('.wc-status').textContent.trim(), 'Waiting for your phone...');
        assert.equal(el.querySelector('.wc-status').getAttribute('role'), 'status');
        assert.equal(el.querySelector('.wc-cancel'), null);
        assert.equal(el.querySelector('.wc-qr').getAttribute('role'), 'img');
        assert.equal(el.querySelector('.wc-copy').textContent.trim(), 'Copy link');
        const plain = win.document.createElement('div');
        mountPairingPanel(plain, { uri: 'wc:abc@2?relay-protocol=irn&symKey=00', clipboard: {}, onCancel: () => cancelled++ });
        plain.querySelector('.wc-cancel').click();
        assert.equal(cancelled, 1, 'without a view Back, the panel keeps its own Cancel');
    });
});

// ─── b9. switching ──────────────────────────────────────────────────────────

describe('switching (a wallet is connected)', () => {
    test('the remembered wallet is asked silently and its accounts are the root; Current row, Use a different wallet, the two collapsed lines', async (t) => {
        const w = mountChooser(t, { wallets: twoWallets(), current: A, currentSource: 'polkadot-js', lastSource: 'polkadot-js' });
        await w.picker.ready;
        assert.deepEqual(w.enables(), { 'polkadot-js': 1, talisman: 0 }, 'another wallet was asked');
        assert.equal(title(w), 'Switch wallet');
        assert.equal(sub(w), 'Choose the account you want to use.');
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'accounts');
        assert.equal(w.visible(w.q('#wallet-picker-back')), false);
        const cur = w.q('[aria-current="true"]');
        assert.ok(cur.querySelector('#wallet-picker-disconnect'));
        assert.equal(w.qa('#wallet-accounts .wallet-account-btn').length, 1);
        const diff = w.q('#wallet-picker-different');
        assert.ok(w.visible(diff));
        assert.match(diff.textContent, /Use a different wallet/);
        assert.ok(w.visible(w.q('#wallet-picker-missing')));
        const more = w.q('#wallet-picker-more');
        assert.notEqual(more.tagName, 'DETAILS', 'in switch mode the two lines are not behind More options');
        assert.ok(w.visible(more));
        assert.ok(w.visible(w.q('.wallet-picker-divider')));
        assert.equal(w.q('#wallet-picker-view summary').textContent.trim(), 'View any address');
        assert.equal(w.q('.wallet-create-line'), null);
        assert.equal(w.action('get'), null, 'switch mode with a wallet installed does not offer Get one');
        const order = w.qa('button, summary').filter(w.visible);
        const i = (el) => order.indexOf(el);
        assert.ok(i(w.q('#wallet-picker-refresh')) < i(w.q('#wallet-picker-disconnect')) && i(w.q('#wallet-picker-disconnect')) < i(w.q('.wallet-account-btn'))
            && i(w.q('.wallet-account-btn')) < i(diff) && i(diff) < i(w.q('#wallet-picker-missing summary')));
    });

    test('Use a different wallet: the options with Back, the Current row on top, the connected wallet reads "2 accounts"', async (t) => {
        const w = mountChooser(t, { wallets: twoWallets(), current: A, currentSource: 'polkadot-js', lastSource: 'polkadot-js' });
        await w.picker.ready;
        w.q('#wallet-picker-different').click();
        await w.settle();
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'options');
        assert.equal(sub(w), 'Choose a wallet.');
        assert.ok(w.visible(w.q('#wallet-picker-back')));
        assert.ok(w.q('#wallet-accounts [aria-current="true"] #wallet-picker-disconnect'));
        const html = w.q('.wallet-picker-body').innerHTML;
        assert.ok(html.indexOf('aria-current') < html.indexOf('wallet-option-row'), 'the Current row sits above the rows');
        assert.equal(w.row('polkadot-js').querySelector('.wallet-option-action').textContent.trim(), '2 accounts');
        assert.equal(w.enables().talisman, 0);
        w.q('#wallet-picker-back').click();
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'accounts');
    });

    test('no readable source (typed address): the options are the root, Current row on top, "Choose a wallet.", nothing asked', async (t) => {
        const w = mountChooser(t, { wallets: twoWallets(), current: M, currentSource: '' });
        await w.picker.ready;
        assert.equal(w.totalEnables(), 0);
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'options');
        assert.equal(sub(w), 'Choose a wallet.');
        assert.equal(w.visible(w.q('#wallet-picker-back')), false);
        assert.match(w.q('#wallet-accounts .wallet-group-head').textContent, /Read-only address/);
        assert.ok(w.q('#wallet-accounts [aria-current="true"] #wallet-picker-disconnect'));
    });

    test('a multisig with a remembered signer wallet: that wallet\'s accounts, with the multisig as the Current row first', async (t) => {
        const w = mountChooser(t, { wallets: twoWallets(), current: M, currentSource: 'multisig', lastSource: 'talisman' });
        await w.picker.ready;
        assert.deepEqual(w.enables(), { 'polkadot-js': 0, talisman: 1 });
        const groups = w.qa('#wallet-accounts .wallet-account-group');
        assert.match(groups[0].querySelector('.wallet-group-head').textContent, /Multisig wallet/);
        assert.ok(groups[0].querySelector('[aria-current="true"]'));
        assert.equal(w.qa('#wallet-accounts .wallet-account-btn').length, 2);
    });

    test('a remembered wallet that refuses: the options, with the line under its row', async (t) => {
        const w = mountChooser(t, { wallets: [fakeWallet('polkadot-js', [], { reject: true })], current: A, currentSource: 'polkadot-js', lastSource: 'polkadot-js' });
        await w.picker.ready;
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'options');
        assert.match(problem(w, 'polkadot-js'), /Polkadot\.js did not allow this site\./);
        assert.ok(w.q('[aria-current="true"]'));
    });

    test('Refresh asks the shown wallet again, never another; a wallet that now shares none sends the user back with the line', async (t) => {
        const wallets = twoWallets();
        const w = mountChooser(t, { wallets, current: A, currentSource: 'polkadot-js', lastSource: 'polkadot-js' });
        await w.picker.ready;
        wallets[0].accounts.push(acct(26, 'New one'));
        w.q('#wallet-picker-refresh').click();
        await w.settle();
        assert.deepEqual(w.enables(), { 'polkadot-js': 2, talisman: 0 });
        assert.equal(w.qa('#wallet-accounts .wallet-account-btn').length, 2);
        assert.equal(w.q('#wallet-picker-live').textContent.trim(), '3 accounts found in Polkadot.js.');
        wallets[0].accounts.splice(0);
        w.q('#wallet-picker-refresh').click();
        await w.settle();
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'options');
        assert.match(problem(w, 'polkadot-js'), /Polkadot\.js shared no accounts/);
    });

    test('a paired phone account: the phone group is the root', async (t) => {
        const w = mountChooser(t, { phone: { connected: true }, current: addr(70), currentSource: 'walletconnect', lastSource: 'walletconnect' });
        await w.picker.ready;
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'accounts');
        assert.match(w.q('.wallet-group-head').textContent, /Phone wallet/);
    });
});

// ─── copy, keyboard, screen reader ──────────────────────────────────────────

describe('"Don\'t see your account?" names the wallet', () => {
    test('one sentence with the wallet\'s name, and Refresh accounts; the "different wallet extension" line is gone', async (t) => {
        const w = mountChooser(t, { wallets: twoWallets() });
        await w.picker.ready;
        w.row('talisman').click();
        await w.settle();
        const d = w.q('#wallet-picker-missing');
        assert.equal(d.open, false);
        assert.match(d.textContent, /Your wallet only shows the accounts you allowed for this site\. Allow the account in Talisman, then refresh\./);
        assert.ok(!/different wallet extension/.test(d.textContent));
        d.querySelector('.wallet-picker-refresh-btn').click();
        await w.settle();
        assert.equal(w.enables().talisman, 2);
    });
});

describe('keyboard and screen reader', () => {
    test('rows are native buttons in a list labelled by the line above; tiles and chevrons are hidden', async (t) => {
        const w = mountChooser(t, { wallets: twoWallets(), phone: true });
        await w.picker.ready;
        const ul = w.q('#wallet-picker-options');
        assert.equal(ul.tagName, 'UL');
        assert.equal(ul.getAttribute('role'), 'list');
        assert.equal(ul.getAttribute('aria-labelledby'), 'wallet-picker-sub');
        assert.ok(Array.from(ul.children).every(li => li.tagName === 'LI'));
        assert.ok(w.qa('#wallet-picker-options .wallet-option-row').every(b => b.tagName === 'BUTTON' && b.getAttribute('type') === 'button'));
        assert.ok(w.qa('#wallet-picker-options .wallet-ext-tile, #wallet-picker-options .bx-chevron-right').every(e => e.getAttribute('aria-hidden') === 'true'));
        assert.equal(w.qa('#wallet-picker-options .wallet-option-row button').length, 0, '"Connect" is text, not a second control');
        assert.equal(w.qa('[aria-live="polite"]').length, 1);
    });

    test('tab order: Close, help, Back, rows top to bottom, then the disclosures; nothing steals focus on load', async (t) => {
        const w = mountChooser(t, { wallets: twoWallets() });
        await w.picker.ready;
        assert.ok(w.doc.activeElement === w.doc.body || !w.root.contains(w.doc.activeElement));
        w.row('talisman').click();
        await w.settle();
        w.q('#wallet-picker-back').click();
        const order = w.qa('button, a[href], summary').filter(w.visible);
        const i = (el) => order.indexOf(el);
        assert.ok(i(w.q('.close-control')) < i(w.q('.help-inline-icon')));
        assert.ok(i(w.q('.help-inline-icon')) < i(w.row('polkadot-js')));
        assert.ok(i(w.row('polkadot-js')) < i(w.row('talisman')) && i(w.row('talisman')) < i(w.action('get')) && i(w.action('get')) < i(w.q('#wallet-picker-more summary')));
    });

    test('Escape: clears the search, then goes Back, then closes the page', async (t) => {
        const many = Array.from({ length: 10 }, (_, i) => acct(40 + i, 'Account ' + i));
        const w = mountChooser(t, { wallets: [fakeWallet('polkadot-js', many)] });
        await w.picker.ready;
        w.row('polkadot-js').click();
        await w.settle();
        const search = w.q('#wallet-picker-search');
        assert.ok(w.visible(search), 'search above 8 accounts');
        w.type(search, 'Account 3');
        assert.equal(w.qa('#wallet-accounts .wallet-account-btn').length, 1);
        w.key(search, 'Escape');
        assert.equal(search.value, '');
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'accounts');
        w.key(w.q('.wallet-account-btn'), 'Escape');
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'options', 'the second Escape is Back');
        assert.equal(w.calls.closes, 0);
        w.key(w.row('polkadot-js'), 'Escape');
        assert.equal(w.calls.closes, 1, 'on the root view Escape closes the page');
    });

    test('#multisig opens More options and the multisig section', async (t) => {
        const w = mountChooser(t, { wallets: twoWallets(), hash: '#multisig' });
        await w.picker.ready;
        assert.equal(w.q('#wallet-picker-more').open, true);
        assert.equal(w.calls.multisig[0].open, true);
        assert.equal(w.calls.multisig[0].compact, true);
        const plain = mountChooser(t, { wallets: twoWallets() });
        await plain.picker.ready;
        assert.equal(plain.q('#wallet-picker-more').open, false);
    });

    test('View any address still selects a typed address read only', async (t) => {
        const w = mountChooser(t, { wallets: twoWallets() });
        await w.picker.ready;
        w.q('#wallet-manual-input').value = 'nope';
        w.q('#wallet-manual-btn').click();
        assert.equal(w.q('#wallet-manual-error').textContent, 'That does not look like a valid Polkadex address.');
        w.q('#wallet-manual-input').value = M;
        w.q('#wallet-manual-btn').click();
        assert.deepEqual(w.calls.select, [[M, '']]);
    });
});

// ─── modules, styles, help ──────────────────────────────────────────────────

describe('what was removed from the modules', () => {
    test('the zero-accounts wall, the WalletConnect slot and the old onboarding builder are gone', () => {
        assert.equal(picker.EMPTY_HEADINGS, undefined);
        assert.equal(picker.buildEmptyStateHtml, undefined);
        assert.equal(onboarding.buildWalletConnectSlotHtml, undefined);
        assert.equal(onboarding.buildOnboardingHtml, undefined);
        assert.equal(typeof buildGetWalletHtml, 'function');
        assert.equal(typeof picker.buildOptionRowsHtml, 'function');
        assert.equal(typeof picker.buildOptionProblemHtml, 'function');
        assert.equal(picker.buildOptionProblemHtml('rejected', 'Talisman').includes('Talisman did not allow this site.'), true);
    });

    test('styles: option rows, the problem line, the large tile; the old slot style is gone; the mobile rules', () => {
        for (const sel of ['.wallet-option-row', '.wallet-option-problem', '.wallet-ext-tile.is-lg', '.wallet-picker-back']) assert.ok(CSS.includes(sel), sel);
        assert.ok(!CSS.includes('.wallet-onboarding-wc'));
        const mobile = CSS.slice(CSS.indexOf('/* Switch wallet page: mobile */'));
        assert.match(mobile, /@media \(max-width: 640px\)[\s\S]*\.wallet-option-row/);
        assert.match(mobile, /@media \(max-width: 360px\)[\s\S]*\.wallet-option-action/);
        assert.match(CSS, /\.wallet-option-row\s*\{[^}]*min-height:\s*56px/);
        assert.match(CSS, /\.wallet-ext-tile\.is-lg\s*\{[^}]*width:\s*36px/);
    });

    test('help: the topics quote the new sentences; the allow and format lines live there now', () => {
        const conn = HELP_TOPICS.find(t => t.slug === 'connecting-wallet').body;
        const setup = HELP_TOPICS.find(t => t.slug === 'set-up-a-wallet').body;
        assert.match(conn, /Choose how to connect/);
        assert.match(conn, /Phone wallet/);
        assert.match(conn, /WalletConnect/);
        assert.match(conn, /Use a different wallet/);
        assert.ok(!/asks every wallet extension/.test(conn), 'the topic still says every extension is asked');
        assert.ok(!/I installed it/.test(setup));
        assert.match(setup, /Check again/);
        assert.match(setup, /format 88/);
        assert.match(setup, /Choose <b>Allow<\/b>/);
        assert.ok(SCRIPT.includes('choose how to connect'), 'the HowTo structured data quotes the page');
    });

    test('no em or en dashes in the touched modules', () => {
        for (const f of ['../lib/wallet-sources.js', '../lib/wallet-picker.js', '../lib/wallet-picker-view.js', '../lib/wallet-onboarding.js', '../lib/walletconnect-view.js', './helpers/chooser-world.js']) {
            assert.ok(!/[\u2013\u2014]/.test(readFileSync(new URL(f, import.meta.url), 'utf8')), f);
        }
    });

    test('script.js stays under its 15,000-line ceiling', () => {
        assert.ok(SCRIPT.split('\n').length <= 15000, 'script.js is ' + SCRIPT.split('\n').length + ' lines');
    });
});

describe('Back survives a problem', () => {
    test('switching, Use a different wallet, a refused wallet: Back still returns to the connected wallet\'s accounts', async (t) => {
        const wallets = [fakeWallet('polkadot-js', [acct(21, 'A'), acct(22, 'B')]), fakeWallet('talisman', [], { reject: true })];
        const w = mountChooser(t, { wallets, current: A, currentSource: 'polkadot-js', lastSource: 'polkadot-js' });
        await w.picker.ready;
        w.q('#wallet-picker-different').click();
        w.row('talisman').click();
        await w.settle();
        assert.match(problem(w, 'talisman'), /Talisman did not allow this site/);
        assert.ok(w.visible(w.q('#wallet-picker-back')), 'the problem line took Back away');
        w.q('#wallet-picker-back').click();
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'accounts');
    });

    test('a refresh that finds no accounts returns to the options it came from, without a doubled Back', async (t) => {
        const pj = fakeWallet('polkadot-js', [acct(21, 'A')]);
        const w = mountChooser(t, { wallets: [pj] });
        await w.picker.ready;
        w.row('polkadot-js').click();
        await w.settle();
        pj.accounts.splice(0);
        w.q('#wallet-picker-refresh').click();
        await w.settle();
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'options');
        assert.equal(w.visible(w.q('#wallet-picker-back')), false, 'the options are the root again');
        assert.match(problem(w, 'polkadot-js'), /shared no accounts/);
    });
});
