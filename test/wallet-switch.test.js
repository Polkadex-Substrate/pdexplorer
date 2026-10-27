// Switch wallet / Disconnect (reported on /wallet, 26-27 Oct: "I am not able to
// switch to a new wallet. No option like 'log out'... the pop up comes for me to
// pick." and, after being told My Account has a switch option: "Try switching.
// It doesn't work.")
//
// These run the REAL wallet functions from script.js (lifted by name into a vm,
// see helpers/wallet-world.js) against fake extensions and a localStorage that
// survives page loads. The first describe block is the root-cause regression: it
// was run against the code before the fix and fails there for each cause named.
//
//   1. Disconnect did not stick (one-shot sessionStorage flag, then the auto-pick
//      silently reconnected the account on the next visit).
//   2. /wallet redirected to the stored dashboard, so the picker could not be
//      opened while a selection persisted.
//   3. A dashboard fetch in flight repainted the old account over the picker.
//   4. Switching accounts left the old account's discussion session in storage.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeProfile, openTab, fakeExtension, settle, addr, A, B, C } from './helpers/wallet-world.js';
import { createWalletSession, pickSigningAccount, orderSources, WALLET_KEYS } from '../lib/wallet-session.js';
import { buildAccountListHtml, buildCurrentBannerHtml, buildMissingAccountHelpHtml, groupBySource, sourceLabel } from '../lib/wallet-picker.js';
import { wireWalletMenu } from '../lib/wallet-menu.js';
import { decodeAddress } from '@polkadot/util-crypto';

const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const same = (a, b) => { try { return Buffer.from(decodeAddress(a)).equals(Buffer.from(decodeAddress(b))); } catch (e) { return false; } };
const acct = (n, name) => ({ address: addr(n, 42), name });   // an extension hands back prefix 42
const polkadotJs = (...accounts) => fakeExtension('polkadot-js', accounts);
const talisman = (...accounts) => fakeExtension('talisman', accounts);
const subwallet = (...accounts) => fakeExtension('subwallet-js', accounts);
const session = (token, address) => JSON.stringify({ token, address });
const DISCUSS = 'pdex_discuss_session';
const stored = (tab) => tab.read('pdex_wallet_address');

describe('root cause: the symptoms Vivek reported', () => {
    test('Disconnect sticks: a reload or new tab shows the picker instead of reconnecting the account', async () => {
        const profile = makeProfile({ extensions: [polkadotJs(acct(1, 'Alice'), acct(2, 'Bob'))] });
        const tab1 = openTab(profile, { path: '/wallet' });
        await tab1.visit('/wallet');                       // first visit: auto-pick connects
        assert.equal(stored(tab1), A, 'precondition: the first visit connects the first account');
        tab1.fn('disconnectWallet')();
        await tab1.settle();
        assert.equal(stored(tab1), null, 'Disconnect cleared the connected address');

        const tab2 = openTab(profile, { path: '/wallet' });  // a reload / new tab: fresh sessionStorage
        await tab2.visit('/wallet');
        assert.equal(stored(tab2), null,
            'the next visit silently reconnected the account the user had just disconnected (one-shot skip flag)');
        assert.ok(tab2.panelHtml().includes('wallet-account-btn') || tab2.accountButtons().length > 0, 'the picker is showing');
        assert.ok(!tab2.panelHtml().startsWith('DASHBOARD'), 'no dashboard');
    });

    test('Switch wallet is not undone by a dashboard fetch that lands afterwards', async () => {
        const profile = makeProfile({ extensions: [polkadotJs(acct(1, 'Alice'), acct(2, 'Bob'))] });
        const tab = openTab(profile, { path: '/wallet/' + A });
        profile.local.setItem('pdex_wallet_address', A);
        await tab.visit('/wallet/' + A);                   // dashboard load starts; /api/wallet is still pending
        assert.equal(tab.pending.length, 1);
        tab.fn('disconnectWallet')();                      // the user clicks Switch / Disconnect meanwhile
        await tab.settle();
        assert.ok(tab.panelHtml().includes('wallet-accounts'), 'the picker is showing');
        tab.pending[0].resolve({ address: A });            // the slow response finally arrives
        await tab.settle();
        assert.ok(!tab.panelHtml().startsWith('DASHBOARD'),
            'the late response repainted the old account over the picker');
        assert.deepEqual(tab.log.renders, [], 'no dashboard was rendered after the user left it');
    });

    test('the picker opens even while a selection is persisted (/wallet?switch=1)', async () => {
        const profile = makeProfile({ extensions: [polkadotJs(acct(1, 'Alice'), acct(2, 'Bob'))] });
        profile.local.setItem('pdex_wallet_address', A);
        const plain = openTab(profile, { path: '/wallet' });
        await plain.visit('/wallet');
        assert.ok(plain.log.routes.includes('wallet/' + A), 'plain /wallet still goes straight to the stored dashboard');

        const tab = openTab(profile, { path: '/wallet', search: '?switch=1' });
        await tab.visit('/wallet?switch=1');
        assert.ok(tab.accountButtons().length === 2, 'the picker lists both accounts');
        assert.equal(stored(tab), A, 'looking does not disconnect: the current wallet is kept until another is chosen');
        assert.ok(tab.panelHtml().includes('Connected as'), 'the picker says what is connected');
    });

    test('switching to a different account does not leave the old account\'s discussion session valid', async () => {
        const profile = makeProfile({ extensions: [polkadotJs(acct(1, 'Alice'), acct(2, 'Bob'))] });
        profile.local.setItem('pdex_wallet_address', A);
        profile.local.setItem(DISCUSS, session('tok-alice', A));
        const tab = openTab(profile, { path: '/wallet' });
        tab.fn('selectWallet')(B, 'polkadot-js');
        await tab.settle();
        assert.equal(profile.local.getItem(DISCUSS), null, 'the old account\'s token is still in storage');
        assert.deepEqual(profile.logoutCalls, ['Bearer tok-alice'], 'the server was not told to drop the old session');
        assert.equal(tab.fn('getDiscussSession')(), null);
    });
});

