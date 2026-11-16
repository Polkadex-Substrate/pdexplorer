// The header's wallet button (and every other "am I connected" surface) on the
// Connect wallet chooser branch.
//
// The report (16 Nov, real browser): on /wallet/<his address>, with the
// dashboard showing his identity, balances and Switch wallet, the header still
// showed the pink "Connect Wallet" instead of "My Account <short address>".
//
// What the full page shows: the header reads the stored session synchronously
// on load (cases 1 to 6 hold, no wallet asked). The reported screen appears
// when the account the user picked never reached storage: localStorage refused
// the write (a full quota, or a private window). select() swallowed the error,
// navigated to the dashboard of the picked address, and every surface that asks
// "who is connected" (header, sidebar, the dashboard's Disconnect, signing,
// the discussion composer) read the empty storage and said nobody. The session
// in lib/wallet-session.js is the one source of truth; it must keep the choice
// for this page even when storage cannot, and the header must follow it.
//
// Cases 1 to 11 load the REAL index.html and script.js in happy-dom
// (test/helpers/full-page.js), one child process per page load.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeAddress } from '@polkadot/util-crypto';
import { createWalletSession, WALLET_KEYS, isSessionStorageKey } from '../lib/wallet-session.js';
import { readRepo, bodyOf, stripComments } from './helpers/source.js';

const RUNNER = fileURLToPath(new URL('./helpers/full-page.js', import.meta.url));
const SCRIPT = readRepo('script.js', import.meta.url);

// Synthetic accounts: 32 bytes of one repeated value. They belong to no one.
const addr = (n, prefix = 88) => encodeAddress(new Uint8Array(32).fill(n), prefix);
const A = addr(41), B = addr(42);
const ext = (n) => addr(n, 42);   // how an extension hands the account over
const short = (a) => a.substring(0, 8) + '…' + a.substring(a.length - 6);
const same = (a, b) => a === b;

function page(scenario) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [RUNNER, JSON.stringify(scenario)], { timeout: 60000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
            const line = String(stdout).split('\n').find(l => l.startsWith('RESULT '));
            if (!line) return reject(new Error('the page did not report: ' + (err ? err.message : '') + '\n' + String(stderr).slice(-2000)));
            resolve(JSON.parse(line.slice(7)));
        });
    });
}
const connectedAs = (h, a, msg) => {
    assert.equal(h.label, 'My Account', msg + ': the header says ' + JSON.stringify(h.label));
    assert.equal(h.sub, short(a), msg + ': the header shows ' + JSON.stringify(h.sub) + ', not ' + short(a));
    assert.equal(h.connectedClass, true, msg + ': the button is not styled as connected');
};
const notConnected = (h, msg) => {
    assert.equal(h.label, 'Connect Wallet', msg + ': the header says ' + JSON.stringify(h.label));
    assert.equal(h.connectedClass, false, msg);
};
const remembered = (a, src) => ({ [WALLET_KEYS.address]: a, [WALLET_KEYS.source]: src, [WALLET_KEYS.lastSource]: src, [WALLET_KEYS.lastUsed]: a });
const ROW = (key) => `.wallet-option-row[data-source="${key}"]`;
const MENU = '#connect-wallet-btn', MENU_DISCONNECT = '[data-wallet-action="disconnect"]';

