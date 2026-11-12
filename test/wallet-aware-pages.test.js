// Pages follow the connected wallet (reported 11 Nov: "/staking-rewards should
// pick up the connected wallet as default. There are other pages also where
// the connected wallet doesn't automatically load ... Upon switching /
// disconnecting wallet, these pages should automatically pick up and respond").
//
// Three layers:
//   1. lib/wallet-session.js: one source of truth, now with getActiveAccount()
//      and onActiveAccountChange(cb) firing on connect, switch account, switch
//      extension, disconnect, restore, and a change made in another tab.
//   2. lib/wallet-aware.js: the route scope (subscribe on mount, unsubscribe on
//      leave), the latest-request token, the page decisions, the signing-modal
//      closer. Pure, so tested directly.
//   3. The REAL staking-rewards functions from script.js, lifted by name into a
//      vm whose document is happy-dom running the real index.html.
//
// Addresses are synthetic (32 bytes of one repeated value). They belong to no one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import { createWalletSession } from '../lib/wallet-session.js';
import * as aware from '../lib/wallet-aware.js';
import { isValidPolkadexAddress } from '../lib/wallet-safety.js';
import { escapeHtml } from '../lib/html-escape.js';
import { bodyOf } from './helpers/source.js';

const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const addr = (n, prefix = 88) => encodeAddress(new Uint8Array(32).fill(n), prefix);
const A = addr(11), B = addr(12), X = addr(13);
const same = (a, b) => { try { return Buffer.from(decodeAddress(a)).equals(Buffer.from(decodeAddress(b))); } catch (e) { return false; } };
const short = (a) => String(a).slice(0, 6) + '...' + String(a).slice(-4);