describe('switch extension', () => {
    test('the picker groups accounts by extension and a click on the other extension\'s account switches to it', async () => {
        const profile = makeProfile({ extensions: [polkadotJs(acct(1, 'Alice')), talisman(acct(2, 'Bob'))] });
        profile.local.setItem('pdex_wallet_address', A);
        profile.local.setItem('pdex_wallet_source', 'polkadot-js');
        const tab = openTab(profile, { path: '/wallet', search: '?switch=1' });
        await tab.visit('/wallet?switch=1');
        const html = tab.root.querySelector('#wallet-accounts').innerHTML;
        assert.match(html, /Polkadot\.js/);
        assert.match(html, /Talisman/);
        const buttons = tab.accountButtons();
        assert.equal(buttons.length, 2);
        const bobBtn = buttons.find(b => b.getAttribute('data-source') === 'talisman');
        await bobBtn.click();
        assert.equal(stored(tab), B);
        assert.equal(tab.read('pdex_wallet_source'), 'talisman');
        assert.equal(tab.read('pdex_last_used_wallet_address'), B);
        assert.equal(tab.ctx.window.location.pathname, '/wallet/' + B, 'went to the new dashboard');
    });

    test('the extension the user picked is the one asked to sign, when the same key is in two', async () => {
        const pj = polkadotJs(acct(1, 'Alice (pjs)'));
        const tl = talisman(acct(1, 'Alice (talisman)'));
        const profile = makeProfile({ extensions: [pj, tl] });
        const tab = openTab(profile, { path: '/wallet' });
        tab.fn('selectWallet')(A, 'talisman');
        const signer = await tab.fn('getWalletSigner')(A);
        assert.equal(signer.extKey, 'talisman');
        tab.fn('selectWallet')(A, 'polkadot-js');
        assert.equal((await tab.fn('getWalletSigner')(A)).extKey, 'polkadot-js');
    });

    test('if the chosen extension no longer holds the account, another that does is used', async () => {
        const tl = talisman(acct(1, 'Alice'));
        const profile = makeProfile({ extensions: [polkadotJs(acct(2, 'Bob')), tl] });
        const tab = openTab(profile, { path: '/wallet' });
        tab.fn('selectWallet')(A, 'polkadot-js');   // stale preference
        assert.equal((await tab.fn('getWalletSigner')(A)).extKey, 'talisman');
    });
});

