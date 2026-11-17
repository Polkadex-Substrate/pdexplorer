// The not-connected note on /wallet/<address> (Fable, 16 Nov:
// cto-team/plans/2026-11-16-brand-audit-open-ui.md, section 3, and C21, C24).
//
// /wallet/<address> renders the whole dashboard for any address. With nothing
// connected the slot under the header was empty, the header still offered
// "Switch wallet" and the tab said "My Account". Now:
//   - nothing connected: "Viewing X, read only. No wallet is connected.
//     Connect wallet", in the slot the "Viewing X; your wallet is Y. Show mine"
//     banner uses; Switch wallet is hidden; the link opens the chooser and
//     comes back to the same address;
//   - another wallet connected: the banner, not the note;
//   - this wallet connected: neither;
//   - a wallet still restoring: neither (no flash for a returning user).
//
// The lib function is tested directly; the page cases load the REAL
// index.html and script.js in happy-dom (test/helpers/full-page.js).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeAddress } from '@polkadot/util-crypto';
import { notConnectedNoteHtml, viewingBannerHtml } from '../lib/wallet-aware.js';
import { WALLET_KEYS } from '../lib/wallet-session.js';
import { escapeHtml } from '../lib/html-escape.js';
import { readRepo, bodyOf, stripComments } from './helpers/source.js';

const RUNNER = fileURLToPath(new URL('./helpers/full-page.js', import.meta.url));
const SCRIPT = stripComments(readRepo('script.js', import.meta.url));

// Synthetic accounts: 32 bytes of one repeated value. They belong to no one.
const addr = (n, prefix = 88) => encodeAddress(new Uint8Array(32).fill(n), prefix);
const A = addr(51), B = addr(52);
const ext = (n) => addr(n, 42);
const short = (a) => a.substring(0, 8) + '…' + a.substring(a.length - 6);
const remembered = (a, src) => ({ [WALLET_KEYS.address]: a, [WALLET_KEYS.source]: src, [WALLET_KEYS.lastSource]: src, [WALLET_KEYS.lastUsed]: a });
const NOTE = (a) => `Viewing ${short(a)}, read only. No wallet is connected. Connect wallet`;

function page(scenario) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [RUNNER, JSON.stringify(scenario)], { timeout: 60000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
            const line = String(stdout).split('\n').find(l => l.startsWith('RESULT '));
            if (!line) return reject(new Error('the page did not report: ' + (err ? err.message : '') + '\n' + String(stderr).slice(-2000)));
            resolve(JSON.parse(line.slice(7)));
        });
    });
}

