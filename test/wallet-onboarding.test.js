// First-connect onboarding: a visitor with no wallet extension gets a short path
// to a working wallet. Spec: cto-team/plans/2026-11-14-explorer-native-signing-analysis.md
// (option 1, "onboarding polish"); moved into the chooser's "Get a wallet" view
// by 2026-11-16-connect-wallet-redesign.md (b5, b6).
//
// Layers:
//   1. lib/wallet-links.js        every outside URL in one place, official hosts only
//   2. lib/wallet-onboarding.js   the copy for the "Get a wallet" view
//   3. lib/wallet-picker-view.js  the page: "Check again" re-detects without a reload
//   4. lib/help-topics.js         the "Set up a wallet" article
//
// Addresses are synthetic (32 bytes of one repeated value). They belong to no one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGetWalletHtml } from '../lib/wallet-onboarding.js';
import * as pickerLib from '../lib/wallet-picker.js';
import {
    DESKTOP_EXTENSIONS, MOBILE_WALLETS, HELP_SLUG, CREATE_WALLET_URL, OFFICIAL_HOSTS, FEATURE_FLAGS, allWalletUrls
} from '../lib/wallet-links.js';
import { HELP_TOPICS } from '../lib/help-topics.js';
import { mountChooser, fakeWallet, acct } from './helpers/chooser-world.js';

const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');

// The page with no extension installed, opened on the "Get a wallet" view.
async function getView(t, opts = {}) {
    const w = mountChooser(t, opts);
    await w.picker.ready;
    w.action('get').click();
    await w.settle();
    return w;
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

describe('no extension, desktop: the Get a wallet view', () => {
    test('three official extensions with a line each, each opening a new tab, and "Check again"', async (t) => {
        const w = await getView(t);
        const rows = w.qa('#wallet-picker-get a.wallet-option-row');
        assert.equal(rows.length, 3);
        assert.deepEqual(rows.map(a => a.querySelector('.wallet-option-name').textContent.trim()), ['Polkadot.js', 'Talisman', 'SubWallet']);
        rows.forEach((a, i) => {
            assert.equal(a.getAttribute('href'), DESKTOP_EXTENSIONS[i].url);
            assert.ok(a.textContent.includes(DESKTOP_EXTENSIONS[i].blurb));
            assert.equal(a.getAttribute('target'), '_blank');
            assert.match(a.getAttribute('rel'), /noopener/);
        });
        assert.equal(w.q('.wallet-get-check').textContent.trim(), 'Check again');
        assert.equal(w.q('#wallet-picker-view').open, false, 'View any address is no longer forced open');
    });

    test('the allow step and the address format moved to the help topic; the page keeps one seed line', async (t) => {
        const w = await getView(t);
        const text = w.q('#wallet-picker-get').textContent.replace(/\s+/g, ' ');
        assert.ok(!/Choose Allow/.test(text));
        assert.ok(!/format 88/.test(text));
        assert.match(text, /Write your seed phrase on paper\. Never share it\./);
    });

    test('links to the "Set up a wallet" help article and the create-a-wallet guide', async (t) => {
        const w = await getView(t);
        const help = w.q('#wallet-picker-get a[href="/help/' + HELP_SLUG + '"]');
        assert.ok(help, 'help article link');
        assert.match(help.textContent, /Set up a wallet/);
        const create = w.q('#wallet-picker-get a[href="' + CREATE_WALLET_URL + '"]');
        assert.ok(create);
        assert.equal(create.getAttribute('target'), '_blank');
    });
});

describe('no extension, phone', () => {
    test('the options say how a phone connects; no extension list, no Polkadot.js', async (t) => {
        const w = mountChooser(t, { onMobile: true });
        await w.picker.ready;
        assert.deepEqual(w.optionNames(), ['Open in your wallet app', 'No wallet? Get one']);
        const g = await getView(t, { onMobile: true });
        const text = g.q('#wallet-picker-get').textContent;
        assert.equal(g.qa('#wallet-picker-get a.wallet-option-row').length, 0, 'no desktop extension list on a phone');
        assert.ok(!/Polkadot\.js/.test(text), 'a phone cannot install the polkadot.js extension');
        assert.ok(g.q('#wallet-picker-get a[href="/help/' + HELP_SLUG + '"]'));
    });

    test('the wallet cards and Copy link stay available, open', async (t) => {
        const w = await getView(t, { onMobile: true });
        assert.equal(w.q('#wallet-mobile-section').open, true);
        assert.match(w.q('#wallet-mobile-section').textContent, /CARDS/);
        assert.ok(w.q('#wallet-copy-btn'));
    });
});

describe('"Check again" re-detects without a reload', () => {
    test('when the extension is now there, its row replaces the Get a wallet view; no wallet is asked', async (t) => {
        const w = await getView(t);
        const ta = fakeWallet('talisman', [acct(31, 'Alice')]);
        w.injected.talisman = ta.provider;
        w.q('.wallet-get-check').click();
        await w.settle();
        assert.equal(w.calls.reloads, 0, 'no page reload');
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'options');
        assert.ok(w.row('talisman'));
        assert.equal(ta.enableCalls, 0);
    });

    test('when it is still not there, says so, and offers a page reload (new extensions often need one)', async (t) => {
        const w = await getView(t);
        assert.equal(w.q('.wallet-onboarding-note'), null, 'no scolding before the first try');
        w.q('.wallet-get-check').click();
        await w.settle();
        const note = w.q('.wallet-onboarding-note');
        assert.ok(note, 'a note appears');
        assert.equal(note.getAttribute('role'), 'status');
        assert.match(note.textContent, /Still no wallet found\. Some browsers only load a new extension after the page reloads\./);
        const reload = w.q('.wallet-onboarding-reload');
        assert.equal(reload.textContent.trim(), 'Reload page');
        reload.click();
        assert.equal(w.calls.reloads, 1);
    });
});