describe('switch account within the same extension', () => {
    test('picking the other account updates storage, the header and every view, and keeps the extension', async () => {
        const profile = makeProfile({ extensions: [polkadotJs(acct(1, 'Alice'), acct(2, 'Bob'))] });
        profile.local.setItem('pdex_wallet_address', A);
        const tab = openTab(profile, { path: '/wallet', search: '?switch=1' });
        await tab.visit('/wallet?switch=1');
        const before = { dem: tab.log.democracyRestarts, gov: tab.log.govAccountChanged };
        await tab.accountButtons().find(b => b.getAttribute('data-address') === B).click();
        assert.equal(stored(tab), B);
        assert.equal(tab.read('pdex_wallet_source'), 'polkadot-js');
        assert.equal(tab.log.democracyRestarts, before.dem + 1, '"You voted" did not follow the wallet');
        assert.equal(tab.log.govAccountChanged, before.gov + 1, 'the governance Actions panel did not follow the wallet');
        assert.match(tab.header['connect-wallet-sub'].textContent, /^e/, 'the header shows the new address');
        assert.ok(tab.header['connect-wallet-sub'].textContent.includes(B.slice(0, 6)), 'the header shows the NEW address');
    });

    test('a page that reads the wallet when it renders is re-rendered after a switch', async () => {
        const profile = makeProfile({ extensions: [polkadotJs(acct(1, 'Alice'), acct(2, 'Bob'))] });
        profile.local.setItem('pdex_wallet_address', A);
        const tab = openTab(profile, { path: '/discussions/t1' });
        tab.log.routes.length = 0;
        tab.fn('selectWallet')(B, 'polkadot-js');
        assert.ok(tab.log.routes.includes('discussions/t1'), 'the discussion page kept the old posting identity until a reload');
    });

    test('choosing the account that is already connected changes nothing and keeps its discussion session', async () => {
        const profile = makeProfile({ extensions: [polkadotJs(acct(1, 'Alice'))] });
        profile.local.setItem('pdex_wallet_address', A);
        profile.local.setItem('pdex_wallet_source', 'polkadot-js');
        profile.local.setItem(DISCUSS, session('tok-alice', A));
        const tab = openTab(profile, { path: '/wallet' });
        tab.fn('selectWallet')(addr(1, 42), 'polkadot-js');   // the same key, extension's encoding
        assert.equal(tab.log.democracyRestarts, 0);
        assert.equal(profile.local.getItem(DISCUSS), session('tok-alice', A));
        assert.deepEqual(profile.logoutCalls, []);
        assert.equal(tab.fn('getDiscussSession')().token, 'tok-alice');
    });

    test('Refresh accounts picks up an account the user has just allowed in the wallet', async () => {
        const pj = polkadotJs(acct(1, 'Alice'));
        const profile = makeProfile({ extensions: [pj] });
        profile.local.setItem('pdex_wallet_address', A);
        const tab = openTab(profile, { path: '/wallet', search: '?switch=1' });
        await tab.visit('/wallet?switch=1');
        assert.equal(tab.accountButtons().length, 1);
        pj.accounts.push(acct(3, 'Carol'));             // the user allows another account in the extension
        const refresh = tab.root.querySelector('#wallet-accounts').querySelector('#wallet-picker-refresh');
        assert.ok(refresh, 'there is a Refresh accounts control');
        await refresh.click();
        await tab.settle();
        assert.equal(tab.accountButtons().length, 2, 'the new account did not appear without a page reload');
    });
});

