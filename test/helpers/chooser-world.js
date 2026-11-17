// The Connect wallet chooser (lib/wallet-picker-view.js) mounted into a real
// happy-dom document, with fake wallet extensions on an injectedWeb3-shaped
// object and the REAL source registry (lib/wallet-sources.js) between them.
//
// Every fake extension counts its enable() calls, so a test can say exactly
// which wallet was asked, and when: the point of the lazy-enable change is that
// a wallet is asked only when the user clicked its row (or it is the one the
// user used last, asked silently).
//
// Addresses are synthetic: 32 bytes of one repeated value, SS58-encoded. They
// belong to no one.

import { Window } from 'happy-dom';
import { encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import { escapeHtml } from '../../lib/html-escape.js';
import { closeControlHtml } from '../../lib/close-control.js';
import { mountWalletPicker } from '../../lib/wallet-picker-view.js';
import { createSourceRegistry, detectSources } from '../../lib/wallet-sources.js';

export const addr = (n, prefix = 88) => encodeAddress(new Uint8Array(32).fill(n), prefix);
export const same = (a, b) => { try { return Buffer.from(decodeAddress(a)).equals(Buffer.from(decodeAddress(b))); } catch (e) { return false; } };
export const valid = (a) => { try { decodeAddress(a); return true; } catch (e) { return false; } };
export const short = (a) => String(a).slice(0, 8) + '...' + String(a).slice(-6);
export const toPdex = (a) => encodeAddress(decodeAddress(a), 88);
export const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// One extension. `accounts` is mutable (push to model "allowed another
// account"); set `reject` to make enable() throw (the user refused the site);
// set `hold` to make enable() wait until release() (a popup still open).
export function fakeWallet(key, accounts = [], { reject = false, hold = false } = {}) {
    const w = {
        key, accounts, reject, hold, enableCalls: 0, waiting: [],
        signer: { extKey: key, signRaw: async () => ({ signature: '0x01' }), signPayload: async () => ({ signature: '0x01' }) },
        release() { const q = w.waiting.splice(0); q.forEach(fn => fn()); },
        provider: {
            enable: async () => {
                w.enableCalls++;
                if (w.hold) await new Promise(r => w.waiting.push(r));
                if (w.reject) throw new Error('Rejected');
                return { accounts: { get: async () => w.accounts.map(a => ({ ...a })) }, signer: w.signer };
            }
        }
    };
    return w;
}
export const acct = (n, name) => ({ address: addr(n, 42), name });

// A WalletConnect controller stand-in: connect(panel) resolves when the test
// calls approve(), rejects on fail(message) or cancel(). While paired, its
// provider is on `injected` under 'walletconnect', as allInjected() does.
export function fakePhone(injected, { peer = 'Nova Wallet', accounts = [acct(70, 'My Nova account')], connected = false } = {}) {
    const pair = () => { injected.walletconnect = { enable: async () => ({ accounts: { get: async () => p.accounts.map(a => ({ ...a })) }, signer: { wc: true } }) }; };
    const p = {
        connected: false, connects: 0, cancels: 0, disconnects: 0, panels: [], pending: null, accounts,
        isConnected: () => p.connected,
        peerName: () => (p.connected ? peer : ''),
        connect(panel) {
            p.connects++;
            p.panels.push(panel);
            if (panel) panel.innerHTML = '<p class="wc-status" role="status">Starting WalletConnect...</p>';
            return new Promise((resolve, reject) => { p.pending = { resolve, reject }; });
        },
        approve() {
            p.connected = true;
            pair();
            p.pending.resolve(p.accounts);
        },
        fail(message) { p.pending.reject(new Error(message)); },
        cancel() { p.cancels++; if (p.pending) p.pending.reject(new Error('Cancelled')); },
        async disconnect() { p.disconnects++; p.connected = false; delete injected.walletconnect; }
    };
    if (connected) { p.connected = true; pair(); }
    return p;
}

// Mount the page. `wallets`: fakeWallet()s installed now. `injected` can be
// changed later (add or remove a key) to model an extension appearing.
export function mountChooser(t, opts = {}) {
    const window = new Window({ url: 'https://explorer.test/wallet', width: opts.width || 1024, settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    t.after(() => window.happyDOM.close());
    const doc = window.document;
    // opts.shell: the real page's markup (preview generator); the picker mounts into its #wallet-dashboard.
    let root;
    if (opts.shell) { doc.body.innerHTML = opts.shell; root = doc.getElementById('wallet-dashboard'); }
    else { root = doc.createElement('div'); root.id = 'wallet-dashboard'; doc.body.appendChild(root); }
    const wallets = opts.wallets || [];
    const injected = Object.fromEntries(wallets.map(w => [w.key, w.provider]));
    const registry = opts.registry || createSourceRegistry({ getInjected: () => injected, appName: 'Polkadex Explorer', toAddress: toPdex });
    const phone = opts.phone ? fakePhone(injected, opts.phone === true ? {} : opts.phone) : null;
    const calls = { select: [], disconnect: 0, multisig: [], closes: 0, reloads: 0 };
    const deps = {
        current: opts.current || '', currentSource: opts.currentSource || '', lastSource: opts.lastSource || '',
        onMobile: !!opts.onMobile, hash: opts.hash || '',
        getSources: () => detectSources(injected),
        enableSource: (k) => registry.enableSource(k),
        readSource: (k) => registry.read(k),
        enabledKeys: () => registry.enabledKeys(),
        select: (a, s) => calls.select.push([a, s]),
        disconnect: opts.disconnect || (() => { calls.disconnect++; }),
        isSame: same, isValid: valid, esc: escapeHtml, shortAddr: short,
        helpHtml: '<a href="/help/connecting-wallet" class="help-inline-icon" title="How wallets work on Polkadex Explorer" aria-label="How wallets work on Polkadex Explorer"></a>',
        closeHtml: closeControlHtml({ parent: 'home' }),
        mobileCardsHtml: '<div class="mobile-wallet-grid">CARDS</div>', currentUrl: 'https://explorer.test/wallet',
        clipboard: { writeText: async () => {} },
        mountMultisig: (el, o) => { calls.multisig.push(o); el.innerHTML = '<div class="ms-stub">MS</div>'; },
        reloadPage: () => { calls.reloads++; },
        slowMs: opts.slowMs, detectRetries: opts.detectRetries ?? 0, detectDelayMs: opts.detectDelayMs ?? 1,
        walletConnect: phone || false
    };
    const picker = mountWalletPicker(root, deps);
    const close = root.querySelector('.close-control');
    if (close) close.addEventListener('click', () => { calls.closes++; });
    const q = (s) => root.querySelector(s);
    const qa = (s) => Array.from(root.querySelectorAll(s));
    const visible = (el) => !!el && !el.closest('[hidden]');
    const text = () => qa('*').length ? root.textContent.replace(/\s+/g, ' ') : '';
    const enables = () => Object.fromEntries(wallets.map(w => [w.key, w.enableCalls]));
    const totalEnables = () => wallets.reduce((n, w) => n + w.enableCalls, 0);
    const row = (key) => q(`.wallet-option-row[data-source="${key}"]`);
    const action = (name) => q(`.wallet-option-row[data-action="${name}"]`);
    const optionNames = () => qa('#wallet-picker-options .wallet-option-row').filter(visible).map(b => b.querySelector('.wallet-option-name').textContent.trim());
    const settle = async () => { await tick(0); await picker.idle(); await tick(0); };
    const key = (el, k) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
    const type = (input, v) => { input.value = v; input.dispatchEvent(new window.Event('input', { bubbles: true })); };
    return { window, doc, root, calls, picker, q, qa, visible, text, injected, registry, phone, wallets, enables, totalEnables, row, action, optionNames, settle, key, type };
}