describe('notConnectedNoteHtml (lib/wallet-aware.js)', () => {
    const base = { esc: escapeHtml, shortAddr: short };
    test("'' when a wallet is connected, or nothing is viewed", () => {
        assert.equal(notConnectedNoteHtml({ ...base, viewing: A, wallet: B }), '');
        assert.equal(notConnectedNoteHtml({ ...base, viewing: A, wallet: A }), '');
        assert.equal(notConnectedNoteHtml({ ...base, viewing: '', wallet: '' }), '');
    });
    test('the exact copy, the short address with the full one in title, and one link', () => {
        const html = notConnectedNoteHtml({ ...base, viewing: A, wallet: '' });
        const text = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        assert.equal(text, NOTE(A));
        assert.match(html, new RegExp(`<span title="${A}">${short(A).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span>`));
        assert.equal((html.match(/<a /g) || []).length, 1, 'Connect wallet is the only action');
        assert.match(html, /^<div class="wallet-viewing-note is-readonly">/);
        assert.match(html, /<i class='bx bx-show' aria-hidden="true"><\/i>/);
        assert.ok(!/role=/.test(html), 'static at render, not a status update');
    });
    test('the link goes to the chooser with returnTo = this address, encoded, as an SPA link', () => {
        const html = notConnectedNoteHtml({ ...base, viewing: A, wallet: '' });
        const href = html.match(/<a href="([^"]+)"/)[1];
        assert.equal(href, '/wallet?returnTo=' + encodeURIComponent('/wallet/' + encodeURIComponent(A)));
        assert.equal(new URL(href, 'http://x').searchParams.get('returnTo'), '/wallet/' + A);
        assert.match(html, /class="item-link" data-spa-link="true">Connect wallet<\/a>/);
    });
    test('a hostile viewed address is escaped in the text, the title and the link', () => {
        const evil = '"><img src=x onerror=alert(1)>';
        const html = notConnectedNoteHtml({ esc: escapeHtml, shortAddr: (a) => a, viewing: evil, wallet: '' });
        assert.ok(!html.includes('<img'), html);
        assert.ok(html.includes('title="&quot;&gt;&lt;img'), 'title not escaped');
        assert.ok(html.includes('returnTo=%2Fwallet%2F%2522%253E'), 'returnTo not encoded');
    });
    test('it differs from the "Viewing X; your wallet is Y. Show mine" banner as specified', () => {
        const note = notConnectedNoteHtml({ ...base, viewing: A, wallet: '' });
        const banner = viewingBannerHtml({ ...base, viewing: A, wallet: B, isSame: (x, y) => x === y, hrefFor: (a) => '/wallet/' + a });
        assert.match(banner, /bx-info-circle/);
        assert.match(note, /bx-show/);
        assert.match(banner, /Show mine/);
        assert.ok(!note.includes(B) && !note.includes('Show mine'), 'the note names no second address');
        assert.match(banner, /class="wallet-viewing-note"/);
        assert.match(note, /class="wallet-viewing-note is-readonly"/);
    });
    test('the dashboard uses it beside the banner, with wallet: getStoredWallet(), and repaints the slot on every session change', () => {
        assert.match(SCRIPT, /import \{[^}]*\bnotConnectedNoteHtml\b[^}]*\} from '\.\/lib\/wallet-aware\.js'/);
        const slot = bodyOf(SCRIPT, 'walletViewingSlotHtml');
        assert.match(slot, /getActiveAccount\(\)\.status === 'restoring'/);
        assert.match(slot, /const wallet = getStoredWallet\(\)/);
        assert.match(slot, /viewingBannerHtml\(\{[^}]*wallet[^}]*\}\)\s*\|\|\s*notConnectedNoteHtml\(\{[^}]*wallet[^}]*\}\)/);
        assert.match(bodyOf(SCRIPT, 'renderWalletDashboard'), /walletViewingSlotHtml\(data\.address\)/);
        assert.match(SCRIPT, /walletSession\.onActiveAccountChange\(\(\) => paintWalletViewingSlot\(\)\)/);
    });
});