function memStorage() {
    const m = new Map();
    return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
function mkSession(extra = {}) {
    const storage = extra.storage || memStorage();
    const legacy = [];
    const s = createWalletSession({ storage, isSame: same, isValid: a => !!a, onChange: e => legacy.push(e), ...extra });
    const events = [];
    const off = s.onActiveAccountChange(e => events.push(e));
    return { s, storage, events, legacy, off };
}

// ─── 1. the session API ──────────────────────────────────────────────────────

describe('lib/wallet-session: getActiveAccount and onActiveAccountChange', () => {
    test('restore: an account remembered from the last visit is active as soon as the session exists', () => {
        const storage = memStorage();
        storage.setItem('pdex_wallet_address', A);
        storage.setItem('pdex_wallet_source', 'talisman');
        const { s } = mkSession({ storage });
        assert.deepEqual(s.getActiveAccount(), { address: A, source: 'talisman', status: 'connected' });
    });

    test('nothing remembered: status none, not restoring', () => {
        const { s } = mkSession();
        assert.deepEqual(s.getActiveAccount(), { address: '', source: '', status: 'none' });
    });

    test('connect, switch account, switch extension and disconnect each fire once, with what changed', () => {
        const { s, events } = mkSession();
        s.select(A, 'polkadot-js');
        s.select(A, 'polkadot-js');                    // same again: nothing
        s.select(B, 'polkadot-js');
        s.select(B, 'talisman');
        s.disconnect();
        assert.deepEqual(events.map(e => e.reason), ['connect', 'switch-account', 'switch-extension', 'disconnect']);
        assert.equal(events[0].previous, '');
        assert.equal(events[0].current, A);
        assert.equal(events[1].previous, A);
        assert.equal(events[1].current, B);
        assert.equal(events[2].previousSource, 'polkadot-js');
        assert.equal(events[2].source, 'talisman');
        assert.equal(events[3].previous, B);
        assert.equal(events[3].current, '');
        assert.equal(events[3].status, 'none');
        assert.ok(events.every(e => e.external === false));
    });

    test('the legacy onChange hook still runs, and before the page listeners', () => {
        const order = [];
        const s = createWalletSession({ storage: memStorage(), isSame: same, isValid: a => !!a, onChange: () => order.push('global') });
        s.onActiveAccountChange(() => order.push('page'));
        s.select(A, '');
        assert.deepEqual(order, ['global', 'page']);
    });

    test('unsubscribe stops events, is idempotent, and the listener count returns to where it was', () => {
        const { s, events, off } = mkSession();
        const base = s.listenerCount();
        const extra = [];
        const off2 = s.onActiveAccountChange(e => extra.push(e));
        assert.equal(s.listenerCount(), base + 1);
        off2(); off2();
        assert.equal(s.listenerCount(), base);
        s.select(A, '');
        assert.equal(extra.length, 0);
        assert.equal(events.length, 1);
        off();
        s.select(B, '');
        assert.equal(events.length, 1);
    });

    test('a listener that throws does not stop the others', () => {
        const { s, events } = mkSession();
        s.onActiveAccountChange(() => { throw new Error('page bug'); });
        const late = [];
        s.onActiveAccountChange(e => late.push(e));
        assert.doesNotThrow(() => s.select(A, ''));
        assert.equal(events.length, 1);
        assert.equal(late.length, 1);
    });

    test('async restore: restoring while the extension is asked, then none (or connected) with one event each', () => {
        const { s, events } = mkSession();
        s.beginRestore();
        assert.equal(s.getActiveAccount().status, 'restoring');
        assert.equal(events.at(-1).status, 'restoring');
        s.endRestore();
        assert.equal(s.getActiveAccount().status, 'none');
        assert.deepEqual(events.map(e => [e.reason, e.status]), [['restore', 'restoring'], ['restore', 'none']]);

        const w = mkSession();
        w.s.beginRestore();
        w.s.select(A, 'polkadot-js');                  // the auto-pick found one
        w.s.endRestore();
        assert.deepEqual(w.events.map(e => [e.reason, e.status]), [['restore', 'restoring'], ['connect', 'connected']]);
        w.s.disconnect();
        assert.equal(w.s.getActiveAccount().status, 'none', 'a finished restore never leaves "restoring" behind');
    });

    test('restore is not started over a connected account, or after the user chose Disconnect', () => {
        const { s, events } = mkSession();
        s.select(A, '');
        s.beginRestore();
        assert.equal(s.getActiveAccount().status, 'connected');
        s.disconnect();
        const n = events.length;
        s.beginRestore();
        assert.equal(s.getActiveAccount().status, 'none');
        assert.equal(events.length, n);
    });

    test('another tab: syncExternal reports the change once, flagged external, and runs the legacy hook', () => {
        const { s, storage, events, legacy } = mkSession();
        s.select(A, 'polkadot-js');
        storage.setItem('pdex_wallet_address', B);    // the other tab switched
        const c = s.syncExternal();
        assert.equal(c.reason, 'switch-account');
        assert.equal(c.previous, A);
        assert.equal(c.current, B);
        assert.equal(c.external, true);
        assert.equal(legacy.at(-1).reason, 'external');
        assert.equal(s.syncExternal(), null, 'nothing new: no event');
        storage.removeItem('pdex_wallet_address');    // the other tab disconnected
        assert.equal(s.syncExternal().reason, 'disconnect');
        assert.deepEqual(events.map(e => e.reason), ['connect', 'switch-account', 'disconnect']);
    });
});

// ─── 2. lib/wallet-aware ─────────────────────────────────────────────────────

describe('lib/wallet-aware: route scope and latest request', () => {
    test('leave() unsubscribes everything the page registered, once', () => {
        const scope = aware.createRouteScope();
        const { s } = mkSession();
        const base = s.listenerCount();
        const seen = [];
        scope.add(s.onActiveAccountChange(e => seen.push(e)));
        scope.add(s.onActiveAccountChange(e => seen.push(e)));
        assert.equal(s.listenerCount(), base + 2);
        scope.leave();
        assert.equal(s.listenerCount(), base, 'listener leak after the route changed');
        assert.equal(scope.size(), 0);
        s.select(A, '');
        assert.equal(seen.length, 0, 'an update went into a page that was left');
        assert.doesNotThrow(() => scope.leave());
    });

    test('begin() makes the previous request stale and aborts it; cancel() makes the current one stale', () => {
        const latest = aware.createLatest();
        const r1 = latest.begin();
        assert.equal(r1.isCurrent(), true);
        const r2 = latest.begin();
        assert.equal(r1.isCurrent(), false);
        assert.equal(r1.signal.aborted, true);
        assert.equal(r2.isCurrent(), true);
        latest.cancel();
        assert.equal(r2.isCurrent(), false);
        assert.equal(r2.signal.aborted, true);
    });
});

describe('lib/wallet-aware: page decisions', () => {
    const acct = (address, status = address ? 'connected' : 'none') => ({ address, source: '', status });

    test('staking rewards: no address in the URL defaults to the connected wallet, kept out of the URL', () => {
        assert.deepEqual(aware.stakingRewardsPlan({ urlAddress: '', account: acct(A), isSame: same }),
            { mode: 'view', address: A, wallet: A });
    });

    test('staking rewards: nothing connected asks to connect; a restore in progress says so instead', () => {
        assert.equal(aware.stakingRewardsPlan({ urlAddress: '', account: acct(''), isSame: same }).mode, 'connect');
        assert.equal(aware.stakingRewardsPlan({ urlAddress: '', account: acct('', 'restoring'), isSame: same }).mode, 'restoring');
    });

    test('staking rewards: an address in the URL wins for viewing, whatever is connected', () => {
        assert.deepEqual(aware.stakingRewardsPlan({ urlAddress: X, account: acct(A), isSame: same }),
            { mode: 'view', address: X, wallet: A });
        assert.deepEqual(aware.stakingRewardsPlan({ urlAddress: X, account: acct(''), isSame: same }),
            { mode: 'view', address: X, wallet: '' });
    });

    test('a page follows the wallet when it was showing the wallet, and stays on an address the user chose', () => {
        assert.equal(aware.viewFollowsWallet({ viewed: '', previous: A, isSame: same }), true);
        assert.equal(aware.viewFollowsWallet({ viewed: A, previous: A, isSame: same }), true);
        assert.equal(aware.viewFollowsWallet({ viewed: addr(11, 42), previous: A, isSame: same }), true, 'same key, other prefix');
        assert.equal(aware.viewFollowsWallet({ viewed: X, previous: A, isSame: same }), false);
        assert.equal(aware.viewFollowsWallet({ viewed: X, previous: '', isSame: same }), false);
    });

    test('a wallet dashboard follows a change made in another tab only when it showed the old wallet', () => {
        const ch = (previous, current) => ({ previous, current });
        assert.equal(aware.walletRouteAfterChange('wallet/' + A, ch(A, B), same), 'wallet/' + B);
        assert.equal(aware.walletRouteAfterChange('wallet/' + A, ch(A, ''), same), 'wallet');
        assert.equal(aware.walletRouteAfterChange('wallet/' + X, ch(A, B), same), 'wallet/' + X);
        assert.equal(aware.walletRouteAfterChange('wallet', ch(A, B), same), 'wallet');
        assert.equal(aware.walletRouteAfterChange('stake', ch('', B), same), 'stake');
    });

    test('Switch wallet from a page comes back to that page; from a wallet page it does not', () => {
        const isWallet = r => /^(wallet|stake|staking)(\/|$)/.test(r);
        assert.equal(aware.pickerTarget('staking-rewards/' + A, '', isWallet), 'wallet?switch=1&returnTo=' + encodeURIComponent('/staking-rewards/' + A));
        assert.equal(aware.pickerTarget('treasury', '?tab=spends', isWallet), 'wallet?switch=1&returnTo=' + encodeURIComponent('/treasury?tab=spends'));
        assert.equal(aware.pickerTarget('home', '', isWallet), 'wallet?switch=1&returnTo=%2F');
        assert.equal(aware.pickerTarget('wallet/' + A, '', isWallet), 'wallet?switch=1');
    });

    test('Switch wallet from /staking-rewards/<own wallet> returns to the bare page, so it shows the NEW wallet', () => {
        const isWallet = r => /^(wallet|stake|staking)(\/|$)/.test(r);
        assert.equal(aware.pickerTarget('staking-rewards/' + A, '', isWallet, { wallet: A, isSame: same }), 'wallet?switch=1&returnTo=%2Fstaking-rewards',
            'returning to /staking-rewards/<old> would pin the old account as if the user had typed it');
        assert.equal(aware.pickerTarget('staking-rewards/' + X, '', isWallet, { wallet: A, isSame: same }), 'wallet?switch=1&returnTo=' + encodeURIComponent('/staking-rewards/' + X));
    });

    test('pages that manage the wallet themselves are skipped by the global re-render', () => {
        assert.equal(aware.selfManagedRoute('staking-rewards'), true);
        assert.equal(aware.selfManagedRoute('staking-rewards/' + A), true);
        assert.equal(aware.selfManagedRoute('staking'), false);
        assert.equal(aware.selfManagedRoute('treasury'), false);
    });

    test('the "Viewing X; your wallet is Y. Show mine" note: only when they differ, escaped, linking to the wallet', () => {
        const h = { isSame: same, esc: escapeHtml, shortAddr: short, hrefFor: a => '/staking-rewards/' + encodeURIComponent(a) };
        assert.equal(aware.viewingBannerHtml({ viewing: A, wallet: A, ...h }), '');
        assert.equal(aware.viewingBannerHtml({ viewing: A, wallet: '', ...h }), '');
        const html = aware.viewingBannerHtml({ viewing: X, wallet: A, ...h });
        assert.match(html, /Viewing/);
        assert.match(html, /your wallet is/);
        assert.ok(html.includes(short(X)) && html.includes(short(A)));
        assert.ok(html.includes(`href="/staking-rewards/${encodeURIComponent(A)}"`));
        assert.match(html, />Show mine</);
        const evil = aware.viewingBannerHtml({ viewing: '<img onerror=x>', wallet: A, ...h, isSame: () => false, shortAddr: a => a });
        assert.ok(!evil.includes('<img'), 'an address from the URL is escaped');
    });

    test('the connect note opens the global connector and comes back to the page', () => {
        const html = aware.connectNoteHtml({ returnTo: '/staking-rewards', what: 'your staking rewards', esc: escapeHtml });
        assert.ok(html.includes('href="/wallet?returnTo=%2Fstaking-rewards"'));
        assert.match(html, /your staking rewards/);
        assert.match(aware.restoringNoteHtml(), /Checking/);
    });
});

describe('lib/wallet-aware: signing modals close when the wallet changes', () => {
    function page(t) {
        const window = new Window({ url: 'https://explorer.test/', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
        t.after(() => window.happyDOM.close());
        window.document.write(HTML);
        return window.document;
    }

    test('every open signing modal is closed, a non-signing one is left alone', (t) => {
        const doc = page(t);
        for (const id of ['stake-modal', 'referendum-vote-modal', 'send-modal', 'email-subscribe-modal']) doc.getElementById(id).style.display = 'flex';
        const closed = aware.closeSigningModals(doc);
        assert.deepEqual(closed.sort(), ['referendum-vote-modal', 'send-modal', 'stake-modal']);
        for (const id of ['stake-modal', 'referendum-vote-modal', 'send-modal']) assert.equal(doc.getElementById(id).style.display, 'none');
        assert.equal(doc.getElementById('email-subscribe-modal').style.display, 'flex');
        assert.deepEqual(aware.closeSigningModals(doc), [], 'nothing open: nothing closed');
    });

    test('guard: every .modal in index.html is classified as signing or not, and every listed id exists', (t) => {
        const doc = page(t);
        const ids = Array.from(doc.querySelectorAll('.modal')).map(m => m.id);
        assert.ok(ids.length >= 10, 'found the modals');
        const unclassified = ids.filter(id => !aware.SIGNING_MODAL_IDS.includes(id) && !aware.NON_SIGNING_MODAL_IDS.includes(id));
        assert.deepEqual(unclassified, [], 'a new modal must be added to SIGNING_MODAL_IDS (closes on a wallet change) or NON_SIGNING_MODAL_IDS in lib/wallet-aware.js: ' + unclassified.join(', '));
        const missing = [...aware.SIGNING_MODAL_IDS, ...aware.NON_SIGNING_MODAL_IDS].filter(id => !doc.getElementById(id));
        assert.deepEqual(missing, [], 'listed but not in index.html: ' + missing.join(', '));
    });

    test('a missing document or element is not a crash', () => {
        assert.deepEqual(aware.closeSigningModals(null), []);
        assert.deepEqual(aware.closeSigningModals({ getElementById: () => null }), []);
    });
});

// ─── 3. the real staking-rewards page ────────────────────────────────────────

const LIFTED = ['toPolkadexAddress', 'isSameAddress', 'readRouteFromLocation', 'initStakingRewardsPage', 'stakingRewardsViewed',
    'showStakingRewardsFor', 'renderStakingRewardsNote', 'onStakingRewardsWalletChange', 'fetchStakingRewards', 'submitStakingSearch'];
function lift(name) {
    const at = SCRIPT.indexOf(`function ${name}(`);
    assert.ok(at !== -1, 'script.js has no function ' + name);
    const pre = SCRIPT.slice(Math.max(0, at - 6), at) === 'async ' ? 'async ' : '';
    return pre + bodyOf(SCRIPT, name) + '\n';
}

function stakingWorld(t, { path = '/staking-rewards', connected = '', source = '' } = {}) {
    const window = new Window({ url: 'https://explorer.test' + path, settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    t.after(() => window.happyDOM.close());
    const document = window.document;
    document.write(HTML);
    const storage = memStorage();
    if (connected) { storage.setItem('pdex_wallet_address', connected); if (source) storage.setItem('pdex_wallet_source', source); }
    const pending = [];
    const log = { fetches: [], renders: [], navigations: [] };
    const ctx = {
        console, Promise, Object, JSON, Array, Map, Set, Error, String, Number, URLSearchParams, encodeURIComponent, decodeURIComponent,
        setTimeout, clearTimeout,
        document, window: { location: window.location, injectedWeb3: undefined }, history: window.history,
        encodeAddress, decodeAddress, POLKADEX_SS58: 88, isValidPolkadexAddress,
        createWalletSession, ...aware,
        storage, stakingEscapeHtml: escapeHtml, stakingShortAddress: short, safeRouteToken: () => '',
        loadStakingIndexStatus() {},
        renderStakingRewards(data) { const el = document.getElementById('staking-rewards-results'); el.innerHTML = 'REWARDS:' + data.address; log.renders.push(data.address); },
        navigateTo(target) { log.navigations.push(target); window.history.pushState(null, '', '/' + target); ctx.routeTo(target); },
        fetch(url, init) {
            log.fetches.push(String(url));
            return new Promise((resolve, reject) => {
                const p = { url: String(url), signal: init && init.signal, resolve: (data) => resolve({ ok: true, status: 200, json: async () => data }) };
                if (p.signal) p.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
                pending.push(p);
            });
        }
    };
    vm.createContext(ctx);
    const prelude = `
        let stakingRewardsData = null, stakingRewardFilter = 'all', stakingUnclaimedPolls = 0;
        const walletSession = createWalletSession({ storage, toAddress: toPolkadexAddress, isSame: isSameAddress, isValid: isValidPolkadexAddress });
        const pageScope = createRouteScope();
        const stakingRewardsLatest = createLatest();
        function routeTo(target) {
            pageScope.leave();
            const t = String(target).split('?')[0];
            if (t === 'staking-rewards' || t.startsWith('staking-rewards/')) initStakingRewardsPage(t.startsWith('staking-rewards/') ? t.slice('staking-rewards/'.length) : null);
        }
    `;
    vm.runInContext(prelude + LIFTED.map(lift).join(''), ctx);
    const run = (src) => vm.runInContext(src, ctx);
    const settle = () => new Promise(r => setTimeout(r, 20));
    return {
        document, window, log, pending, ctx, run, settle,
        session: run('walletSession'), scope: run('pageScope'),
        visit: async (p) => { window.history.pushState(null, '', p); run('routeTo')(run('readRouteFromLocation')()); await settle(); },
        input: () => document.getElementById('staking-address-input').value,
        note: () => (document.getElementById('staking-rewards-wallet-note') || { innerHTML: '' }).innerHTML,
        results: () => document.getElementById('staking-rewards-results'),
        respond: async (i, address) => { pending[i].resolve({ address, claimed: [], unclaimed: [] }); await settle(); },
        data: () => run('stakingRewardsData')
    };
}

describe('staking rewards page follows the connected wallet (real script.js functions)', () => {
    test('index.html has a place for the wallet note on the page', () => {
        assert.match(HTML, /id="staking-rewards-wallet-note"/);
    });

    test('opened with no address: loads the connected wallet and leaves the URL bare, so a copied link does not pin it', async (t) => {
        const w = stakingWorld(t, { connected: A });
        await w.visit('/staking-rewards');
        assert.deepEqual(w.log.fetches, ['/api/staking-rewards/' + encodeURIComponent(A)]);
        assert.equal(w.window.location.pathname, '/staking-rewards', 'the wallet\'s address was written into the URL');
        assert.equal(w.input(), A);
        await w.respond(0, A);
        assert.equal(w.results().innerHTML, 'REWARDS:' + A);
        assert.equal(w.note(), '', 'no "viewing someone else" note for your own wallet');
    });

    test('opened with no address and nothing connected: a connect prompt that opens the global connector, no request', async (t) => {
        const w = stakingWorld(t);
        await w.visit('/staking-rewards');
        assert.equal(w.log.fetches.length, 0);
        assert.ok(w.note().includes('href="/wallet?returnTo=%2Fstaking-rewards"'), w.note());
        assert.equal(w.results().style.display, 'none');
    });

    test('a restore in progress shows "checking", then loads the account it found', async (t) => {
        const w = stakingWorld(t);
        w.session.beginRestore();
        await w.visit('/staking-rewards');
        assert.match(w.note(), /Checking/);
        assert.equal(w.log.fetches.length, 0);
        w.session.select(A, 'polkadot-js');
        w.session.endRestore();
        await w.settle();
        assert.deepEqual(w.log.fetches, ['/api/staking-rewards/' + encodeURIComponent(A)]);
        assert.equal(w.window.location.pathname, '/staking-rewards');
    });

    test('switching wallets reloads for the new account; the URL stays bare', async (t) => {
        const w = stakingWorld(t, { connected: A });
        await w.visit('/staking-rewards');
        await w.respond(0, A);
        w.session.select(B, 'polkadot-js');
        await w.settle();
        assert.equal(w.log.fetches.at(-1), '/api/staking-rewards/' + encodeURIComponent(B));
        assert.equal(w.window.location.pathname, '/staking-rewards');
        assert.equal(w.input(), B);
        await w.respond(1, B);
        assert.equal(w.results().innerHTML, 'REWARDS:' + B);
    });

    test('an old link to /staking-rewards/<own address> still follows a switch, back to the bare page', async (t) => {
        const w = stakingWorld(t, { connected: A, path: '/staking-rewards/' + A });
        await w.visit('/staking-rewards/' + A);
        w.session.select(B, '');
        await w.settle();
        assert.equal(w.log.fetches.at(-1), '/api/staking-rewards/' + encodeURIComponent(B));
        assert.equal(w.window.location.pathname, '/staking-rewards');
    });

    test('disconnect clears the account\'s rewards and shows the connect prompt', async (t) => {
        const w = stakingWorld(t, { connected: A });
        await w.visit('/staking-rewards');
        await w.respond(0, A);
        w.session.disconnect();
        await w.settle();
        assert.equal(w.data(), null);
        assert.equal(w.results().style.display, 'none');
        assert.ok(!w.results().innerHTML.includes(A), 'the old account\'s rewards are still on screen');
        assert.equal(w.input(), '');
        assert.match(w.note(), /returnTo=%2Fstaking-rewards/);
        assert.equal(w.window.location.pathname, '/staking-rewards');
    });

    test('an explicit address in the URL wins for viewing; the note says whose wallet is connected and offers Show mine', async (t) => {
        const w = stakingWorld(t, { connected: A, path: '/staking-rewards/' + X });
        await w.visit('/staking-rewards/' + X);
        assert.deepEqual(w.log.fetches, ['/api/staking-rewards/' + encodeURIComponent(X)]);
        assert.ok(w.note().includes(short(X)) && w.note().includes(short(A)), w.note());
        assert.ok(w.note().includes('href="/staking-rewards"'), 'Show mine pins the wallet\'s address: ' + w.note());

        w.session.select(B, '');                      // switching does not take the page off X
        await w.settle();
        assert.equal(w.log.fetches.length, 1, 'refetched an address the user chose');
        assert.equal(w.window.location.pathname, '/staking-rewards/' + X);
        assert.ok(w.note().includes(short(B)), 'the note names the new wallet');

        w.session.disconnect();                       // public data stays; the note goes
        await w.settle();
        assert.equal(w.note(), '');
        assert.equal(w.window.location.pathname, '/staking-rewards/' + X);
    });

    test('a typed address goes into the URL, even the wallet\'s own', async (t) => {
        const w = stakingWorld(t, { connected: A });
        await w.visit('/staking-rewards');
        w.document.getElementById('staking-address-input').value = A;
        w.run('submitStakingSearch')();
        await w.settle();
        assert.equal(w.window.location.pathname, '/staking-rewards/' + A);
    });

    test('a typed search for another address is explicit: it is not undone by a later switch', async (t) => {
        const w = stakingWorld(t, { connected: A });
        await w.visit('/staking-rewards');
        w.document.getElementById('staking-address-input').value = X;
        w.run('submitStakingSearch')();
        await w.settle();
        assert.equal(w.window.location.pathname, '/staking-rewards/' + X);
        w.session.select(B, '');
        await w.settle();
        assert.equal(w.window.location.pathname, '/staking-rewards/' + X);
    });

    test('a response for the old account that lands after a switch is dropped, and its request aborted', async (t) => {
        const w = stakingWorld(t, { connected: A });
        await w.visit('/staking-rewards');
        w.session.select(B, '');
        await w.settle();
        assert.equal(w.pending[0].signal.aborted, true, 'the old account\'s request was not cancelled');
        await w.respond(1, B);
        w.pending[0].resolve({ address: A, claimed: [], unclaimed: [] });   // late, even though aborted
        await w.settle();
        assert.equal(w.data().address, B);
        assert.deepEqual(w.log.renders, [B]);
    });

    test('leaving the page unsubscribes it: no listener leak, no request and no paint for a page that is gone', async (t) => {
        const w = stakingWorld(t, { connected: A });
        const base = w.session.listenerCount();
        await w.visit('/staking-rewards');
        assert.equal(w.session.listenerCount(), base + 1);
        await w.visit('/treasury');
        assert.equal(w.session.listenerCount(), base, 'listener leak after a route change');
        assert.equal(w.pending[0].signal.aborted, true, 'in-flight request survived leaving the page');
        w.session.select(B, '');
        await w.settle();
        assert.equal(w.log.fetches.length, 1, 'a page that was left reacted to the switch');
        w.pending[0].resolve({ address: A, claimed: [], unclaimed: [] });
        await w.settle();
        assert.deepEqual(w.log.renders, []);
        await w.visit('/staking-rewards');            // and back: exactly one listener again
        await w.visit('/staking-rewards');
        assert.equal(w.session.listenerCount(), base + 1);
    });
});

// ─── 4. wiring in script.js (the bundle has no export surface) ───────────────

describe('script.js wiring', () => {
    const fn = (name) => bodyOf(SCRIPT, name);

    test('the route scope is left on every route change, before the new page mounts', () => {
        assert.match(SCRIPT, /const pageScope = createRouteScope\(\);/);
        const r = fn('routeTo');
        assert.ok(r.indexOf('pageScope.leave();') !== -1 && r.indexOf('pageScope.leave();') < r.indexOf('initStakingRewardsPage('));
    });

    test('a wallet change closes every open signing modal and leaves self-managed pages to themselves', () => {
        const body = fn('onWalletChanged');
        assert.match(body, /closeSigningModals\(document\);/);
        assert.match(body, /!selfManagedRoute\(here\)/);
    });

    test('another tab\'s change goes through the session, and a wallet dashboard of the old wallet follows it', () => {
        assert.match(SCRIPT, /window\.addEventListener\('storage', \(e\) => \{[\s\S]{0,300}walletSession\.syncExternal\(\)[\s\S]{0,300}walletRouteAfterChange\(/);
    });

    test('the auto-pick is reported as a restore, so pages can tell "checking" from "none"', () => {
        const body = fn('tryAutoSelectFirstWallet');
        assert.match(body, /walletSession\.beginRestore\(\)/);
        assert.match(body, /finally \{[\s\S]*walletSession\.endRestore\(\)/);
    });

    test('Switch wallet comes back to the page it was opened from, and Keep honours that too', () => {
        assert.match(fn('openWalletPicker'), /pickerTarget\(readRouteFromLocation\(\), window\.location\.search, isWalletRoute, \{ wallet: getStoredWallet\(\), isSame: isSameAddress \}\)/);
        assert.match(fn('renderWalletConnectPanel'), /stay\.addEventListener\('click', \(\) => navigateTo\(\(readSafeReturnTo\(\) \|\| ''\)\.replace/);
    });

    test('the wallet dashboard of another address says whose wallet is connected and offers Show mine', () => {
        assert.match(fn('renderWalletDashboard'), /viewingBannerHtml\(\{ viewing: data\.address, wallet: getStoredWallet\(\)/);
    });

    test('script.js stays under its 15,000-line ceiling', () => {
        assert.ok(SCRIPT.split('\n').length <= 15000, 'script.js is ' + SCRIPT.split('\n').length + ' lines');
    });
});

// ─── 5. the real wallet functions (test/helpers/wallet-world.js) ─────────────

describe('wallet switching from another page (real script.js wallet functions)', async () => {
    const { makeProfile, openTab, fakeExtension, addr: wAddr } = await import('./helpers/wallet-world.js');
    const { safeReturnPath } = await import('../lib/safe-return.js');
    const ext = () => fakeExtension('polkadot-js', [{ address: wAddr(1, 42), name: 'One' }, { address: wAddr(2, 42), name: 'Two' }]);
    const W1 = wAddr(1), W2 = wAddr(2);

    test('the staking-rewards page is not re-rendered by the global handler; it follows the wallet itself', async () => {
        const profile = makeProfile({ extensions: [ext()] });
        profile.local.setItem('pdex_wallet_address', W1);
        const tab = openTab(profile, { path: '/staking-rewards/' + W1 });
        tab.log.routes.length = 0;
        tab.fn('onWalletChanged')();
        assert.ok(!tab.log.routes.includes('staking-rewards/' + W1), 'the page was re-entered with the OLD address and would stop following');
        const council = openTab(profile, { path: '/council' });
        council.log.routes.length = 0;
        council.fn('onWalletChanged')();
        assert.ok(council.log.routes.includes('council'), 'other pages still re-render for the new wallet');
    });

    test('Switch wallet opened from a page returns there with the new account', async () => {
        const profile = makeProfile({ extensions: [ext()] });
        profile.local.setItem('pdex_wallet_address', W1);
        const tab = openTab(profile, { path: '/staking-rewards/' + W1 });   // an old link with the wallet's address
        tab.ctx.safeReturnPath = safeReturnPath;
        tab.fn('openWalletPicker')();
        await tab.settle();
        assert.equal(tab.ctx.window.location.pathname, '/wallet');
        assert.match(tab.ctx.window.location.search, /switch=1/);
        assert.match(tab.ctx.window.location.search, /returnTo=%2Fstaking-rewards/);
        tab.fn('selectWallet')(W2, 'polkadot-js');
        await tab.settle();
        assert.equal(tab.ctx.window.location.pathname, '/staking-rewards');
        assert.equal(tab.read('pdex_wallet_address'), W2);
    });
});
