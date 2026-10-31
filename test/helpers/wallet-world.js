// A browser profile for the wallet tests: a localStorage that survives "reloads",
// fake wallet extensions on window.injectedWeb3 (polkadot-js, talisman,
// subwallet-js), and the REAL wallet functions from script.js running against
// them.
//
// Why not jsdom: it is not a dependency and the suite runs offline. Why not
// re-implement the logic here: the bug was in what script.js does, so the test
// has to run script.js. Functions are lifted by name (as other tests in this
// suite do) and run in a vm context whose globals are the fakes below. A name
// that does not exist in script.js is skipped, so the same world runs against
// the code before and after the fix - which is how the regression tests were
// proved to fail first.
//
// Addresses are synthetic: 32 bytes of one repeated value, SS58-encoded. They
// belong to no one.

import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import { bodyOf } from './source.js';
import { isValidPolkadexAddress } from '../../lib/wallet-safety.js';
import { createWalletSession, pickSigningAccount, orderSources, WALLET_KEYS } from '../../lib/wallet-session.js';
import { buildAccountListHtml, buildCurrentBannerHtml, buildMissingAccountHelpHtml, sourceLabel } from '../../lib/wallet-picker.js';
import { escapeHtml } from '../../lib/html-escape.js';

const SCRIPT = readFileSync(new URL('../../script.js', import.meta.url), 'utf8');

// Synthetic accounts. addr(1, 88) and addr(1, 42) are the SAME key in two encodings.
export const addr = (n, prefix = 88) => encodeAddress(new Uint8Array(32).fill(n), prefix);
export const A = addr(1), B = addr(2), C = addr(3);

export function memStorage() {
    const m = new Map();
    return {
        m,
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); },
        clear: () => m.clear(),
        get length() { return m.size; },
        key: (i) => [...m.keys()][i] ?? null
    };
}

// One wallet extension. `accounts` is mutable: push to it to model the user
// allowing another account for this site, then refresh the picker.
export function fakeExtension(key, accounts) {
    const ext = {
        key, accounts, enableCalls: 0, signCalls: [],
        // One signer per extension, tagged with its key, so a test can tell
        // WHICH extension the page chose to sign with.
        signer: { extKey: key, signRaw: async (req) => { ext.signCalls.push(req); return { signature: '0x01' }; } },
        provider: {
            enable: async () => {
                ext.enableCalls++;
                return { accounts: { get: async () => ext.accounts.map(a => ({ ...a })) }, signer: ext.signer };
            }
        }
    };
    return ext;
}

// A minimal element. innerHTML is real text; ids inside it are findable and the
// account buttons inside it can be "clicked" by data-address.
function el(id) {
    const e = {
        id, listeners: {}, style: {}, attrs: {}, textContent: '', _html: '', _kids: new Map(), value: '',
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
        async click() { for (const fn of this.listeners.click || []) await fn({ preventDefault() {}, stopPropagation() {} }); },
        focus() {}, select() {}, remove() {}, prepend() {},
        querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
        querySelectorAll(sel) { return queryIn(this, sel); }
    };
    Object.defineProperty(e, 'innerHTML', {
        get() { return this._html; },
        set(v) { this._html = String(v); this._kids = new Map(); }
    });
    return e;
}

// Elements inside an element's markup, by id or by one class. Cached per
// innerHTML generation so listeners attached to them stay put.
function queryIn(parent, sel) {
    const out = [];
    const make = (k, attrs) => {
        if (!parent._kids.has(k)) { const c = el(attrs.id || ''); Object.assign(c.attrs, attrs); parent._kids.set(k, c); }
        return parent._kids.get(k);
    };
    if (sel.startsWith('#')) {
        const id = sel.slice(1);
        if (parent._html.includes(`id="${id}"`)) out.push(make('#' + id, { id }));
    } else if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        const re = /<button\b[^>]*>/g;
        let m, i = 0;
        while ((m = re.exec(parent._html))) {
            const tag = m[0];
            const c = /class="([^"]*)"/.exec(tag);
            if (!c || !c[1].split(/\s+/).includes(cls)) continue;
            const attrs = {};
            for (const x of tag.matchAll(/(data-[a-z-]+)="([^"]*)"/g)) attrs[x[1]] = x[2].replace(/&amp;/g, '&');
            out.push(make('.' + cls + ':' + (i++), attrs));
        }
    }
    return out;
}