describe('disconnect', () => {
    test('clears the selection, the extension, the last-used memory and the discussion session, and signs out on the server', async () => {
        const profile = makeProfile({ extensions: [polkadotJs(acct(1, 'Alice'))] });
        for (const [k, v] of [['pdex_wallet_address', A], ['pdex_wallet_source', 'polkadot-js'], ['pdex_last_used_wallet_address', A], [DISCUSS, session('tok-alice', A)]]) profile.local.setItem(k, v);
        const tab = openTab(profile, { path: '/wallet/' + A });
        tab.fn('disconnectWallet')();
        await tab.settle();
        for (const k of ['pdex_wallet_address', 'pdex_wallet_source', 'pdex_last_used_wallet_address', DISCUSS]) assert.equal(profile.local.getItem(k), null, k + ' survived Disconnect');
        assert.equal(profile.local.getItem('pdex_wallet_disconnected'), '1', 'the opt-out is not recorded');
        assert.deepEqual(profile.logoutCalls, ['Bearer tok-alice']);
        assert.equal(tab.fn('getStoredWallet')(), '');
        assert.equal(tab.fn('getDiscussSession')(), null, 'a signed-out page still has a posting identity');
        assert.equal(tab.header['connect-wallet-label'].textContent, 'Connect Wallet', 'the header is back to signed-out');
        assert.equal(tab.header['disconnect-wallet-btn'].style.display, 'none');
        assert.equal(tab.log.democracyRestarts, 1);
        assert.equal(tab.log.govAccountChanged, 1);
    });

    test('lands on the picker when done from a wallet page, and stays put when done from another page', async () => {
        const profile = makeProfile({ extensions: [polkadotJs(acct(1, 'Alice'))] });
        profile.local.setItem('pdex_wallet_address', A);
        const onWallet = openTab(profile, { path: '/wallet/' + A });
        onWallet.fn('disconnectWallet')();
        await onWallet.settle();
        assert.equal(onWallet.ctx.window.location.pathname, '/wallet');
        assert.ok(onWallet.panelHtml().includes('wallet-accounts'));

        profile.local.setItem('pdex_wallet_address', A);
        const elsewhere = openTab(profile, { path: '/council' });
        elsewhere.log.routes.length = 0;
        elsewhere.fn('disconnectWallet')();
        await elsewhere.settle();
        assert.equal(elsewhere.ctx.window.location.pathname, '/council', 'Disconnect threw the user off the page they were on');
        assert.ok(elsewhere.log.routes.includes('council'), 'the page was not re-rendered as signed out');
    });

    test('an explicit pick after a Disconnect lifts the opt-out, and the connection then persists across a reload', async () => {
        const profile = makeProfile({ extensions: [polkadotJs(acct(1, 'Alice'), acct(2, 'Bob'))] });
        const t1 = openTab(profile, { path: '/wallet' });
        await t1.visit('/wallet');
        t1.fn('disconnectWallet')();
        await t1.settle();
        await t1.accountButtons().find(b => b.getAttribute('data-address') === B).click();
        assert.equal(profile.local.getItem('pdex_wallet_disconnected'), null);
        const t2 = openTab(profile, { path: '/wallet' });      // reload
        await t2.visit('/wallet');
        assert.equal(stored(t2), B, 'the chosen account did not persist');
        assert.ok(t2.log.routes.includes('wallet/' + B), 'a reload goes straight to the connected dashboard');
    });

    test('first-time visitors are still auto-connected (the Disconnect opt-out only applies after a Disconnect)', async () => {
        const profile = makeProfile({ extensions: [polkadotJs(acct(2, 'Bob'), acct(1, 'Alice'))] });
        const tab = openTab(profile, { path: '/wallet' });
        await tab.visit('/wallet');
        assert.equal(stored(tab), B, 'the first account in the list is picked, as before');
    });

    test('the last-used account is preferred by the auto-pick, until Disconnect forgets it', async () => {
        const profile = makeProfile({ extensions: [polkadotJs(acct(2, 'Bob'), acct(1, 'Alice'))] });
        profile.local.setItem('pdex_last_used_wallet_address', A);
        const tab = openTab(profile, { path: '/wallet' });
        await tab.visit('/wallet');
        assert.equal(stored(tab), A);
    });
});

describe('discussion posting identity follows the wallet', () => {
    test('a session for another account is not used, and none is used when nothing is connected', () => {
        const profile = makeProfile();
        const tab = openTab(profile, { path: '/discussions' });
        profile.local.setItem(DISCUSS, session('tok-alice', A));
        assert.equal(tab.fn('getDiscussSession')(), null, 'a session with no connected wallet must not post');
        profile.local.setItem('pdex_wallet_address', B);
        assert.equal(tab.fn('getDiscussSession')(), null, 'a session for A posted as B\'s page');
        profile.local.setItem('pdex_wallet_address', A);
        assert.equal(tab.fn('getDiscussSession')().token, 'tok-alice');
        profile.local.setItem('pdex_wallet_address', addr(1, 42));
        assert.equal(tab.fn('getDiscussSession')().token, 'tok-alice', 'same key, other SS58 prefix, is the same account (F-128)');
    });
});