describe('header on load: the stored session, shown at once, no wallet asked', () => {
    test('1. stored session + remembered extension: My Account <short> on the first render, no enable()', async () => {
        const r = await page({ path: 'wallet/' + A, seed: remembered(A, 'polkadot-js'), wallets: { 'polkadot-js': [ext(41)] } });
        connectedAs(r.first, A, 'first render');
        assert.match(r.first.navTitle, new RegExp(A), 'the sidebar My Account does not name the account');
        assert.deepEqual(r.first.enables, { 'polkadot-js': 0 }, 'a wallet was asked just to show the account');
        assert.equal(r.final.dashboardDisconnect, true, 'the dashboard does not treat the account as the connected one');
        assert.deepEqual(r.final.enables, { 'polkadot-js': 0 });
    });
    test('2. a WalletConnect (phone) session: same, before the phone is reached', async () => {
        const r = await page({ path: 'wallet/' + A, seed: { ...remembered(A, 'walletconnect'), pdex_wc_enabled: '1', pdex_wc_session: '1' }, wallets: { 'polkadot-js': [ext(9)] } });
        connectedAs(r.first, A, 'first render');
        assert.deepEqual(r.first.enables, { 'polkadot-js': 0 });
    });
    test('3. a legacy session (address only, generic prefix, no wallet recorded): same; signing asks later, on a click', async () => {
        const r = await page({ path: 'wallet/' + A, seed: { [WALLET_KEYS.address]: ext(41) }, wallets: { 'polkadot-js': [ext(41)], talisman: [ext(41)] } });
        connectedAs(r.first, A, 'first render');
        assert.deepEqual(r.first.enables, { 'polkadot-js': 0, talisman: 0 });
        assert.deepEqual(r.final.enables, { 'polkadot-js': 0, talisman: 0 }, 'a wallet was asked on load');
    });
});

describe('header follows connect, switch and disconnect', () => {
    test('4. Disconnect from the header menu: Connect Wallet', async () => {
        const r = await page({ path: 'wallet/' + A, seed: remembered(A, 'polkadot-js'), wallets: { 'polkadot-js': [ext(41)] },
            steps: [{ click: MENU }, { click: MENU_DISCONNECT }] });
        connectedAs(r.first, A, 'before');
        notConnected(r.final, 'after Disconnect');
        assert.equal(r.final.stored, null);
    });
    test('5. Switch to another account: the header shows the new short address', async () => {
        const r = await page({ path: 'wallet?switch=1', seed: remembered(A, 'polkadot-js'), wallets: { 'polkadot-js': [ext(41), ext(42)] },
            steps: [{ wait: 80 }, { click: '#wallet-accounts .wallet-account-btn[data-address="' + B + '"]' }] });
        connectedAs(r.final, B, 'after the switch');
        assert.equal(r.final.path, '/wallet/' + B);
    });
    test('6. the chooser connects (row, then account): the header turns into My Account', async () => {
        const r = await page({ path: 'wallet', wallets: { 'polkadot-js': [ext(41)] }, steps: [{ click: ROW('polkadot-js') }, { click: '.wallet-account-btn' }] });
        notConnected(r.first, 'before');
        notConnected(r.steps[0], 'accounts listed, none picked yet');
        connectedAs(r.final, A, 'after picking the account');
        assert.equal(r.final.dashboardDisconnect, true);
    });
    test('7. another tab switches, then disconnects: this header follows both', async () => {
        const r = await page({ path: 'wallet/' + A, seed: remembered(A, 'polkadot-js'), wallets: { 'polkadot-js': [ext(41), ext(42)] },
            // What the other tab's select(B) and disconnect() write.
            steps: [{ storage: { [WALLET_KEYS.address]: B, [WALLET_KEYS.lastUsed]: B } },
                { storage: { [WALLET_KEYS.address]: null, [WALLET_KEYS.source]: null, [WALLET_KEYS.lastUsed]: null, [WALLET_KEYS.lastSource]: null, [WALLET_KEYS.disconnected]: '1' } }] });
        connectedAs(r.steps[0], B, 'after the other tab switched');
        notConnected(r.steps[1], 'after the other tab disconnected');
    });
});