const LIFTED = [
    'toPolkadexAddress', 'isSameAddress', 'getStoredWallet', 'isWalletRoute', 'onWalletChanged', 'refreshConnectWalletButton',
    'getInjectedAccounts', 'connectWallet', 'openWalletPicker', 'selectWallet', 'revokeDiscussSession', 'disconnectWallet',
    'initWalletPage', 'tryAutoSelectFirstWallet', 'renderWalletConnectPanel', 'invalidateWalletFetch', 'fetchWalletDashboard',
    'getDiscussSession', 'getWalletSigner', 'resolveWalletSigner', 'navigateTo', 'readSafeReturnTo',
    // present only before the fix:
    'setStoredWallet', 'getLastUsedAddress', 'setLastUsedAddress', 'consumeSkipAutoPickFlag'
];

function lift(name) {
    const at = SCRIPT.indexOf(`function ${name}(`);
    if (at === -1) return '';
    const pre = SCRIPT.slice(Math.max(0, at - 6), at) === 'async ' ? 'async ' : '';
    return pre + bodyOf(SCRIPT, name) + '\n';
}

// openTab(profile) is a fresh page load: new sessionStorage, new module state,
// the profile's localStorage and extensions. Several tabs share one profile.
export function makeProfile({ extensions = [] } = {}) {
    return { local: memStorage(), extensions, tabs: [], logoutCalls: [] };
}