describe('lib/wallet-session', () => {
    const mk = (extra = {}) => {
        const storage = new Map();
        const ls = { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) };
        const events = []; let revokes = 0;
        const s = createWalletSession({ storage: ls, toAddress: a => a, isSame: same, isValid: a => !!a, revokeDiscuss: () => { revokes++; }, onChange: e => events.push(e), ...extra });
        return { s, storage, events, revokes: () => revokes };
    };

    test('select stores address, extension and last-used, and reports a change once', () => {
        const { s, storage, events } = mk();
        assert.equal(s.select(A, 'talisman').changed, true);
        assert.equal(s.select(A, 'talisman').changed, false);
        assert.equal(storage.get('pdex_wallet_source'), 'talisman');
        assert.equal(events.length, 1);
        assert.equal(s.select(A, 'polkadot-js').changed, true, 'a different extension for the same account is a change (the signer differs)');
    });

    test('select revokes only when the ADDRESS changes, and before it writes', () => {
        const { s, revokes, storage } = mk();
        s.select(A, 'polkadot-js');
        assert.equal(revokes(), 0, 'first connection has nothing to revoke');
        s.select(addr(1, 42), 'talisman');
        assert.equal(revokes(), 0, 'same account via another extension keeps the session');
        let seenWhileRevoking = null;
        const w = mk({ revokeDiscuss: () => { seenWhileRevoking = w.storage.get('pdex_wallet_address'); } });
        w.s.select(A, ''); w.s.select(B, '');
        assert.equal(seenWhileRevoking, A, 'revoke ran after the old address was already gone');
        assert.equal(w.storage.get('pdex_wallet_address'), B);
    });

    test('an invalid address is rejected and nothing is written', () => {
        const { s, storage } = mk({ isValid: () => false });
        assert.equal(s.select('nope').rejected, true);
        assert.equal(storage.size, 0);
    });

    test('mayAutoPick is false after disconnect, until an explicit select', () => {
        const { s } = mk();
        assert.equal(s.mayAutoPick(), true);
        s.select(A, '');
        assert.equal(s.mayAutoPick(), false, 'connected');
        s.disconnect();
        assert.equal(s.mayAutoPick(), false, 'disconnected by choice');
        assert.equal(s.isDisconnected(), true);
        s.select(B, '');
        assert.equal(s.isDisconnected(), false);
    });

    test('disconnect on an already-disconnected profile revokes (safe) but does not announce a change', () => {
        const { s, events, revokes } = mk();
        s.disconnect();
        assert.equal(events.length, 0);
        assert.equal(revokes(), 1);
    });

    test('a storage that throws does not break the switch', () => {
        const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); } };
        const s = createWalletSession({ storage: boom, isSame: same });
        assert.doesNotThrow(() => { s.select(A, 'x'); s.disconnect(); s.connected(); });
    });

    test('works with a storage whose methods throw when called without their owner (natives unbound)', () => {
        const store = new Map();
        const native = {};
        for (const [name, impl] of Object.entries({
            getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k)
        })) native[name] = function (...a) { if (this !== native) throw new TypeError("Failed to execute '" + name + "' on 'Storage': Illegal invocation"); return impl(...a); };
        const s = createWalletSession({ storage: native, isSame: same });
        s.select(A, 'polkadot-js');
        assert.equal(s.connected(), A);
        s.disconnect();
        assert.equal(s.connected(), '');
    });

    test('pickSigningAccount and orderSources', () => {
        const accounts = [{ address: addr(1, 42), source: 'polkadot-js' }, { address: addr(1, 0), source: 'talisman' }, { address: addr(2, 42), source: 'talisman' }];
        assert.equal(pickSigningAccount(accounts, A, 'talisman', same).source, 'talisman');
        assert.equal(pickSigningAccount(accounts, A, 'subwallet-js', same).source, 'polkadot-js', 'unknown preference falls back to the first match');
        assert.equal(pickSigningAccount(accounts, C, 'talisman', same), null);
        assert.deepEqual(orderSources(['a', 'b', 'c'], 'c'), ['c', 'a', 'b']);
        assert.deepEqual(orderSources(['a', 'b'], 'zzz'), ['a', 'b']);
        assert.deepEqual(orderSources(['a', 'b'], ''), ['a', 'b']);
    });
});

