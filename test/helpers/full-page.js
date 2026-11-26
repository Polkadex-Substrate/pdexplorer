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
//            { go: '/path' } (an SPA navigation: pushState, then popstate),
//            { setScroll: y } (the reader scrolled to y), { back: true } (history.back()) ]
//   scrollLog: true                  window.scrollTo is recorded (happy-dom has no layout, so scrollY is a stub
//                                    that scrollTo sets); result.scroll = { restoration, atLoad }, steps[i].scrollCalls
//   api: { 'url substring': json }   answers for fetch, first match wins (else {}); a canned object with __status answers that HTTP status, with __hang never answers, with __throw fails like a dropped network
//   tagStatic: true                  marks index.html's elements (data-static, data-static-style) before script.js runs
//   clipboard: true                  navigator.clipboard.writeText answers
//   probe: [selector]                per selector: how many, how many not hidden, the first one's text
//   steps may also hold { type: selector, value } (an input's value is set), { dump: selector }: the first match's outerHTML is appended to result.dumps (null if none)
// }
// The result also carries every URL fetched, every WebSocket URL and the data-page on screen.
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

// scrollLog: record every window.scrollTo(x, y); scrollY follows the last call.
const scroll = { y: 0, calls: [] };
if (scenario.scrollLog) {
    win.scrollTo = (x, y) => { scroll.calls.push([x, typeof y === 'number' ? y : (x && x.top) || 0]); scroll.y = scroll.calls[scroll.calls.length - 1][1]; };
    Object.defineProperty(win, 'scrollY', { get: () => scroll.y, configurable: true });
    Object.defineProperty(win, 'pageYOffset', { get: () => scroll.y, configurable: true });
}

const g = globalThis;
for (const k of ['window', 'document', 'localStorage', 'sessionStorage', 'location', 'history', 'HTMLElement', 'Element', 'Node',
    'CustomEvent', 'Event', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'IntersectionObserver', 'ResizeObserver', 'DOMParser', 'matchMedia', 'innerWidth', 'innerHeight', 'scrollTo', 'HTMLCanvasElement', 'Image', 'screen', 'navigator']) {
    try { Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true }); } catch (e) { /* not in this happy-dom */ }
}
const sockets = [];   // every WebSocket URL the page tried to open (none really opens)
g.WebSocket = class { constructor(url) { sockets.push(String(url)); } close() {} send() {} };
const walletPayload = (address) => ({ address, identity: 'Test identity', balance: { total: '0', free: '0' }, staking: {}, rewards: {}, network: {}, recentTransactions: [] });
const fetched = [];
g.fetch = win.fetch = async (url) => {
    fetched.push(String(url));
    const m = /\/api\/wallet\/([^/?]+)/.exec(String(url));
    const canned = Object.entries(scenario.api || {}).find(([k]) => String(url).includes(k));
    const data = canned ? canned[1] : m ? walletPayload(decodeURIComponent(m[1])) : {};
    if (data && data.__throw) throw new TypeError('Failed to fetch');   // __throw: the request fails as a dropped network does
    if (data && data.__hang) await new Promise(() => {});   // a canned answer may carry __hang: the request never answers (a loading state stays drawn)
    const status = (data && data.__status) || 200;   // a canned answer may carry __status to fail the request
    return { ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data), headers: new Map(canned ? [['content-type', 'application/json']] : []) };
};

if (scenario.clipboard) Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
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
// tagStatic: every element index.html draws is marked, with the style it was drawn with, before script.js runs, so a test can
// tell what script.js wrote (an element with no mark, or a mark whose style has changed) from what the static markup holds.
if (scenario.tagStatic) for (const e of win.document.querySelectorAll('*')) { e.setAttribute('data-static', ''); if (e.hasAttribute('style')) e.setAttribute('data-static-style', e.getAttribute('style')); }
const realSetTimeout = g.setTimeout;
g.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 6000 ? 0 : ms, ...a);
await import(SCRIPT_URL.href);
g.setTimeout = realSetTimeout;
const first = header();   // after every top-level statement, before any await resolved

await tick(30);
const atLoad = scroll.calls.splice(0);
const steps = [];
const dumps = [];
for (const step of scenario.steps || []) {
    if (step.setScroll !== undefined) {
        scroll.y = step.setScroll;
    } else if (step.back) {
        win.history.back();
    } else if (step.type) {
        const el = document.querySelector(step.type);
        if (!el) errors.push('no element for ' + step.type); else el.value = step.value;
    } else if (step.click) {
        const el = document.querySelectorAll(step.click)[step.nth || 0];
        if (!el) errors.push('no element for ' + step.click);
        else el.click();
    } else if (step.event) {
        document.dispatchEvent(new win.Event(step.event));
    } else if (step.go) {
        win.history.pushState(null, '', step.go);
        win.dispatchEvent(new win.Event('popstate'));
    } else if (step.dump) {
        const el = document.querySelector(step.dump);
        dumps.push(el ? el.outerHTML : null);
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
    steps.push({ ...header(), path: location.pathname + location.search, dashboard: dashboard(), ...(scenario.scrollLog ? { scrollCalls: scroll.calls.splice(0) } : {}) });
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
    errors,
    dumps,
    fetched,
    sockets,
    page: (Array.from(document.querySelectorAll('.page-section')).find(p => p.style.display && p.style.display !== 'none') || { getAttribute: () => null }).getAttribute('data-page'),
    probe: Object.fromEntries((scenario.probe || []).map(sel => {
        const list = Array.from(document.querySelectorAll(sel));
        return [sel, { count: list.length, shown: list.filter(e => !e.hidden).length, text: list[0] ? list[0].textContent.replace(/\s+/g, ' ').trim().slice(0, 400) : '' }];
    }))
};
if (scenario.scrollLog) result.scroll = { restoration: win.history.scrollRestoration, atLoad };
// The preview generator asks for the rendered shell (test/helpers/preview-chooser.mjs).
if (scenario.dumpHtml) { const app = document.querySelector('.app-container'); result.appHtml = app ? app.outerHTML : ''; }
// Exit only once the line is flushed: stdout to a pipe is asynchronous, and process.exit() right after a large write
// (dumpHtml, about 140 kB) could cut the line, so the parent's JSON.parse threw inside its callback and the caller
// waited for an answer that never came (sprint 11: seen under load on the account page).
process.stdout.write('RESULT ' + JSON.stringify(result) + '\n', () => process.exit(0));