describe('the phone row (WalletConnect)', () => {
    test('the flag is off by default and nothing mentions WalletConnect', async (t) => {
        assert.equal(FEATURE_FLAGS.walletConnect, false);
        for (const onMobile of [false, true]) {
            const w = mountChooser(t, { onMobile });
            await w.picker.ready;
            assert.equal(w.action('phone'), null);
            assert.ok(!/WalletConnect/i.test(w.text()), 'no mention while hidden');
        }
    });

    test('with the flag on, the phone row starts pairing and selects nothing', async (t) => {
        const w = mountChooser(t, { phone: true });
        await w.picker.ready;
        w.action('phone').click();
        await new Promise(r => setTimeout(r, 5));
        assert.equal(w.phone.connects, 1);
        assert.equal(w.calls.select.length, 0, 'pairing alone selects nothing; the user picks an account');
    });

    test('WalletConnect code never reaches the eager bundle: script.js has no static import of it', () => {
        const statics = [...SCRIPT.matchAll(/^\s*import\s+[^;]*?from\s+'([^']+)'/gms)].map(m => m[1]);
        assert.ok(!statics.some(s => /@walletconnect|@reown|walletconnect-(session|signer|source|view)/.test(s)), statics.filter(s => /walletconnect/.test(s)).join(', '));
        assert.ok(!/@reown/i.test(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));
    });
});

describe('accessibility', () => {
    for (const onMobile of [false, true]) {
        test(`${onMobile ? 'phone' : 'desktop'}: headings nest without skipping a level, links and buttons have names`, async (t) => {
            const w = await getView(t, { onMobile, phone: true });
            const levels = w.qa('h1,h2,h3,h4,h5,h6').filter(w.visible).map(h => Number(h.tagName[1]));
            for (let i = 1; i < levels.length; i++) assert.ok(levels[i] - levels[i - 1] <= 1, 'heading jump in ' + levels.join(','));
            const box = w.q('#wallet-picker-get');
            const names = Array.from(box.querySelectorAll('a')).map(a => (a.getAttribute('aria-label') || a.textContent).trim());
            names.forEach(n => assert.ok(n.length > 3, 'link name too short: "' + n + '"'));
            names.forEach(n => assert.ok(!/^(click here|here|link|more)$/i.test(n), n));
            assert.equal(new Set(names).size, names.length, 'link names are unique: ' + names.join(' | '));
            for (const b of box.querySelectorAll('button')) assert.ok((b.getAttribute('aria-label') || b.textContent).trim().length > 0);
        });
    }

    test('the install rows are a real list; decorative icons are hidden from screen readers', async (t) => {
        const w = await getView(t);
        const ul = w.q('#wallet-picker-get ul');
        assert.equal(ul.getAttribute('role'), 'list');
        for (const i of w.qa('#wallet-picker-get i, #wallet-picker-get .wallet-ext-tile')) assert.equal(i.getAttribute('aria-hidden'), 'true');
    });
});

describe('copy and help', () => {
    test('no em or en dashes in the onboarding copy, the links module or the help article', () => {
        const html = [false, true].map(m => buildGetWalletHtml({ onMobile: m, retried: true })).join('');
        const article = HELP_TOPICS.find(t => t.slug === HELP_SLUG);
        assert.ok(article, 'help article exists');
        const links = readFileSync(new URL('../lib/wallet-links.js', import.meta.url), 'utf8') + readFileSync(new URL('../lib/wallet-onboarding.js', import.meta.url), 'utf8');
        for (const s of [html, article.body, article.title, article.keywords, links]) assert.ok(!/[\u2013\u2014]|&mdash;|&ndash;/.test(s));
    });

    test('the "Set up a wallet" article is in Getting started and covers install, allow, the address format and phones', () => {
        const a = HELP_TOPICS.find(t => t.slug === HELP_SLUG);
        assert.equal(a.title, 'Set up a wallet');
        assert.equal(a.category, 'start');
        for (const re of [/Polkadot\.js/, /Talisman/, /SubWallet/, /Nova/, /Allow/, /format 88/, /built-in browser/, /seed phrase/i, /Check again/]) assert.match(a.body, re);
        for (const m of a.body.matchAll(/href="(https:[^"]+)"/g)) assert.ok(isOfficial(m[1]), 'unofficial link in help: ' + m[1]);
        for (const m of a.body.matchAll(/href="\/help\/([a-z0-9-]+)"/g)) assert.ok(HELP_TOPICS.some(t => t.slug === m[1]), 'dead help link ' + m[1]);
    });
});

describe('script.js stays small', () => {
    test('under its 15,000-line ceiling', () => {
        assert.ok(SCRIPT.split('\n').length <= 15000, 'script.js lines: ' + SCRIPT.split('\n').length);
    });
});