describe('lib/wallet-picker', () => {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const short = (a) => a.slice(0, 6);
    const base = { isSame: same, esc, shortAddr: short };

    test('groups by extension in enumeration order, with readable names', () => {
        const groups = groupBySource([{ address: A, name: 'a', source: 'talisman' }, { address: B, name: 'b', source: 'polkadot-js' }, { address: C, name: 'c', source: 'talisman' }]);
        assert.deepEqual(groups.map(g => [g.label, g.accounts.length]), [['Talisman', 2], ['Polkadot.js', 1]]);
        assert.equal(sourceLabel('subwallet-js'), 'SubWallet');
        assert.equal(sourceLabel('some-new-wallet'), 'some-new-wallet');
    });

    test('marks exactly one account Connected, even when the same key is in two extensions', () => {
        const accounts = [{ address: A, name: 'one', source: 'polkadot-js' }, { address: addr(1, 42), name: 'one', source: 'talisman' }];
        const html = buildAccountListHtml({ ...base, accounts, current: A, currentSource: 'talisman' });
        assert.equal((html.match(/Connected/g) || []).length, 1);
        assert.match(html, /data-source="talisman"[^>]*aria-current="true"/);
    });

    test('an account name from the extension is escaped', () => {
        const html = buildAccountListHtml({ ...base, accounts: [{ address: A, name: '<img src=x onerror=alert(1)>', source: 'polkadot-js' }], current: '', currentSource: '' });
        assert.ok(!html.includes('<img'), 'an extension-supplied name reached the page unescaped');
        assert.match(html, /&lt;img/);
    });

    test('the banner appears only when something is connected, and offers Keep and Disconnect', () => {
        assert.equal(buildCurrentBannerHtml({ current: '', esc, shortAddr: short }), '');
        const html = buildCurrentBannerHtml({ current: A, currentSource: 'talisman', esc, shortAddr: short });
        assert.match(html, /wallet-picker-stay/);
        assert.match(html, /wallet-picker-disconnect/);
        assert.match(html, /Talisman/);
    });

    test('the help for an unlisted account says what to do and offers Refresh', () => {
        const html = buildMissingAccountHelpHtml();
        assert.match(html, /wallet-picker-refresh/);
        assert.match(html, /allow <strong>Polkadex Explorer<\/strong>/);
    });
});

// A document / button / menu that behave like the browser's, including the rule
// that listener methods throw when called without their owner.
function menuWorld({ connected = true } = {}) {
    const listeners = { doc: {}, button: {} };
    const items = ['view', 'switch', 'disconnect'].map(action => {
        const it = { action, handlers: [], getAttribute: (k) => (k === 'data-wallet-action' ? action : null), addEventListener(t, fn) { this.handlers.push(fn); } };
        return it;
    });
    const attrs = {};
    let focused = 0;
    const button = {
        setAttribute(k, v) { attrs[k] = v; }, contains: (t) => t === button, focus() { focused++; },
        addEventListener(t, fn) { listeners.button[t] = fn; }
    };
    const menu = { hidden: true, style: {}, contains: (t) => items.includes(t) || t === menu, querySelectorAll: () => items };
    const doc = { addEventListener(t, fn) { if (this !== doc) throw new TypeError('Illegal invocation'); listeners.doc[t] = fn; } };
    const calls = [];
    const state = { connected };
    const api = wireWalletMenu({
        doc, button, menu, isConnected: () => state.connected,
        onConnect: () => calls.push('connect'), onView: () => calls.push('view'), onSwitch: () => calls.push('switch'), onDisconnect: () => calls.push('disconnect')
    });
    return { api, button, menu, items, attrs, listeners, calls, state, focused: () => focused, clickButton: () => listeners.button.click({ stopPropagation() {} }) };
}

