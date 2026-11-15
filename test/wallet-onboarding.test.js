// First-connect onboarding: a visitor with no wallet extension gets a short path
// to a working wallet. Spec: cto-team/plans/2026-11-14-explorer-native-signing-analysis.md
// (option 1, "onboarding polish").
//
// Layers:
//   1. lib/wallet-links.js        every outside URL in one place, official hosts only
//   2. lib/wallet-onboarding.js   the copy for the "no wallet found" state
//   3. lib/wallet-picker-view.js  the page: "I installed it" re-detects without a reload
//   4. lib/help-topics.js         the "Set up a wallet" article
//
// Addresses are synthetic (32 bytes of one repeated value). They belong to no one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import { escapeHtml } from '../lib/html-escape.js';
import { closeControlHtml } from '../lib/close-control.js';
import { mountWalletPicker } from '../lib/wallet-picker-view.js';
import { buildOnboardingHtml } from '../lib/wallet-onboarding.js';
import * as pickerLib from '../lib/wallet-picker.js';
import {
    DESKTOP_EXTENSIONS, MOBILE_WALLETS, HELP_SLUG, CREATE_WALLET_URL, OFFICIAL_HOSTS, FEATURE_FLAGS, allWalletUrls
} from '../lib/wallet-links.js';
import { HELP_TOPICS } from '../lib/help-topics.js';

const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const same = (a, b) => { try { return Buffer.from(decodeAddress(a)).equals(Buffer.from(decodeAddress(b))); } catch (e) { return false; } };
const valid = (a) => { try { decodeAddress(a); return true; } catch (e) { return false; } };
const short = (a) => String(a).slice(0, 8) + '...' + String(a).slice(-6);