describe('storage refuses the write (full quota, private window): the reported screen', () => {
    test('8. connect through the chooser: My Account, and the dashboard is the connected one (Disconnect shown)', async () => {
        const r = await page({ path: 'wallet', refuseWalletWrites: true, wallets: { 'polkadot-js': [ext(41)] },
            steps: [{ click: ROW('polkadot-js') }, { click: '.wallet-account-btn' }] });
        assert.equal(r.final.path, '/wallet/' + A, 'the dashboard of the picked account did not open');
        connectedAs(r.final, A, 'dashboard open after connecting');
        assert.equal(r.final.dashboardDisconnect, true, 'the dashboard treats the account as somebody else\'s');
        assert.match(r.final.menuWho, new RegExp(short(A).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the My Account menu names nobody');
    });
    test('9. switch with a full quota: the header shows the new account, not the stored one', async () => {
        const r = await page({ path: 'wallet?switch=1', seed: remembered(A, 'polkadot-js'), refuseWalletWrites: true, wallets: { 'polkadot-js': [ext(41), ext(42)] },
            steps: [{ wait: 80 }, { click: '#wallet-accounts .wallet-account-btn[data-address="' + B + '"]' }] });
        connectedAs(r.final, B, 'after the switch');
    });
    test('10. coming back to the tab (focus) keeps the account this page connected', async () => {
        const r = await page({ path: 'wallet', refuseWalletWrites: true, wallets: { 'polkadot-js': [ext(41)] },
            steps: [{ click: ROW('polkadot-js') }, { click: '.wallet-account-btn' }, { event: 'visibilitychange' }] });
        connectedAs(r.steps[1], A, 'after connecting');
        connectedAs(r.final, A, 'after the tab came back');
    });
    test('12. another tab disconnects and only the disconnected flag changes in storage: this page lets go of its held account, and says so', async () => {
        // This page connected A but storage refused the write, so storage never
        // held an address. The other tab's Disconnect removes keys that are
        // already absent (no storage event for those) and sets the flag: the
        // one event this page gets is for pdex_wallet_disconnected.
        const r = await page({ path: 'wallet', refuseWalletWrites: true, wallets: { 'polkadot-js': [ext(41)] },
            steps: [{ click: ROW('polkadot-js') }, { click: '.wallet-account-btn' }, { storage: { [WALLET_KEYS.disconnected]: '1' } }] });
        connectedAs(r.steps[1], A, 'after connecting');
        notConnected(r.final, 'after the other tab disconnected');
    });
    test('11. Disconnect still disconnects when storage refuses the removal too', async () => {
        const r = await page({ path: 'wallet', refuseWalletWrites: true, wallets: { 'polkadot-js': [ext(41)] },
            steps: [{ click: ROW('polkadot-js') }, { click: '.wallet-account-btn' }, { click: MENU }, { click: MENU_DISCONNECT }] });
        connectedAs(r.steps[1], A, 'after connecting');
        notConnected(r.final, 'after Disconnect');
    });
});

describe('lib/wallet-session.js: the choice holds for this page when storage cannot', () => {
    const refusing = () => {
        const m = new Map();
        return { m, refuse: true,
            getItem(k) { return m.has(k) ? m.get(k) : null; },
            setItem(k, v) { if (this.refuse) throw new Error('quota'); m.set(k, String(v)); },
            removeItem(k) { if (this.refuse) throw new Error('quota'); m.delete(k); } };
    };
    test('select, switch and disconnect are reported through getActiveAccount and onActiveAccountChange', () => {
        const storage = refusing();
        const s = createWalletSession({ storage, isSame: same });
        const seen = [];
        s.onActiveAccountChange(c => seen.push(c.reason + ':' + c.current));
        s.select(A, 'polkadot-js');
        assert.deepEqual(s.getActiveAccount(), { address: A, source: 'polkadot-js', status: 'connected' });
        assert.equal(s.connected(), A);
        s.select(B, 'polkadot-js');
        assert.equal(s.connected(), B);
        s.disconnect();
        assert.equal(s.connected(), '');
        assert.deepEqual(seen, ['connect:' + A, 'switch-account:' + B, 'disconnect:']);
    });
    test('a refused removal still disconnects', () => {
        const storage = refusing();
        storage.refuse = false;
        const s = createWalletSession({ storage, isSame: same });
        s.select(A, 'polkadot-js');
        storage.refuse = true;
        s.disconnect();
        assert.equal(s.connected(), '');
        assert.equal(s.source(), '');
        assert.equal(s.getActiveAccount().status, 'none');
    });
    test('a tab coming back (syncExternal) with nothing changed elsewhere keeps the choice', () => {
        const s = createWalletSession({ storage: refusing(), isSame: same });
        s.select(A, 'polkadot-js');
        assert.equal(s.syncExternal(), null);
        assert.equal(s.connected(), A);
    });
    test('the storage keys a page must listen to for another tab: address, source, the disconnected flag, and a clear()', () => {
        for (const k of [WALLET_KEYS.address, WALLET_KEYS.source, WALLET_KEYS.disconnected, null]) assert.equal(isSessionStorageKey(k), true, String(k));
        for (const k of [WALLET_KEYS.lastUsed, WALLET_KEYS.lastSource, 'pdex_watchlist_v1']) assert.equal(isSessionStorageKey(k), false, k);
        const code = stripComments(SCRIPT);
        assert.match(code, /window\.addEventListener\('storage', \(e\) => \{\s*if \(!isSessionStorageKey\(e\.key\)\) return;/, 'the page filters the storage event some other way');
    });
    test('a disconnected-only write from another tab drops the held choice and is announced once, flagged external', () => {
        const storage = refusing();
        const s = createWalletSession({ storage, isSame: same });
        const seen = [];
        s.onActiveAccountChange(c => seen.push(c.reason + ':' + c.current + ':' + c.external));
        s.select(A, 'polkadot-js');
        storage.m.set(WALLET_KEYS.disconnected, '1');   // the other tab's Disconnect
        const c = s.syncExternal();
        assert.equal(c && c.reason, 'disconnect');
        assert.equal(s.getActiveAccount().status, 'none');
        assert.deepEqual(seen, ['connect:' + A + ':false', 'disconnect::true']);
        assert.equal(s.syncExternal(), null, 'told once');
    });
    test('another tab that does write wins: this page follows what storage now says', () => {
        const storage = refusing();
        const s = createWalletSession({ storage, isSame: same });
        s.select(A, 'polkadot-js');
        storage.m.set(WALLET_KEYS.address, B);   // the other tab could write
        assert.equal(s.connected(), B);
        storage.m.delete(WALLET_KEYS.address);
        assert.equal(s.connected(), '', 'the other tab disconnected');
    });
});

describe('every "am I connected" surface reads the one session', () => {
    test('the header renders from getActiveAccount() and is subscribed to onActiveAccountChange', () => {
        const code = stripComments(SCRIPT);
        assert.match(bodyOf(code, 'refreshConnectWalletButton'), /walletSession\.getActiveAccount\(\)/, 'the header does not read the session API');
        assert.match(code, /walletSession\.onActiveAccountChange\(\s*\(?[^)]*\)?\s*=>\s*refreshConnectWalletButton\(\)|walletSession\.onActiveAccountChange\(refreshConnectWalletButton\)/,
            'the header is not subscribed to the session: a change made by any path must reach it');
    });
    test('no file but lib/wallet-session.js reads or writes the wallet keys', () => {
        const keys = Object.values(WALLET_KEYS);
        const files = ['script.js', 'lib/wallet-aware.js', 'lib/discussion-auth.js', 'lib/discussion-composer.js', 'lib/wallet-menu.js', 'lib/wallet-picker-view.js', 'lib/wallet-sources.js'];
        for (const f of files) {
            const code = stripComments(readRepo(f, import.meta.url));
            for (const k of keys) assert.ok(!code.includes("'" + k + "'") && !code.includes('"' + k + '"'), f + ' reads ' + k + ' directly instead of through the session');
        }
    });
});
