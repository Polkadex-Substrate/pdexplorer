// The whole explorer, loaded the way a browser loads it: index.html's body in a
// happy-dom document, then the REAL script.js imported as a module, so every
// top-level statement runs in its real order. One page load per child process
// (globals are per process), driven by a scenario and reported as JSON.
//
// Used by test/header-wallet-state.test.js:  node test/helpers/full-page.js '<scenario json>'
//
// scenario: {
//   path: 'wallet/<addr>'            the URL the page is opened at
//   seed: { key: value }             localStorage before the page loads
//   wallets: { key: [address] }      fake extensions on window.injectedWeb3; enable() is counted
//   refuseWalletWrites: true         storage throws on pdex_wallet* / pdex_last* writes and
//                                    removals once seeded (a full quota, or a private window)
//   hang: [key]                      those extensions never answer enable() (the auto-pick stays 'restoring')
//   steps: [ { click: selector, nth }, { event: 'visibilitychange' }, { storage: { key: value|null } },
//            { go: '/path' } (an SPA navigation: pushState, then popstate) ]
// }
// Prints one line: RESULT {"first": header, "steps": [header...], "final": {...}}.
// Nothing reaches the network: fetch is a stub, WebSocket never opens, and the
// node handshake budget (WS_HANDSHAKE_BUDGET_MS) is cut to zero so routing runs at once.

import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';

const scenario = JSON.parse(process.argv[2] || '{}');
const SCRIPT_URL = new URL('../../script.js', import.meta.url);
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>') + 7).replace(/<script[\s\S]*?<\/script>/g, '');
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const errors = [];
process.on('uncaughtException', e => errors.push(String(e && e.stack || e).split('\n')[0]));
process.on('unhandledRejection', e => errors.push(String(e && e.stack || e).split('\n')[0]));

const win = new Window({ url: 'http://localhost/' + (scenario.path || ''), width: 1280, height: 900 });
win.document.body.outerHTML = body;

// localStorage is a plain Storage-shaped object (happy-dom's caches its methods,
// so they cannot be made to refuse a write). With refuseWalletWrites, writes and
// removals of the wallet keys throw as a full quota does, from page load on.
const quota = () => { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; return e; };
function makeStorage(refuse) {
    const m = new Map();
    const refused = (k) => refuse.on && /^pdex_(wallet|last)/.test(String(k));
    return {
        get length() { return m.size; },
        key: (i) => Array.from(m.keys())[i] ?? null,
        getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
        setItem: (k, v) => { if (refused(k)) throw quota(); m.set(String(k), String(v)); },
        removeItem: (k) => { if (refused(k)) throw quota(); m.delete(String(k)); },
        clear: () => m.clear()
    };
}
const refuse = { on: false };
const local = makeStorage(refuse), session = makeStorage({ on: false });
Object.defineProperty(win, 'localStorage', { value: local, configurable: true });
Object.defineProperty(win, 'sessionStorage', { value: session, configurable: true });
for (const [k, v] of Object.entries(scenario.seed || {})) local.setItem(k, v);
refuse.on = !!scenario.refuseWalletWrites;

const g = globalThis;
for (const k of ['window', 'document', 'localStorage', 'sessionStorage', 'location', 'history', 'HTMLElement', 'Element', 'Node',
    'CustomEvent', 'Event', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'IntersectionObserver', 'ResizeObserver', 'DOMParser', 'matchMedia', 'innerWidth', 'innerHeight', 'scrollTo', 'HTMLCanvasElement', 'Image', 'screen', 'navigator']) {
    try { Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true }); } catch (e) { /* not in this happy-dom */ }
}
g.WebSocket = class { constructor() {} close() {} send() {} };
const walletPayload = (address) => ({ address, identity: 'Test identity', balance: { total: '0', free: '0' }, staking: {}, rewards: {}, network: {}, recentTransactions: [] });
g.fetch = win.fetch = async (url) => {
    const m = /\/api\/wallet\/([^/?]+)/.exec(String(url));
    const data = m ? walletPayload(decodeURIComponent(m[1])) : {};
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data), headers: new Map() };
};

const enables = {};
const injected = {};
for (const [key, list] of Object.entries(scenario.wallets || {})) {
    enables[key] = 0;
    const hang = (scenario.hang || []).includes(key);
    injected[key] = { enable: async () => { enables[key]++; if (hang) await new Promise(() => {}); return { accounts: { get: async () => list.map((address, i) => ({ address, name: key + ' ' + i })) }, signer: {} }; } };
}
win.injectedWeb3 = injected;

const header = () => {
    const btn = document.getElementById('connect-wallet-btn');
    return {
        label: document.getElementById('connect-wallet-label').textContent,
        sub: document.getElementById('connect-wallet-sub').textContent,
        connectedClass: btn.classList.contains('is-connected'),
        navTitle: document.getElementById('nav-my-account').title,
        enables: { ...enables }
    };
};
// The dashboard's "whose account is this" slot and the controls beside it.
const dashboard = () => {
    const note = document.querySelector('#wallet-dashboard .wallet-viewing-note.is-readonly');
    const banner = document.querySelector('#wallet-dashboard .wallet-viewing-note:not(.is-readonly)');
    const sw = document.getElementById('wallet-switch-btn');
    return {
        note: note ? note.textContent.replace(/\s+/g, ' ').trim() : null,
        noteHtml: note ? note.outerHTML : null,
        banner: banner ? banner.textContent.replace(/\s+/g, ' ').trim() : null,
        switchShown: !!sw && !sw.hidden,
        switchPresent: !!sw,
        title: document.title
    };
};

// Cut the node handshake race (WS_HANDSHAKE_BUDGET_MS, 6 s) to zero while
// script.js loads; that timer is created synchronously in init().
const realSetTimeout = g.setTimeout;
g.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 6000 ? 0 : ms, ...a);
await import(SCRIPT_URL.href);
g.setTimeout = realSetTimeout;
const first = header();   // after every top-level statement, before any await resolved

await tick(30);
const steps = [];
for (const step of scenario.steps || []) {
    if (step.click) {
        const el = document.querySelectorAll(step.click)[step.nth || 0];
        if (!el) errors.push('no element for ' + step.click);
        else el.click();
    } else if (step.event) {
        document.dispatchEvent(new win.Event(step.event));
    } else if (step.go) {
        win.history.pushState(null, '', step.go);
        win.dispatchEvent(new win.Event('popstate'));
    } else if (step.storage) {
        // Another tab wrote (its writes succeed): change the shared storage, then
        // one 'storage' event per key, as the browser sends them.
        const was = refuse.on;
        refuse.on = false;
        for (const [k, v] of Object.entries(step.storage)) {
            const old = local.getItem(k);
            if (v === null) local.removeItem(k); else local.setItem(k, v);
            win.dispatchEvent(new win.StorageEvent('storage', { key: k, oldValue: old, newValue: v }));
        }
        refuse.on = was;
    }
    await tick(step.wait || 60);
    steps.push({ ...header(), path: location.pathname + location.search, dashboard: dashboard() });
}

const result = {
    first, steps,
    final: {
        ...header(), path: location.pathname + location.search,
        stored: local.getItem('pdex_wallet_address'),
        dashboardDisconnect: !!document.getElementById('wallet-disconnect-btn'),
        menuWho: (document.getElementById('wallet-menu-who') || {}).textContent || '',
        dashboard: dashboard()
    },
    errors
};
process.stdout.write('RESULT ' + JSON.stringify(result) + '\n');
process.exit(0);