function mount(t, opts = {}) {
    const window = new Window({ url: 'https://explorer.test/wallet', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    t.after(() => window.happyDOM.close());
    const doc = window.document;
    const root = doc.createElement('div');
    doc.body.appendChild(root);
    const calls = { reloadPage: 0, loads: 0, select: [] };
    let list = 'accounts' in opts ? opts.accounts : null;
    const deps = {
        doc, current: '', currentSource: '', onMobile: !!opts.onMobile, hash: '',
        getAccounts: async () => { calls.loads++; return list === null ? null : list.map(a => ({ ...a })); },
        select: (a, s) => calls.select.push([a, s]), disconnect: () => {},
        isSame: same, isValid: valid, esc: escapeHtml, shortAddr: short,
        helpHtml: '', closeHtml: closeControlHtml({ parent: 'home' }),
        mobileCardsHtml: '<div class="mobile-wallet-grid">CARDS</div>', currentUrl: 'https://explorer.test/wallet',
        clipboard: { writeText: async () => {} }, mountMultisig: () => {},
        reloadPage: () => { calls.reloadPage++; }
    };
    if ('walletConnect' in opts) deps.walletConnect = opts.walletConnect;
    const picker = mountWalletPicker(root, deps);
    const q = (s) => root.querySelector(s);
    const qa = (s) => Array.from(root.querySelectorAll(s));
    return { window, root, calls, picker, q, qa, text: () => root.textContent.replace(/\s+/g, ' '), setAccounts: (v) => { list = v; } };
}

const hostOf = (u) => new URL(u).hostname;
const isOfficial = (u) => OFFICIAL_HOSTS.some(h => hostOf(u) === h);

describe('official links: one module, https, official domains only', () => {
    test('every URL is https, has no credentials, and is on an official host', () => {
        const urls = allWalletUrls();
        assert.ok(urls.length >= 8, 'the module lists the extension, store and site links: ' + urls.length);
        for (const u of urls) {
            const p = new URL(u);
            assert.equal(p.protocol, 'https:', u);
            assert.equal(p.username + p.password, '', 'no credentials in ' + u);
            assert.ok(isOfficial(u), 'not an official host: ' + u);
        }
    });

    test('the allowlist itself names only the wallets, the stores and polkadex.ee', () => {
        assert.deepEqual([...OFFICIAL_HOSTS].sort(), [
            'app.novawallet.io', 'apps.apple.com', 'explorer.polkadex.ee', 'novawallet.io', 'play.google.com',
            'polkadex.ee', 'polkadot.js.org', 'subwallet.app', 'talisman.xyz'
        ]);
    });

    test('the three desktop extensions are polkadot.js, Talisman and SubWallet, each with one short line', () => {
        assert.deepEqual(DESKTOP_EXTENSIONS.map(e => e.id), ['polkadot-js', 'talisman', 'subwallet-js']);
        for (const e of DESKTOP_EXTENSIONS) {
            assert.ok(e.blurb && e.blurb.length <= 70, e.id + ' blurb: ' + e.blurb);
            assert.ok(isOfficial(e.url));
        }
    });

    test('mobile wallets are Nova and SubWallet; a deep link exists only where one is officially documented', () => {
        assert.deepEqual(MOBILE_WALLETS.filter(w => w.id !== 'talisman').map(w => w.id), ['nova', 'subwallet']);
        const nova = MOBILE_WALLETS.find(w => w.id === 'nova');
        const link = nova.deeplink('https://explorer.polkadex.ee/wallet');
        assert.equal(link, 'https://app.novawallet.io/open/dapp?url=' + encodeURIComponent('https://explorer.polkadex.ee/wallet'));
        assert.ok(isOfficial(link));
        const sub = MOBILE_WALLETS.find(w => w.id === 'subwallet');
        assert.equal(sub.deeplink, null, 'no SubWallet scheme is used until it is confirmed in their docs');
        for (const w of MOBILE_WALLETS) assert.ok(!w.deeplink || /^https:/.test(w.deeplink('https://explorer.polkadex.ee/')), w.id + ' deep link is not https');
    });

    test('the old picker exports are the same constants, not copies', () => {
        assert.equal(pickerLib.CREATE_WALLET_URL, CREATE_WALLET_URL);
        assert.equal(pickerLib.POLKADOT_JS_URL, DESKTOP_EXTENSIONS[0].url);
        assert.equal(pickerLib.TALISMAN_URL, DESKTOP_EXTENSIONS[1].url);
        assert.equal(pickerLib.SUBWALLET_URL, DESKTOP_EXTENSIONS[2].url);
    });

    test('script.js carries no wallet download URL of its own', () => {
        assert.ok(!/apps\.apple\.com|play\.google\.com|novawallet\.io|subwallet:\/\//.test(SCRIPT), 'wallet URLs belong in lib/wallet-links.js');
        assert.match(SCRIPT, /from '\.\/lib\/mobile-wallet-cards\.js'/, 'script.js gets its wallet links only through the cards module');
    });
});

describe('no extension, desktop', () => {
    test('says what is missing, lists three official extensions with a line each, and offers "I installed it"', async (t) => {
        const w = mount(t);
        await w.picker.ready;
        const box = w.q('.wallet-picker-empty');
        assert.equal(box.querySelector('h3').textContent.trim(), 'No wallet found in this browser');
        assert.match(box.textContent, /Install a wallet extension, then refresh\./);
        const items = Array.from(box.querySelectorAll('.wallet-onboarding-ext li'));
        assert.equal(items.length, 3);
        const names = items.map(li => li.querySelector('a').textContent.trim());
        assert.deepEqual(names, ['Install Polkadot.js', 'Install Talisman', 'Install SubWallet']);
        items.forEach((li, i) => {
            assert.equal(li.querySelector('a').getAttribute('href'), DESKTOP_EXTENSIONS[i].url);
            assert.ok(li.textContent.includes(DESKTOP_EXTENSIONS[i].blurb));
        });
        assert.equal(box.querySelector('.wallet-onboarding-installed').textContent.trim(), 'I installed it');
        assert.equal(w.q('#wallet-picker-view').open, true, 'View any address stays open');
    });

    test('explains the allow step and the Polkadex address format in plain words', async (t) => {
        const w = mount(t);
        await w.picker.ready;
        const t1 = w.q('.wallet-picker-empty').textContent.replace(/\s+/g, ' ');
        assert.match(t1, /Your wallet will ask whether Polkadex Explorer may see your accounts\. Choose Allow\./);
        assert.match(t1, /Polkadex addresses use format 88 and start with "e"\./);
    });

    test('links to the "Set up a wallet" help article and the create-a-wallet guide', async (t) => {
        const w = mount(t);
        await w.picker.ready;
        const help = w.q('.wallet-picker-empty a[href="/help/' + HELP_SLUG + '"]');
        assert.ok(help, 'help article link');
        assert.match(help.textContent, /Set up a wallet/);
        assert.ok(w.q('.wallet-create-line a[href="' + CREATE_WALLET_URL + '"]'));
    });

    test('external links open in a new tab without handing over the opener', async (t) => {
        const w = mount(t);
        await w.picker.ready;
        for (const a of w.qa('.wallet-picker-empty a[href^="https:"]')) {
            assert.equal(a.getAttribute('target'), '_blank');
            assert.match(a.getAttribute('rel'), /noopener/);
        }
    });
});

describe('no extension, phone', () => {
    test('recommends Nova or SubWallet and says to open the explorer in the wallet\'s browser', async (t) => {
        const w = mount(t, { onMobile: true });
        await w.picker.ready;
        const box = w.q('.wallet-picker-empty');
        const text = box.textContent.replace(/\s+/g, ' ');
        assert.match(text, /Phone browsers cannot use wallet extensions\. Open this page inside your wallet app instead\./);
        assert.match(text, /Nova Wallet/);
        assert.match(text, /SubWallet/);
        assert.match(text, /built-in browser/);
        assert.match(text, /explorer\.polkadex\.ee/);
        assert.match(text, /Choose Allow/);
        assert.equal(box.querySelectorAll('.wallet-onboarding-ext').length, 0, 'no desktop extension list on a phone');
        assert.ok(!/Polkadot\.js/.test(text), 'a phone cannot install the polkadot.js extension');
        assert.ok(box.querySelector('a[href="/help/' + HELP_SLUG + '"]'));
    });

    test('the wallet cards and Copy link stay available, open', async (t) => {
        const w = mount(t, { onMobile: true });
        await w.picker.ready;
        assert.equal(w.q('#wallet-mobile-section').open, true);
        assert.match(w.q('#wallet-mobile-section').textContent, /CARDS/);
        assert.ok(w.q('#wallet-copy-btn'));
    });
});

describe('"I installed it" re-detects without a reload', () => {
    test('when the extension is now there, the accounts replace the onboarding', async (t) => {
        const w = mount(t);
        await w.picker.ready;
        assert.equal(w.calls.loads, 1);
        w.setAccounts([{ address: addr(31), name: 'Alice', source: 'talisman' }]);
        w.q('.wallet-onboarding-installed').click();
        await w.picker.idle();
        assert.equal(w.calls.loads, 2);
        assert.equal(w.calls.reloadPage, 0, 'no page reload');
        assert.equal(w.q('.wallet-picker-empty'), null);
        assert.equal(w.qa('.wallet-account-btn').length, 1);
    });

    test('when it is still not there, says so, and offers a page reload (new extensions often need one)', async (t) => {
        const w = mount(t);
        await w.picker.ready;
        assert.equal(w.q('.wallet-onboarding-note'), null, 'no scolding before the first try');
        w.q('.wallet-onboarding-installed').click();
        await w.picker.idle();
        const note = w.q('.wallet-onboarding-note');
        assert.ok(note, 'a note appears');
        assert.equal(note.getAttribute('role'), 'status');
        assert.match(note.textContent, /Still no wallet found\. Some browsers only load a new extension after the page reloads\./);
        const reload = w.q('.wallet-onboarding-reload');
        assert.equal(reload.textContent.trim(), 'Reload page');
        reload.click();
        assert.equal(w.calls.reloadPage, 1);
    });
});

describe('Connect with your phone (WalletConnect) slot', () => {
    test('the flag is off by default and the slot is not in the page', async (t) => {
        assert.equal(FEATURE_FLAGS.walletConnect, false);
        for (const onMobile of [false, true]) {
            const w = mount(t, { onMobile });
            await w.picker.ready;
            assert.equal(w.q('[data-slot="walletconnect"]'), null);
            assert.ok(!/WalletConnect/i.test(w.text()), 'no mention while hidden');
        }
    });

    test('with the flag on, a clearly marked disabled button appears; it does nothing', async (t) => {
        const w = mount(t, { walletConnect: true });
        await w.picker.ready;
        const slot = w.q('[data-slot="walletconnect"]');
        assert.ok(slot);
        const btn = slot.querySelector('button');
        assert.equal(btn.textContent.trim(), 'Connect with your phone (WalletConnect)');
        assert.equal(btn.disabled, true);
        assert.equal(btn.getAttribute('aria-disabled'), 'true');
        assert.match(slot.textContent, /Coming soon/);
        btn.click();
        assert.equal(w.calls.select.length, 0);
    });

    test('the onboarding builder honours the same flag', () => {
        assert.ok(!/walletconnect/i.test(buildOnboardingHtml({ onMobile: false, esc: escapeHtml })));
        assert.match(buildOnboardingHtml({ onMobile: false, walletConnect: true, esc: escapeHtml }), /data-slot="walletconnect"/);
    });

    test('no WalletConnect code is shipped yet', () => {
        assert.ok(!/@walletconnect|@reown|relay\.walletconnect/i.test(SCRIPT));
        assert.ok(!/@walletconnect|@reown/i.test(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));
    });
});

describe('accessibility', () => {
    for (const onMobile of [false, true]) {
        test(`${onMobile ? 'phone' : 'desktop'}: headings nest without skipping a level, links and buttons have names`, async (t) => {
            const w = mount(t, { onMobile, walletConnect: true });
            await w.picker.ready;
            const levels = w.qa('h1,h2,h3,h4,h5,h6').map(h => Number(h.tagName[1]));
            for (let i = 1; i < levels.length; i++) assert.ok(levels[i] - levels[i - 1] <= 1, 'heading jump in ' + levels.join(','));
            const empty = w.q('.wallet-picker-empty');
            assert.equal(empty.querySelectorAll('h3').length, 1, 'one title for the state');
            const links = Array.from(empty.querySelectorAll('a'));
            const names = links.map(a => (a.getAttribute('aria-label') || a.textContent).trim());
            names.forEach(n => assert.ok(n.length > 3, 'link name too short: "' + n + '"'));
            names.forEach(n => assert.ok(!/^(click here|here|link|more)$/i.test(n), n));
            assert.equal(new Set(names).size, names.length, 'link names are unique: ' + names.join(' | '));
            for (const b of empty.querySelectorAll('button')) assert.ok((b.getAttribute('aria-label') || b.textContent).trim().length > 0);
        });
    }

    test('the extension list and the steps are real lists; decorative icons are hidden from screen readers', async (t) => {
        const w = mount(t);
        await w.picker.ready;
        assert.ok(w.q('.wallet-picker-empty ul.wallet-onboarding-ext'));
        assert.ok(w.q('.wallet-picker-empty ol.wallet-onboarding-steps'));
        for (const i of w.qa('.wallet-picker-empty i')) assert.equal(i.getAttribute('aria-hidden'), 'true');
    });

    test('the not-found note is announced politely, not as an alert', async (t) => {
        const w = mount(t);
        await w.picker.ready;
        w.q('.wallet-onboarding-installed').click();
        await w.picker.idle();
        assert.equal(w.q('.wallet-onboarding-note').getAttribute('role'), 'status');
    });
});

describe('copy and help', () => {
    test('no em or en dashes in the onboarding copy, the links module or the help article', () => {
        const html = [false, true].map(m => buildOnboardingHtml({ onMobile: m, walletConnect: true, retried: true, esc: escapeHtml })).join('');
        const article = HELP_TOPICS.find(t => t.slug === HELP_SLUG);
        assert.ok(article, 'help article exists');
        const links = readFileSync(new URL('../lib/wallet-links.js', import.meta.url), 'utf8') + readFileSync(new URL('../lib/wallet-onboarding.js', import.meta.url), 'utf8');
        for (const s of [html, article.body, article.title, article.keywords, links]) assert.ok(!/[–—]|&mdash;|&ndash;/.test(s));
    });

    test('the "Set up a wallet" article is in Getting started and covers install, allow, the address format and phones', () => {
        const a = HELP_TOPICS.find(t => t.slug === HELP_SLUG);
        assert.equal(a.title, 'Set up a wallet');
        assert.equal(a.category, 'start');
        for (const re of [/Polkadot\.js/, /Talisman/, /SubWallet/, /Nova/, /Allow/, /format 88/, /built-in browser/, /seed phrase/i]) assert.match(a.body, re);
        for (const m of a.body.matchAll(/href="(https:[^"]+)"/g)) assert.ok(isOfficial(m[1]), 'unofficial link in help: ' + m[1]);
        for (const m of a.body.matchAll(/href="\/help\/([a-z0-9-]+)"/g)) assert.ok(HELP_TOPICS.some(t => t.slug === m[1]), 'dead help link ' + m[1]);
    });
});

describe('script.js stays small', () => {
    test('under its 15,000-line ceiling', () => {
        assert.ok(SCRIPT.split('\n').length <= 15000, 'script.js lines: ' + SCRIPT.split('\n').length);
    });
});