export function openTab(profile, { path = '/wallet', search = '' } = {}) {
    const session = memStorage();
    const root = el('wallet-dashboard');
    const log = { renders: [], routes: [], democracyRestarts: 0, govAccountChanged: 0, fetches: [], panelRenders: 0 };
    const pending = [];   // dashboard fetches the test resolves by hand
    const header = {};
    for (const id of ['connect-wallet-btn', 'connect-wallet-label', 'connect-wallet-sub', 'disconnect-wallet-btn', 'nav-my-account', 'wallet-menu-who']) header[id] = el(id);

    const ctx = {
        console, Promise, Object, JSON, URLSearchParams, Array, Map, Set, setTimeout, clearTimeout, setInterval, clearInterval, encodeURIComponent, String, Number,
        encodeAddress, decodeAddress, isValidPolkadexAddress, createWalletSession, pickSigningAccount, orderSources, WALLET_KEYS,
        buildAccountListHtml, buildCurrentBannerHtml, buildMissingAccountHelpHtml, sourceLabel,
        multisigUI: { mountAccounts() {} },
        POLKADEX_SS58: 88,
        localStorage: profile.local, sessionStorage: session,
        navigator: { userAgent: 'test', clipboard: { writeText: async () => {} } },
        location: { href: 'https://explorer.test/wallet' },
        history: {
            pushState(_s, _t, url) { setLoc(url); }, replaceState(_s, _t, url) { setLoc(url); }
        },
        window: { location: { pathname: path, search, hash: '', origin: 'https://explorer.test' }, injectedWeb3: undefined },
        document: {
            getElementById: (id) => (id === 'wallet-dashboard' ? root : (header[id] || findIn(root, id))),
            createElement: () => el('x')
        },
        spaNavDepth: 0,
        stakingEscapeHtml: escapeHtml,
        stakingShortAddress: (a) => String(a).slice(0, 6) + '...' + String(a).slice(-4),
        helpIcon: () => '', detectInjectedWalletEnv: () => ({ id: 'test', name: 'Test wallet' }), isMobileDevice: () => false,
        renderMobileWalletCards: () => '', updateSeoMeta() {}, setRouteJsonLd() {}, buildWalletConnectJsonLd: () => ({}),
        safeReturnPath: () => null, safeRouteToken: () => '',
        readRouteFromLocation: () => (ctx.window.location.pathname || '/').replace(/^\/+/, '').replace(/\/+$/, '') || 'home',
        democracyView: { restart() { log.democracyRestarts++; } },
        govDetailPage: { accountChanged() { log.govAccountChanged++; } },
        // The dashboard renderer and its helpers: stubs that leave a visible mark.
        renderWalletDashboard(data) { root.innerHTML = 'DASHBOARD:' + data.address; log.renders.push(data.address); },
        renderWalletLoading() { root.innerHTML = 'LOADING'; return () => {}; },
        readWalletCache: () => null, writeWalletCache() {}, showWalletStaleBanner() {}, clearWalletStaleBanner() {},
        clearWalletActionBlock() {}, disableWalletActions() {}, maybeRunWalletEntryIntent() {}, repaintWalletPriceCard() {}, renderWalletAprCard() {},
        walletAprData: null, currentWalletData: null,
        // Router: what routeTo does with the wallet routes, recorded for the rest.
        routeTo(target) {
            const t = String(target).split('?')[0];
            log.routes.push(t);
            if (t === 'wallet' || t === 'stake') ctx.initWalletPage('');
            else if (t.startsWith('wallet/')) ctx.initWalletPage(t.slice('wallet/'.length));
        },
        fetch: (url, init) => {
            url = String(url);
            log.fetches.push({ url, init });
            if (url.startsWith('/api/wallet/')) return new Promise((resolve) => pending.push({ url, resolve: (data) => resolve({ ok: true, status: 200, json: async () => data }) }));
            if (url === '/api/auth/logout') { profile.logoutCalls.push((init && init.headers && init.headers.Authorization) || ''); return Promise.resolve({ ok: true }); }
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ history: [], configured: false }) });
        }
    };
    function setLoc(url) {
        const [p, q] = String(url).split('?');
        ctx.window.location.pathname = p; ctx.window.location.search = q ? '?' + q : '';
    }
    // An id anywhere in the pane: in its own markup, or in the markup of an
    // element inside it that the page has since written into (the account list).
    function findIn(node, id) {
        const own = queryIn(node, '#' + id)[0];
        if (own) return own;
        for (const kid of node._kids.values()) { const hit = kid._html ? findIn(kid, id) : null; if (hit) return hit; }
        return null;
    }

    // injectedWeb3 reflects the profile's extensions as they are NOW.
    Object.defineProperty(ctx.window, 'injectedWeb3', {
        get: () => (profile.extensions.length ? Object.fromEntries(profile.extensions.map(e => [e.key, e.provider])) : undefined)
    });

    vm.createContext(ctx);
    const prelude = `
        const DISCUSS_TOKEN_KEY = 'pdex_discuss_session';
        const WALLET_STORAGE_KEY = 'pdex_wallet_address', LAST_USED_ADDRESS_KEY = 'pdex_last_used_wallet_address', SKIP_AUTO_PICK_KEY = 'pdex_skip_wallet_auto_pick';
        let walletActionsBlockedReason = null, walletEntryIntent = null, _walletSigningRecheckTimer = null, walletFetchGen = 0, walletMenu = null;
        const walletSession = createWalletSession({ storage: localStorage, toAddress: toPolkadexAddress, isSame: isSameAddress, isValid: isValidPolkadexAddress,
            revokeDiscuss: () => revokeDiscussSession(), onChange: () => onWalletChanged() });
    `;
    // `walletSession` and friends must exist before the lifted functions run, but
    // function declarations hoist, so one script is enough.
    const src = prelude + LIFTED.map(lift).join('');
    vm.runInContext(src, ctx);
    const call = (fn, ...args) => vm.runInContext(`${fn}`, ctx)(...args);
    const tab = {
        ctx, root, log, pending, header, session, profile,
        fn: (name) => vm.runInContext(name, ctx),
        // The sidebar / bookmark / reload path: navigate then settle async work.
        async visit(p) { setLoc(p); const route = ctx.readRouteFromLocation(); ctx.routeTo(route); await settle(); },
        async settle() { await settle(); },
        read: (k) => profile.local.getItem(k),
        panelHtml: () => root.innerHTML,
        accountButtons: () => root.querySelector('#wallet-accounts') ? root.querySelector('#wallet-accounts').querySelectorAll('.wallet-account-btn') : [],
        call
    };
    profile.tabs.push(tab);
    return tab;
}

export function settle(ms = 60) { return new Promise(r => setTimeout(r, ms)); }