describe('/wallet/<address>, the whole page', () => {
    test('nothing connected: the note, no Switch wallet, and the tab names the account', async () => {
        const r = await page({ path: 'wallet/' + A, wallets: { 'polkadot-js': [ext(51)] } });
        assert.deepEqual(r.errors, []);
        assert.equal(r.final.dashboard.note, NOTE(A));
        assert.equal(r.final.dashboard.banner, null);
        assert.equal(r.final.dashboard.switchShown, false, 'Switch wallet with nothing to switch');
        assert.equal(r.final.dashboard.title, `Account ${short(A)} - Polkadex Explorer`);
        assert.deepEqual(r.final.enables, { 'polkadot-js': 0 }, 'a wallet was asked just to show the note');
    });
    test('another wallet connected: the banner, not the note; Switch wallet shown', async () => {
        const r = await page({ path: 'wallet/' + A, seed: remembered(B, 'polkadot-js'), wallets: { 'polkadot-js': [ext(52)] } });
        assert.equal(r.final.dashboard.note, null);
        assert.match(r.final.dashboard.banner, /your wallet is/);
        assert.equal(r.final.dashboard.switchShown, true);
        assert.equal(r.final.dashboard.title, `Account ${short(A)} - Polkadex Explorer`);
    });
    test('this wallet connected: neither, and the tab says My Account with a plain hyphen', async () => {
        const r = await page({ path: 'wallet/' + A, seed: remembered(A, 'polkadot-js'), wallets: { 'polkadot-js': [ext(51)] } });
        assert.equal(r.final.dashboard.note, null);
        assert.equal(r.final.dashboard.banner, null);
        assert.equal(r.final.dashboard.switchShown, true);
        assert.equal(r.final.dashboard.title, 'My Account - Polkadex Explorer');
    });
    test('a wallet still restoring: neither the note nor Switch wallet (no flash for a returning user)', async () => {
        // /wallet starts the auto-pick of the remembered wallet, which never answers; then the user opens an address.
        const r = await page({ path: 'wallet', seed: { [WALLET_KEYS.lastSource]: 'polkadot-js', [WALLET_KEYS.lastUsed]: A }, wallets: { 'polkadot-js': [ext(51)] }, hang: ['polkadot-js'],
            steps: [{ go: '/wallet/' + A }] });
        assert.equal(r.final.path, '/wallet/' + A);
        assert.equal(r.final.dashboard.switchPresent, true, 'the dashboard did not render');
        assert.equal(r.final.dashboard.note, null, 'the note flashed while the wallet was restoring');
        assert.equal(r.final.dashboard.banner, null);
        assert.equal(r.final.dashboard.switchShown, false);
    });
    test('Connect wallet opens the chooser; picking the viewed account lands back on it, connected (the note gone, Disconnect shown)', async () => {
        const r = await page({ path: 'wallet/' + A, wallets: { 'polkadot-js': [ext(51)] },
            steps: [{ click: '#wallet-dashboard .wallet-viewing-note.is-readonly a' }, { click: '.wallet-option-row[data-source="polkadot-js"]' }, { click: '.wallet-account-btn' }] });
        assert.deepEqual(r.errors, []);
        assert.equal(r.steps[0].path, '/wallet?returnTo=' + encodeURIComponent('/wallet/' + A), 'the link did not open the chooser');
        assert.equal(r.steps[0].dashboard.switchPresent, false, 'still on the dashboard');
        assert.equal(r.final.path, '/wallet/' + A, 'did not come back to the same address');
        assert.equal(r.final.dashboard.note, null);
        assert.equal(r.final.dashboardDisconnect, true);
        assert.equal(r.final.dashboard.switchShown, true);
    });
    test('picking another account: back on the viewed address, and the banner takes the slot', async () => {
        const r = await page({ path: 'wallet/' + A, wallets: { 'polkadot-js': [ext(52)] },
            steps: [{ click: '#wallet-dashboard .wallet-viewing-note.is-readonly a' }, { click: '.wallet-option-row[data-source="polkadot-js"]' }, { click: '.wallet-account-btn' }] });
        assert.equal(r.final.path, '/wallet/' + A);
        assert.equal(r.final.dashboard.note, null);
        assert.match(r.final.dashboard.banner, new RegExp('your wallet is ' + short(B).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
    test('another tab disconnects while another address is open: the slot follows (banner out, note in, Switch hidden)', async () => {
        const r = await page({ path: 'wallet/' + A, seed: remembered(B, 'polkadot-js'), wallets: { 'polkadot-js': [ext(52)] },
            steps: [{ storage: { [WALLET_KEYS.address]: null, [WALLET_KEYS.source]: null, [WALLET_KEYS.lastUsed]: null, [WALLET_KEYS.lastSource]: null, [WALLET_KEYS.disconnected]: '1' } }] });
        assert.equal(r.final.path, '/wallet/' + A, 'the viewed address is kept');
        assert.equal(r.final.dashboard.banner, null);
        assert.equal(r.final.dashboard.note, NOTE(A));
        assert.equal(r.final.dashboard.switchShown, false);
    });
});