describe('lib/wallet-menu (the My Account menu)', () => {
    test('connected: the button opens the menu, and a second click closes it', () => {
        const w = menuWorld();
        assert.equal(w.menu.hidden, true);
        w.clickButton();
        assert.equal(w.menu.hidden, false);
        assert.equal(w.attrs['aria-expanded'], 'true');
        w.clickButton();
        assert.equal(w.menu.hidden, true);
        assert.equal(w.attrs['aria-expanded'], 'false');
    });

    test('not connected: the button connects and no menu opens', () => {
        const w = menuWorld({ connected: false });
        w.clickButton();
        assert.deepEqual(w.calls, ['connect']);
        assert.equal(w.menu.hidden, true);
    });

    test('Switch wallet and Disconnect call their handlers and close the menu', () => {
        const w = menuWorld();
        w.clickButton();
        w.items.find(i => i.action === 'switch').handlers[0]({ stopPropagation() {} });
        assert.deepEqual(w.calls, ['switch']);
        assert.equal(w.menu.hidden, true);
        w.clickButton();
        w.items.find(i => i.action === 'disconnect').handlers[0]({ stopPropagation() {} });
        w.clickButton();
        w.items.find(i => i.action === 'view').handlers[0]({ stopPropagation() {} });
        assert.deepEqual(w.calls, ['switch', 'disconnect', 'view']);
    });

    test('a click elsewhere, or Escape, closes it; Escape returns focus to the button', () => {
        const w = menuWorld();
        w.clickButton();
        w.listeners.doc.click({ target: {} });
        assert.equal(w.menu.hidden, true);
        w.clickButton();
        w.listeners.doc.keydown({ key: 'Escape' });
        assert.equal(w.menu.hidden, true);
        assert.equal(w.focused(), 1);
        w.listeners.doc.keydown({ key: 'Escape' });
        assert.equal(w.focused(), 1, 'Escape on a closed menu must not steal focus');
    });

    test('a click inside the menu does not close it by the outside-click rule', () => {
        const w = menuWorld();
        w.clickButton();
        w.listeners.doc.click({ target: w.items[0] });
        assert.equal(w.menu.hidden, false);
    });

    test('a missing button or menu is a no-op, not a crash', () => {
        assert.doesNotThrow(() => wireWalletMenu({ doc: {}, button: null, menu: null, isConnected: () => true }));
    });
});

describe('page wiring', () => {
    test('index.html has the menu with the three actions, inside the wallet button group', () => {
        const group = HTML.slice(HTML.indexOf('class="wallet-btn-group"'), HTML.indexOf('</header>'));
        assert.match(group, /id="wallet-menu"/);
        for (const a of ['view', 'switch', 'disconnect']) assert.match(group, new RegExp(`data-wallet-action="${a}"`));
        assert.match(group, /id="wallet-menu-who"/);
        assert.match(group, /id="disconnect-wallet-btn"[^>]*aria-label="Disconnect wallet"/, 'the X is announced by screen readers');
    });

    test('script.js wires the menu, the dashboard buttons, the cross-tab listener, and no longer uses the one-shot flag', () => {
        assert.match(SCRIPT, /walletMenu = wireWalletMenu\(\{/);
        assert.match(SCRIPT, /onSwitch: openWalletPicker, onDisconnect: disconnectWallet/);
        assert.match(SCRIPT, /switchBtn\.addEventListener\('click', openWalletPicker\)/);
        assert.match(SCRIPT, /getElementById\('wallet-disconnect-btn'\)/);
        assert.match(SCRIPT, /window\.addEventListener\('storage', \(e\) => \{\s*if \(e\.key !== WALLET_KEYS\.address/);
        assert.ok(!/pdex_skip_wallet_auto_pick|consumeSkipAutoPickFlag/.test(SCRIPT.replace(/\/\/.*$/gm, '')), 'the one-shot flag is back');
    });

    test('the browser natives are not called through another object', () => {
        // storage is passed as the object itself, never as a detached method.
        assert.match(SCRIPT, /createWalletSession\(\{\s*storage: localStorage,/);
        assert.ok(!/getItem: localStorage\.getItem|setItem: localStorage\.setItem/.test(SCRIPT));
    });

    test('the dashboard load bumps a generation and drops stale responses', () => {
        const at = SCRIPT.indexOf('async function fetchWalletDashboard(');
        const body = SCRIPT.slice(at, SCRIPT.indexOf('\n}\n', at));
        assert.match(body, /const gen = \+\+walletFetchGen;/);
        assert.ok((body.match(/if \(stale\(\)\)/g) || []).length >= 4, 'each response handler checks for staleness');
    });

    test('the /cookies page documents the new keys and no longer the sessionStorage flag', () => {
        assert.match(HTML, /pdex_wallet_source/);
        assert.match(HTML, /pdex_wallet_disconnected/);
        assert.ok(!HTML.includes('pdex_skip_wallet_auto_pick'));
    });

    test('the help article describes the menu, Switch wallet, Disconnect and the missing-account case', async () => {
        const { HELP_TOPICS } = await import('../lib/help-topics.js');
        const t = HELP_TOPICS.find(x => x.slug === 'switching-wallets');
        assert.ok(t);
        for (const phrase of ['My Account', 'Switch wallet', 'Disconnect', 'Refresh accounts']) assert.ok(t.body.includes(phrase), phrase + ' missing from the help article');
    });

    test('script.js stays under its ceiling', () => {
        assert.ok(SCRIPT.split('\n').length < 15000);
    });
});
