#!/usr/bin/env node
// Static preview scenes for a design round (never shipped, never run by npm test).
//
//   node --experimental-sqlite tools/preview-scenes.mjs --out <dir> [--wp 1] [--scene <id>] [--selftest]
//
// Each scene is ONE self-contained HTML file named  wp<N>-<scene>-<width>.html  (width 1280 and 375, or the scene's own widths; dark
// theme). It holds the branch's REAL index.html shell (sidebar, topbar, the page section), the REAL view
// functions rendered into it in happy-dom, and the REAL styles.css, byte for byte, inside an iframe whose
// width is the scene width, so the stylesheet's media queries answer to 375 px as they would on a phone.
// No JavaScript is needed to see a scene. Inter (latin 300 to 700) and the Boxicons font are inlined as
// data: URIs from node_modules; logo.png as a data: URI. Nothing is fetched at view time.
//
// A palette sheet (wp<N>-palette.html) shows every colour token as a swatch with its name, value and role,
// and a sample of each shared ui-* part, from the same stylesheet.
//
// Later work packages add their scenes to the WORK_PACKAGES table below (a scene is { id, primary, build }; a
// package may bring its own page guard as `check`). WP2: the Validate hub, the dashboard and /validate/keys.
// WP3: the setup wizard, the separate steps, the manage panel (in its own card) and the node guide, driven
// through test/helpers/wp3-world.js; a scene may name an element to scroll to (`scroll`), set on load.
//
// Guards: a file is not written when a scene lacks a required element, when the scene shows the wrong
// number of primary actions, when styles.css is not inlined byte for byte, or when any stylesheet, script,
// font or image reference is not a data: URI. `--selftest` breaks each guard once and renders its message.
//
// The header (fidelity review 5): the shell's Connect Wallet is drawn as the real page draws it, by the one
// rule in lib/ui-parts.js headerLook: "My Account" and the short address when a wallet is connected, an
// outline when none is and the page shows its own primary (the chooser, the connect bar, Check keys), else
// solid. A guard refuses a scene whose header does not follow that rule.
//
// Importable (tests build scenes in-process through sceneWorld); the generator runs only from the command line.
//
// Addresses are synthetic (32 repeated bytes): they belong to no one.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { mountChooser, fakeWallet, acct, addr, tick } from '../test/helpers/chooser-world.js';
import { mountPairingPanel } from '../lib/walletconnect-view.js';
import { rootProps } from '../test/helpers/css-rules.js';
import { mountValidatePage, mountKeysPage } from '../lib/validator-status-view.js';
import { validatorStatusModel } from '../lib/validator-status.js';
import { EXPECTED_LAYOUT } from '../lib/session-keys.js';
import { escapeHtml } from '../lib/html-escape.js';
import { headerLook, PAGE_PRIMARY_SELECTOR } from '../lib/ui-parts.js';
import { fakeManageApi } from '../test/helpers/manage-fake-chain.js';
import { buildState } from '../test/helpers/wp3-world.js';

const root = new URL('../', import.meta.url);
const rd = (p, enc = 'utf8') => readFileSync(new URL(p, root), enc);
const b64 = (p) => rd(p, null).toString('base64');
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
const WIDTHS = [1280, 375];

// ── assets, from node_modules ──
const dataFont = (p) => `url(data:font/woff2;base64,${b64(p)}) format('woff2')`;
function interCss() {
    return [300, 400, 500, 600, 700].map(w => `@font-face { font-family: 'Inter'; font-style: normal; font-display: swap; font-weight: ${w}; src: ${dataFont(`node_modules/@fontsource/inter/files/inter-latin-${w}-normal.woff2`)}; }`).join('\n');
}
function boxiconsCss() {
    const css = rd('node_modules/boxicons/css/boxicons.min.css');
    return css.replace(/src:url\(\.\.\/fonts\/boxicons\.eot\);src:[^}]*\}/, `src:${dataFont('node_modules/boxicons/fonts/boxicons.woff2')}}`);
}
const STYLES = rd('styles.css');

// A static page cannot hover or focus: every :hover and :focus-visible rule gets a twin selector with the
// class .pv-hover or .pv-focus, in place (so it stays inside its media query), and a scene sets the class.
function withStateClasses(css) {
    return css.replace(/([^{}@]+)\{([^{}]*)\}/g, (m, sel, body) => {
        if (!/:hover|:focus-visible/.test(sel)) return m;
        const twin = sel.trim().replace(/\s+/g, ' ').split(',').map(x => x.replace(/:hover/g, '.pv-hover').replace(/:focus-visible/g, '.pv-focus')).join(',');
        return `${m}\n${twin}{${body}}`;
    });
}
const STYLES_PV = withStateClasses(STYLES);
// The twins are the only difference from styles.css; taking them out again must give the file back byte for byte.
const stripTwins = (css) => css.replace(/\n[^{}\n]*\.pv-(?:hover|focus)[^{}\n]*\{[^{}]*\}/g, '');
if (stripTwins(STYLES_PV) !== STYLES) throw new Error('internal: the hover and focus twins do not come out cleanly');
const APP_CSS = interCss() + '\n' + STYLES_PV + '\n' + boxiconsCss();
const logoUri = 'data:image/png;base64,' + b64('logo.png');
const qrSrc = rd('node_modules/qrcodejs/qrcode.min.js');

// ── the real shell ── (page: the data-page kept; nav: the sidebar entry shown as active)
function shellHtml(page = 'wallet', nav = '#nav-my-account') {
    const html = rd('index.html');
    const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>') + 7).replace(/<script[\s\S]*?<\/script>/g, '');
    const doc = new Window().document;
    doc.body.outerHTML = body;
    const app = doc.querySelector('.app-container');
    for (const sec of Array.from(app.querySelectorAll('.page-section'))) if (sec.getAttribute('data-page') !== page) sec.remove();
    const kept = app.querySelector(`.page-section[data-page="${page}"]`);
    kept.removeAttribute('style');
    for (const n of app.querySelectorAll('.nav-item.active')) n.classList.remove('active');
    const navEl = app.querySelector(nav);
    navEl.hidden = false;
    navEl.classList.add('active');
    for (const m of Array.from(app.querySelectorAll('[id$="-modal"]'))) if (!m.closest('.wallet-picker')) m.remove();
    for (const img of app.querySelectorAll('img[src="logo.png"]')) img.setAttribute('src', logoUri);
    return app.outerHTML;
}
const SHELL = shellHtml();
const VALIDATE_SHELL = shellHtml('validate', '#nav-validate');

// ── WP1 scenes: the wallet connect page ──
const TALISMAN = () => fakeWallet('talisman', [acct(10, 'Main account'), acct(12, 'Staking'), acct(13, 'Savings')]);
const POLKADOT = () => fakeWallet('polkadot-js', [acct(11, 'Polkadot.js account'), acct(14, 'Treasury signer')]);
const fakeT = { after() {} };
const mount = (o) => mountChooser(fakeT, { shell: SHELL, ...o });
const setup = async (o, steps = async () => {}) => {
    const w = mount(o);
    w.window.QRCode = new Function('document', 'window', qrSrc + ';return QRCode;')(w.doc, w.window);   // the real QR drawer reads window.QRCode
    await w.picker.ready;
    await steps(w);
    return w;
};
const pairing = async (w) => {
    w.phone.connect = (panel) => {
        w.phone.connects++;
        mountPairingPanel(panel, { uri: 'wc:7f6e5d4c3b2a19080706050403020100ffeeddccbbaa99887766554433221100@2?relay-protocol=irn&symKey=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', onMobile: false, clipboard: { writeText: async () => {} }, onCancel() {} });
        return new Promise(() => {});
    };
    w.action('phone').click(); await w.settle();
};
// The real multisig mount needs a store and the network; show what it renders when nothing is saved.
const MS_LINE = '<div class="ms-compact-add"><button type="button" class="wp-link ms-add-link">Add a multisig wallet</button></div>';
const withMs = (w) => { const el = w.q('.ms-stub'); if (el) el.outerHTML = MS_LINE; };

const WALLET_SCENES = [
    { id: 'wallet-none-installed', primary: 1, build: () => setup({ phone: true }, withMs) },
    { id: 'wallet-two-ext-and-phone', primary: 0, build: () => setup({ wallets: [POLKADOT(), TALISMAN()], phone: true }, withMs) },
    { id: 'wallet-ext-shared-accounts', primary: 0, build: () => setup({ wallets: [POLKADOT(), TALISMAN()], phone: true }, async (w) => { w.row('talisman').click(); await w.settle(); w.q('#wallet-picker-back').click(); await w.settle(); withMs(w); }) },
    { id: 'wallet-waiting', primary: 0, build: () => setup({ wallets: [Object.assign(TALISMAN(), { hold: true }), POLKADOT()] }, async (w) => { w.row('talisman').click(); await tick(20); withMs(w); }) },
    { id: 'wallet-problem', primary: 0, build: () => setup({ wallets: [Object.assign(POLKADOT(), { reject: true }), TALISMAN()] }, async (w) => { w.row('polkadot-js').click(); await w.settle(); withMs(w); }) },
    { id: 'wallet-switch-current', primary: 0, connected: addr(10, 42), need: '.wallet-account-row.is-current', build: () => setup({ wallets: [TALISMAN(), POLKADOT()], current: addr(10, 42), currentSource: 'talisman', lastSource: 'talisman' }, withMs) },
    { id: 'wallet-accounts-five', primary: 0, build: () => setup({ wallets: [fakeWallet('talisman', [acct(10, 'Main account'), acct(12, 'Staking'), acct(13, 'Savings'), acct(15, 'Trading'), acct(16, 'Cold storage')])] }, async (w) => { w.row('talisman').click(); await w.settle(); }) },
    { id: 'wallet-get', primary: 0, build: () => setup({}, async (w) => { w.action('get').click(); await w.settle(); }) },
    { id: 'wallet-get-retried', primary: 1, extra: '.wallet-onboarding-reload', build: () => setup({}, async (w) => { w.action('get').click(); await w.settle(); w.q('.wallet-get-check').click(); await w.settle(); }) },
    { id: 'wallet-pairing', primary: 0, build: () => setup({ wallets: [TALISMAN()], phone: true }, pairing) },
    { id: 'wallet-more-options-open', primary: 0, build: () => setup({ wallets: [POLKADOT(), TALISMAN()], phone: true }, async (w) => { withMs(w); w.q('#wallet-picker-more').open = true; w.q('#wallet-picker-view').open = true; }) },
    { id: 'wallet-row-hover-and-focus', primary: 0, build: () => setup({ wallets: [POLKADOT(), TALISMAN()], phone: true }, async (w) => { w.row('polkadot-js').classList.add('pv-hover'); w.row('talisman').classList.add('pv-focus'); w.action('phone').classList.add('pv-hover'); withMs(w); }) }
];

// ── WP2 scenes: the Validate hub, the dashboard and the keys page (spec section 8) ──
// The real mount functions in the real shell, with the explorer API answered from fixed snapshots.
const vaddr = (n) => addr(n, 88);
const ME = vaddr(31), THEM = vaddr(32), P1 = vaddr(33), P2 = vaddr(34), P3 = vaddr(35);
const PDEX = 10n ** 12n;
const hexRep = (b, n) => b.repeat(n);
const VKEYS = { grandpa: '0x' + hexRep('11', 32), babe: '0x' + hexRep('22', 32), im_online: '0x' + hexRep('33', 32), authority_discovery: '0x' + hexRep('44', 32), mixnet: '0x' + hexRep('55', 32), beefy: '0x02' + hexRep('66', 32) };
const VBLOB = '0x' + Object.values(VKEYS).map(h => h.slice(2)).join('');
const vsnap = (over = {}) => ({
    address: ME, bonded: true, controller: ME, ledger: { total: String(25_000n * PDEX), active: String(25_000n * PDEX) },
    intent: true, prefs: { commission: 50_000_000, blocked: false }, nextKeys: VKEYS, queuedKeys: VKEYS, inQueued: true, inSession: true,
    activeImOnlineKey: VKEYS.im_online, disabled: false, imOnline: true, heartbeat: true, blocks: 2,
    activeEra: 512, currentEra: 512, sessionIndex: 3071, sessionProgress: 0.62, epochDuration: 1200, blockTimeMs: 12000, sessionsPerEra: 6, eraStartSession: 3068,
    exposure: { total: String(184_000n * PDEX), own: String(25_000n * PDEX), nominatorCount: 184, pageCount: 1 }, nextExposure: null,
    points: { points: 4320, rank: 7, of: 22 }, lastEra: { points: 7000, reward: String(37n * PDEX) },
    lastSlashEra: null, incidents: [], identity: { name: 'Example validator', judgements: [] }, proxies: [], bondingDuration: 28, ...over
});
const VPARAMS = { specVersion: 393, layout: { ok: true, bytes: 193, hexLength: 388 }, minValidatorBond: String(10_000n * PDEX), minCommission: 10_000_000, maxValidatorsCount: 50, lowestElectedTotal: String(90_000n * PDEX), medianCommission: 40_000_000 };
const NOT_BONDED = { bonded: false, controller: null, ledger: null, intent: false, prefs: null, nextKeys: null, queuedKeys: null, inQueued: false, inSession: false, exposure: null, points: null, lastEra: null };
const NO_PROXIES = { address: ME, stashes: [], capped: false, partial: false };
const THREE = { address: ME, capped: false, partial: false, stashes: [
    { stash: P1, proxies: [{ type: 'Staking', delay: 0 }], validating: true },
    { stash: P2, proxies: [{ type: 'Staking', delay: 0 }], validating: false },
    { stash: P3, proxies: [{ type: 'Governance', delay: 0 }], validating: null }] };
const httpErr = (status) => Object.assign(new Error('x'), { status });
const keysRows = (other) => EXPECTED_LAYOUT.map((l, i) => ({ name: l.name, typeId: l.typeId, preview: '0x' + String(i + 1).repeat(8) + '...' + String(i + 1).repeat(8), result: other && i === 1 ? 'other' : i === 0 ? 'own' : 'free', owner: other && i === 1 ? THEM : null }));
const never = new Promise(() => {});
// The real help icon markup (script.js helpIcon) and a real manage panel on a fake chain (test/helpers/manage-fake-chain.js).
const helpIcon = (slug, label) => `<a href="/help/${slug}" class="help-inline-icon" title="${escapeHtml(label || '')}" aria-label="${escapeHtml(label || '')}"><i class='bx bx-help-circle'></i></a>`;
const shortAddr = (a) => a.slice(0, 8) + '\u2026' + a.slice(-6);
// o: { account, url (the URL address), state (snapshot over), status (an answer or an Error or 'hang'), proxied, alerts, params, keysAnswer, manage }
function vworld(o = {}) {
    const window = new Window({ url: 'https://explorer.test/validate', width: o.width || 1280, settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    const doc = window.document;
    doc.body.innerHTML = VALIDATE_SHELL;
    for (const img of doc.querySelectorAll('img')) if (!/^data:/.test(img.getAttribute('src') || '')) img.setAttribute('src', logoUri);
    const root = doc.getElementById('validate-root');
    const account = o.account === undefined ? { status: 'connected', address: ME } : o.account;
    const d = {
        account, getAccount: () => account, urlAddress: o.url || '', isSame: (a, b) => a === b,
        fetchJson: async (u) => {
            if (u === '/api/validator/params') return o.params || VPARAMS;
            if (u.startsWith('/api/proxied-stashes/')) return o.proxied || NO_PROXIES;
            if (u === '/api/validator-alerts/status') return { enabled: o.alerts !== false, maxPerEmail: 5 };
            if (u.startsWith('/api/session-keys/check')) return o.keysAnswer;
            const m = /^\/api\/validator\/([^/]+)\/status$/.exec(u);
            if (m) {
                if (o.status === 'hang') return never;
                if (o.status instanceof Error) throw o.status;
                return { ...validatorStatusModel(vsnap({ address: decodeURIComponent(m[1]), ...(o.state || {}) }), VPARAMS), address: decodeURIComponent(m[1]) };
            }
            throw new Error('unexpected ' + u);
        },
        helpIcon, esc: escapeHtml, shortAddr, navigate: () => {}
    };
    if (o.manage) d.manage = { account, getApi: () => fakeManageApi(ME, VKEYS), isMultisig: () => false, revision: () => 'r1', submit: () => {}, fetchJson: d.fetchJson, esc: escapeHtml, helpIcon, shortAddr, isAddress: () => true, isSame: (a, b) => a === b, apiWaitMs: 50 };
    const qa = (sel) => Array.from(doc.querySelectorAll(sel));
    const visible = (el) => !!el && !el.closest('[hidden]');
    return { window, doc, root, d, qa, visible, q: (sel) => doc.querySelector(sel) };
}
const tickv = (ms = 30) => new Promise(r => setTimeout(r, ms));
const hub = (o = {}, steps = async () => {}) => async () => { const w = vworld(o); const p = mountValidatePage(w.root, w.d); await (o.status === 'hang' ? tickv(20) : p); await tickv(o.manage ? 120 : 30); await steps(w); return w; };
const keysPage = (o = {}, steps = async () => {}) => async () => { const w = vworld(o); await mountKeysPage(w.root, w.d); await tickv(20); await steps(w); return w; };
const submitKeys = (value) => async (w) => { w.q('#validate-keys-input').value = value; w.q('#validate-keys-form').dispatchEvent(new w.window.Event('submit', { cancelable: true })); await tickv(30); };
const VALIDATE_SCENES = [
    { id: 'hub-no-wallet', primary: 1, need: '.validate-connect', build: hub({ account: { status: 'none', address: '' } }) },
    { id: 'hub-not-bonded', primary: 1, need: '.validate-path', build: hub({ state: NOT_BONDED }) },
    { id: 'hub-keys-not-validating', primary: 1, need: '.validate-path', build: hub({ state: { intent: false, prefs: null, inQueued: false, inSession: false, exposure: null, points: null } }) },
    { id: 'hub-active', primary: 0, need: '#validate-manage-slot .validate-manage', build: hub({ manage: true }) },
    // The phone view of an own active stash: the compact path, the lookup folded behind its summary (375 only).
    { id: 'hub-active-compact', primary: 0, widths: [375], need: '.validate-lookup-fold', build: hub({ manage: true, width: 375 }) },
    { id: 'hub-waiting', primary: 0, need: '.validate-tiles', build: hub({ state: { inQueued: false, inSession: false, exposure: null, points: null } }) },
    { id: 'hub-disabled-slashed', primary: 0, need: '.validate-tiles', build: hub({ state: { disabled: true, lastSlashEra: 510 } }) },
    { id: 'hub-offline', primary: 0, need: '.validate-tiles', build: hub({ state: { heartbeat: false, blocks: 0, sessionProgress: 0.9, incidents: [{ kind: 'imOnline.SomeOffline' }] } }) },
    { id: 'hub-loading', primary: 0, need: '.validate-skeleton', build: hub({ status: 'hang' }) },
    { id: 'hub-chain-down', primary: 0, need: '.ui-panel.is-warn', build: hub({ status: httpErr(503) }) },
    { id: 'hub-limited', primary: 0, need: '.validate-tiles', build: hub({ state: { exposure: null } }) },
    { id: 'hub-lookup-other', primary: 0, need: '.validate-tiles', build: hub({ url: THEM }) },
    { id: 'hub-lookup-bad-address', primary: 0, need: '.validate-msg.is-error', build: hub({ account: { status: 'none', address: '' }, url: 'e-not-an-address', status: httpErr(400) }) },
    { id: 'hub-proxy-with-three-stashes', primary: 0, need: '.validate-proxied', build: hub({ proxied: THREE }) },
    { id: 'hub-proxy-limited', primary: 0, need: '.validate-proxied', build: hub({ proxied: { ...NO_PROXIES, limited: true, reason: 'SIGNER_INDEX_MISSING' } }) },
    { id: 'keys-empty', primary: 1, need: '#validate-keys-form', build: keysPage({ account: { status: 'none', address: '' } }) },
    { id: 'keys-ok', primary: 1, need: '.validate-keys-table', build: keysPage({ keysAnswer: { ok: true, conflict: false, bytes: 193, summary: '6 keys, 193 bytes, none registered to another account.', rows: keysRows(false) } }, submitKeys(VBLOB)) },
    { id: 'keys-conflict', primary: 1, need: '.validate-alert', build: keysPage({ keysAnswer: { ok: true, conflict: true, bytes: 193, summary: `Key 2 (babe) is already registered to ${THEM}. The chain will reject these keys.`, rows: keysRows(true) } }, submitKeys(VBLOB)) },
    { id: 'keys-invalid', primary: 1, need: '#validate-keys-input[aria-invalid="true"]', build: keysPage({}, submitKeys('0x1234')) },
    { id: 'keys-mismatch', primary: 0, need: '.validate-mismatch', build: keysPage({ params: { ...VPARAMS, specVersion: 394, layout: { ok: false } } }) }
];
// The page's own guards: shell, page and the one primary (spec R3 and section 3.3).
function checkValidateScene(w, s, err) {
    if (!w.doc.querySelector('aside.sidebar .nav-item.active#nav-validate')) err.push('no active #nav-validate in the sidebar');
    if (!w.doc.querySelector('.page-section[data-page="validate"] #validate-root .validate-hub')) err.push('no .validate-hub in #validate-root');
    const n = w.qa('.validate-primary').filter(w.visible).length;
    if (n !== s.primary) err.push(`${n} primary actions visible, the spec table wants ${s.primary}`);
    if (s.need && w.qa(s.need).filter(w.visible).length < 1) err.push(`no visible ${s.need}`);
}

// ── WP3 scenes: wizard, separate steps, manage, node guide (spec section 8) ──
// The real mounts in the real shell; the manage panel in its own card, as the hub mounts it (fidelity review 22).
const manageSlot = (p) => {
    p.el.innerHTML = '<div class="validate-hub"><div class="validate-cards"><div id="validate-manage-slot" class="list-container glass validate-manage-card"></div></div></div>';
    return p.doc.getElementById('validate-manage-slot');
};
const wp3 = (state, extra = {}) => async () => {
    const w = await buildState(state, { shell: VALIDATE_SHELL, ...extra });
    w.root = w.doc.getElementById('validate-root');
    w.qa = (sel) => Array.from(w.doc.querySelectorAll(sel));
    w.q = (sel) => w.doc.querySelector(sel);
    w.visible = (el) => !!el && !el.closest('[hidden]');
    return w;
};
const WP3_SCENES = [
    { id: 'wizard-step1', primary: 1, need: '.validate-setup .validate-path.is-compact', build: wp3('wiz-step1') },
    { id: 'wizard-step2', primary: 1, need: '#validate-setup-keys', build: wp3('wiz-step2-parsed') },
    { id: 'wizard-step3', primary: 1, need: '.validate-stash-notes', build: wp3('wiz-step3') },
    { id: 'wizard-step4', primary: 1, need: '#validate-setup-commission', build: wp3('wiz-step4-warn') },
    { id: 'wizard-step5-review', primary: 1, need: '.validate-warnings.ui-panel.is-warn', build: wp3('wiz-review-ack') },
    { id: 'wizard-review-multisig', primary: 1, need: '.validate-warnings', build: wp3('wiz-review-multisig') },
    { id: 'wizard-signing', primary: 1, need: '[data-setup-action="sign"][disabled]', build: wp3('wiz-signing') },
    { id: 'wizard-done', primary: 1, need: '.ui-panel.is-ok', build: wp3('wiz-result-applied') },
    { id: 'steps-S0', primary: 1, need: '.validate-stepwise-panel', build: wp3('steps-S0') },
    { id: 'steps-S2', primary: 1, need: '#validate-stepwise-status[data-state="S2"]', build: wp3('steps-S2') },
    { id: 'steps-S4', primary: 1, need: '.validate-stepwise-stop', build: wp3('steps-S4-bonded') },
    { id: 'steps-S6', primary: 1, need: '.validate-word.is-error', build: wp3('steps-S6') },
    { id: 'steps-S7', primary: 0, need: '[data-setup-action="step-check"]', build: wp3('steps-S7') },
    { id: 'steps-S8', primary: 0, need: '.validate-alert', build: wp3('steps-S8') },
    { id: 'steps-S9', primary: 1, need: '#validate-stepwise-status.is-warn', build: wp3('steps-S9') },
    { id: 'steps-S10', primary: 1, need: '.validate-stepwise-done', build: wp3('steps-S10') },
    { id: 'manage-idle', primary: 0, need: '#validate-manage-slot .validate-manage-actions', build: wp3('man-idle', { slot: manageSlot }) },
    { id: 'manage-rotate-keys', primary: 1, need: '#validate-manage-keys', build: wp3('man-keys', { slot: manageSlot }) },
    { id: 'manage-stop', primary: 1, need: '.validate-manage-facts', build: wp3('man-chill', { slot: manageSlot }) },
    { id: 'manage-pending-multisig', primary: 0, need: '.validate-manage-pending', build: wp3('man-ms-pending', { slot: manageSlot }) },
    { id: 'guide-top', primary: 1, need: '.validate-guide .validate-path.is-compact', build: wp3('guide-pending') },
    { id: 'guide-step-commands', primary: 1, need: '[aria-labelledby="node-step-client"] .validate-cmd', scroll: '#node-step-client', build: wp3('guide-published') },
    { id: 'guide-end', primary: 1, need: '.validate-guide-next', scroll: '.validate-guide-next', build: wp3('guide-pending') }
];
function checkWp3Scene(w, s, err) {
    if (!w.doc.querySelector('aside.sidebar .nav-item.active#nav-validate')) err.push('no active #nav-validate in the sidebar');
    if (!w.doc.querySelector('.page-section[data-page="validate"] #validate-root')) err.push('no #validate-root');
    const n = w.qa('.validate-primary').filter(w.visible).length;
    if (n !== s.primary) err.push(`${n} primary actions visible, the spec table wants ${s.primary}`);
    if (s.need && w.qa(s.need).filter(w.visible).length < 1) err.push(`no visible ${s.need}`);
}

// ── the header: the real rule (lib/ui-parts.js headerLook), drawn as script.js refreshConnectWalletButton draws it ──
// WP1 scenes are the chooser (always a page primary); WP2 scenes read the page for a visible primary.
function sceneHeader(w, s, wp) {
    const connected = s.connected || (w.d && w.d.account && w.d.account.status === 'connected' ? w.d.account.address : '');
    const pagePrimary = wp === 1 ? true : w.qa(PAGE_PRIMARY_SELECTOR).filter(w.visible).length > 0;
    return { connected, look: headerLook({ connected: !!connected, pagePrimary }) };
}
function paintHeader(w, s, wp) {
    const { connected, look } = sceneHeader(w, s, wp);
    const btn = w.doc.querySelector('#connect-wallet-btn'), label = w.doc.querySelector('#connect-wallet-label'), sub = w.doc.querySelector('#connect-wallet-sub');
    if (!btn) return;
    btn.classList.toggle('is-connected', look === 'connected');
    btn.classList.toggle('is-outline', look === 'outline');
    if (label) label.textContent = look === 'connected' ? 'My Account' : 'Connect Wallet';
    if (sub) { sub.textContent = look === 'connected' ? shortAddr(connected) : ''; sub.style.display = look === 'connected' ? 'block' : 'none'; }
}
function checkHeader(w, s, wp, err) {
    const btn = w.doc.querySelector('header.topbar #connect-wallet-btn');
    if (!btn) return;
    const { look } = sceneHeader(w, s, wp);
    const drawn = btn.classList.contains('is-connected') ? 'connected' : btn.classList.contains('is-outline') ? 'outline' : 'solid';
    if (drawn !== look) err.push(`the header is drawn ${drawn}, the page rule says ${look}`);
}

// ── work packages: later rounds add theirs here ──
const WORK_PACKAGES = { 1: { scenes: WALLET_SCENES, palette: true }, 2: { scenes: VALIDATE_SCENES, check: checkValidateScene }, 3: { scenes: WP3_SCENES, check: checkWp3Scene } };

// ── a scene file ──
const Q = (w, sel) => w.qa(sel).filter(w.visible).length;
const wpOf = (s) => (WALLET_SCENES.some(x => x.id === s.id) ? 1 : WP3_SCENES.some(x => x.id === s.id) ? 3 : 2);
// A scene's world, header drawn: for the tests (test/validate-fidelity.test.js) and renderScene.
export async function sceneWorld(wp, id) {
    const s = WORK_PACKAGES[wp].scenes.find(x => x.id === id);
    if (!s) throw new Error(`no scene ${id} in work package ${wp}`);
    const w = await s.build();
    paintHeader(w, s, wp);
    return w;
}
async function renderScene(s, check = null, { paint = true } = {}) {
    const w = await s.build();
    if (paint) paintHeader(w, s, wpOf(s));
    const err = [];
    checkHeader(w, s, wpOf(s), err);
    const app = w.doc.querySelector('.app-container');
    if (!app) err.push('no .app-container');
    if (check) {
        if (!w.doc.querySelector('header.topbar .connect-wallet-btn')) err.push('no header.topbar .connect-wallet-btn');
        check(w, s, err);
        if (err.length) throw new Error(`scene "${s.id}": ${err.join('; ')}`);
        return app.outerHTML;
    }
    if (!w.doc.querySelector('aside.sidebar .nav-item.active')) err.push('no aside.sidebar .nav-item.active');
    if (!w.doc.querySelector('header.topbar .connect-wallet-btn')) err.push('no header.topbar .connect-wallet-btn');
    if (!w.doc.querySelector('section.list-container.glass.wallet-picker')) err.push('no section.list-container.glass.wallet-picker');
    if (!w.doc.querySelector('.wallet-ext-tile')) err.push('no .wallet-ext-tile');
    const n = Q(w, '.wallet-picker .is-primary, .wallet-onboarding-reload, .wc-open');
    if (n !== s.primary) err.push(`${n} primary actions visible, the spec table wants ${s.primary}`);
    if (s.need && Q(w, s.need) !== 1) err.push(`${Q(w, s.need)} of ${s.need} visible, the scene needs exactly 1`);
    if (err.length) throw new Error(`scene "${s.id}": ${err.join('; ')}`);
    return app.outerHTML;
}
// scroll: a selector the frame scrolls to once it has loaded (a scene of the middle or the end of a long page).
const frameDoc = (inner, scroll = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style id="app-css">${APP_CSS}</style></head>`
    + `<body${scroll ? ` onload="var e=document.querySelector('${scroll}');if(e)e.scrollIntoView({block:'start'})"` : ''}>${inner}</body></html>`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const OUTER_CSS = 'html,body{margin:0;height:100%;background:#08080C}body{display:flex;flex-direction:column;align-items:center;font-family:system-ui,sans-serif}iframe{border:0;background:#08080C;flex:1;min-height:640px;width:var(--w);max-width:none}.cap{color:#9CA3AF;font-size:12px;padding:6px}';
function sceneFile(id, inner, width, scroll = '') {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${id} ${width}px dark</title><style>${OUTER_CSS}</style></head><body><div class="cap">${id} - ${width} px - dark</div><iframe title="${id} at ${width} px" style="--w:${width}px" srcdoc="${esc(frameDoc(inner, scroll))}"></iframe></body></html>`;
}

// ── the palette sheet ──
const ROLE_OF = (n) => /violet/.test(n) ? 'structure: steps, "you are here", secondary actions' : /green/.test(n) ? 'good state: active, done, connected, safe' : /amber|warning/.test(n) ? 'attention: waiting, caution, read failure' : /blue/.test(n) ? 'guidance: how-to, timing, why' : /red/.test(n) ? 'failure or loss: failed, blocked, invalid' : /pink/.test(n) ? 'phone wallet tile and border (pink acts)' : '';
const USE_OF = (n) => /-text$/.test(n) ? 'text and glyphs on dark' : /-tint$/.test(n) ? 'chip, tile, marker ring' : /-line$/.test(n) ? '1 px borders' : /-wash$/.test(n) ? 'panel wash (0.06 to 0.08)' : n === '--warning' ? 'the token four older rules read' : 'fills, edges, dots; text only for green, amber, red';
function paletteHtml() {
    const { props } = rootProps(STYLES);
    const names = Object.keys(props).filter(n => /^--(accent-|warning)/.test(n));
    const row = (n) => `<tr><td><span class="pv-sw" style="background:var(${n})"></span></td><td><code>${n}</code></td><td><code>${props[n]}</code></td><td>${ROLE_OF(n)}</td><td>${USE_OF(n)}</td></tr>`;
    const chip = (c, i, t) => `<span class="ui-chip ${c}"><i class='bx ${i}' aria-hidden="true"></i>${t}</span>`;
    const tile = (c, i, extra = '') => `<span class="ui-tile ${c} ${extra}" aria-hidden="true"><i class='bx ${i}'></i></span>`;
    const step = (c, t) => `<span class="ui-step ${c}">${t}</span>`;
    const panel = (c, i, title, text) => `<div class="ui-panel ${c}"><i class='bx ${i}' aria-hidden="true"></i><div class="ui-panel-body">${title ? `<p class="ui-panel-title">${title}</p>` : ''}${text}</div></div>`;
    const body = `<div class="pv-page">
<h1>Colour roles: palette</h1><p class="pv-lead">Pink acts, violet structures, green is good, amber is attention, blue is guidance, red is failure. Every value below is read from the real :root block of styles.css; every sample is the real ui-* class.</p>
<section class="list-container glass ui-hairline pv-card"><h2>Roles</h2><div class="pv-roles">
${[['Pink', 'acts', 'The one primary action; brand emphasis', 'var(--brand-primary)'], ['Violet', 'structures', 'Steps, "you are here", secondary actions', 'var(--accent-violet)'], ['Green', 'is good', 'Active, done, connected, safe', 'var(--accent-green)'], ['Amber', 'is attention', 'Waiting, caution, an explorer-side read failure', 'var(--accent-amber)'], ['Blue', 'is guidance', 'How-to, timing notes, why disclosures', 'var(--accent-blue)'], ['Red', 'is failure', 'Failed, blocked, invalid input', 'var(--accent-red)']].map(([n, v, d, c]) => `<div class="pv-role"><span class="pv-bar" style="background:${c}"></span><strong>${n} ${v}</strong><span>${d}</span></div>`).join('')}
</div></section>
<section class="list-container glass pv-card"><h2>Tokens</h2><div class="pv-scroll"><table class="pv-table"><thead><tr><th></th><th>Token</th><th>Value</th><th>Role</th><th>Use</th></tr></thead><tbody>${names.map(row).join('')}</tbody></table></div></section>
<section class="list-container glass pv-card"><h2>Chip</h2><div class="pv-row">${chip('is-positive', 'bx-check-circle', 'Active')}${chip('is-wait', 'bx-time-five', 'Waiting')}${chip('is-info', 'bx-info-circle', 'Guide')}${chip('is-step', 'bx-right-arrow-alt', 'Next')}${chip('is-error', 'bx-error-circle', 'Failed on chain')}${chip('is-neutral', 'bx-minus-circle', 'Not validating')}</div></section>
<section class="list-container glass pv-card"><h2>Icon tile</h2><div class="pv-row">${tile('is-violet', 'bx-key')}${tile('is-green', 'bx-shield-quarter')}${tile('is-amber', 'bx-show')}${tile('is-blue', 'bx-plus')}${tile('is-pink', 'bx-mobile')}${tile('is-brand', 'bx-wallet')}${tile('is-neutral', 'bx-transfer-alt')}<span class="pv-gap"></span>${tile('is-violet is-sm', 'bx-key')}${tile('is-violet', 'bx-key')}${tile('is-violet is-lg', 'bx-key')}</div></section>
<section class="list-container glass pv-card"><h2>Step marker</h2><div class="pv-row">${step('is-later', '3')} <span>later</span> ${step('is-open', '2')} <span>open</span> ${step('is-current', '2')} <span>current</span> ${step('is-done', "<i class='bx bx-check' aria-hidden='true'></i><span class='sr-only'>done</span>")} <span>done</span></div></section>
<section class="list-container glass pv-card"><h2>Status dot</h2><div class="pv-row"><span><span class="ui-dot is-green"></span> Connected</span><span><span class="ui-dot is-amber"></span> Waiting for your phone</span><span><span class="ui-dot is-red"></span> Offline</span><span><span class="ui-dot is-blue"></span> Note</span></div></section>
<section class="list-container glass pv-card"><h2>Panel: wash and 3 px edge, and the one-line form</h2><div class="pv-stack">
${panel('is-warn', 'bx-error', 'Before you sign', 'Read each line. This moves funds from your account.')}
${panel('is-info', 'bx-info-circle', 'Timing', 'A change takes effect at the next era.')}
${panel('is-error', 'bx-error-circle', 'Blocked', 'This stash is not a validator yet.')}
${panel('is-ok', 'bx-check-circle', 'Done on chain', 'Your keys are registered.')}
${panel('is-warn is-line', 'bx-error', '', 'One-line caution: icon and text only.')}</div></section>
<section class="list-container glass ui-hairline pv-card"><h2>Trust row, hairline, primary</h2><div class="ui-trust"><span class="ui-tile is-green is-sm" aria-hidden="true"><i class='bx bx-shield-quarter'></i></span><p>Never asks for a seed or private key. You sign in your own wallet.</p></div><p style="margin:16px 0 0"><button type="button" class="validate-primary">Connect wallet</button></p></section>
</div>`;
    const css = `.pv-page{max-width:1000px;margin:0 auto;padding:24px;display:flex;flex-direction:column;gap:24px}.pv-lead{color:var(--text-secondary);margin:0}.pv-card{padding:24px}.pv-card h2{margin:0 0 16px;font-size:1.1rem}.pv-row{display:flex;flex-wrap:wrap;gap:16px;align-items:center}.pv-stack{display:flex;flex-direction:column;gap:12px}.pv-roles{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.pv-role{display:flex;flex-direction:column;gap:4px;font-size:.9rem;color:var(--text-secondary)}.pv-role strong{color:var(--text-primary)}.pv-bar{display:block;height:4px;width:48px;border-radius:2px}.pv-scroll{overflow-x:auto}.pv-table{border-collapse:collapse;width:100%;font-size:.82rem}.pv-table th,.pv-table td{text-align:left;padding:8px;border-bottom:1px solid var(--border-color);vertical-align:middle}.pv-sw{display:block;width:40px;height:24px;border-radius:6px;border:1px solid rgba(255,255,255,.12)}.pv-gap{width:24px}`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Colour roles palette</title><style id="app-css">${APP_CSS}</style><style>${css}</style></head><body>${body}</body></html>`;
}

// ── guards on a whole file ──
function checkFile(html, { palette = false } = {}) {
    const err = [];
    const inner = html.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    if (!inner.includes(STYLES_PV)) err.push('styles.css is not inlined byte for byte (apart from the .pv-hover and .pv-focus twins)');
    if (!/@font-face \{ font-family: 'Inter'[^}]*src: url\(data:/.test(inner)) err.push('no Inter @font-face with a data: source');
    if (!/@font-face\{[^}]*font-family:boxicons[^}]*src:url\(data:/.test(inner)) err.push('no Boxicons @font-face with a data: source');
    if (!palette && !inner.includes('class="app-container"')) err.push('no .app-container');
    const urls = [...inner.matchAll(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g)].map(m => m[2]).filter(u => !/^data:/.test(u) && !/^#/.test(u));
    const refs = [...inner.matchAll(/<(?:link|script|img|iframe)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g)].map(m => m[1]).filter(u => !/^data:/.test(u));
    for (const u of [...urls, ...refs]) err.push('a stylesheet, script, font or image reference is not a data: URI: ' + u.slice(0, 80));
    if (err.length) throw new Error(err.join('\n'));
}

// ── self-tests: each guard, broken once, must refuse with a readable message ──
async function guardSelfTest() {
    const expectFail = async (name, fn, re) => {
        try { await fn(); } catch (e) { if (re.test(e.message)) { console.log(`guard ok (${name}): ${e.message.split('\n')[0]}`); return; } throw new Error(`guard "${name}" failed with the wrong message: ${e.message}`); }
        throw new Error(`guard "${name}" did not refuse`);
    };
    const one = WALLET_SCENES[1];
    await expectFail('wrong primary count', () => renderScene({ ...one, primary: 2 }), /primary actions visible/);
    await expectFail('missing element', () => renderScene({ ...one, build: async () => { const w = await one.build(); w.doc.querySelector('header.topbar .connect-wallet-btn').remove(); return w; } }), /no header\.topbar \.connect-wallet-btn/);
    const ok = sceneFile(one.id, await renderScene(one), 375);
    checkFile(ok);
    await expectFail('remote font url', async () => checkFile(ok.replace('</style>', '@font-face{src:url(https://x.test/a.woff2)}</style>')), /not a data: URI/);
    await expectFail('remote image', async () => checkFile(ok.replace('srcdoc="', 'srcdoc="&lt;img src=&quot;logo.png&quot;&gt;')), /not a data: URI|byte for byte/);
    await expectFail('styles.css changed', async () => checkFile(ok.replace('.wallet-ext-tile {', '.wallet-ext-tile  {')), /byte for byte/);
    await expectFail('font without data source', async () => checkFile(ok.replace(/@font-face \{ font-family: 'Inter'/g, "@font-face { font-family: 'Other'")), /Inter @font-face/);
    await expectFail('header not drawn by the rule', () => renderScene(one, null, { paint: false }), /the header is drawn solid, the page rule says outline/);
    const hubScene = VALIDATE_SCENES[1];
    await expectFail('hub: two primaries', () => renderScene({ ...hubScene, build: async () => { const w = await hubScene.build(); w.q('.validate-path-link').classList.add('validate-primary'); return w; } }, checkValidateScene), /2 primary actions visible/);
    const wizScene = WP3_SCENES[0];
    await expectFail('wp3: two primaries', () => renderScene({ ...wizScene, build: async () => { const w = await wizScene.build(); w.q('[data-setup-action="check-node"]').classList.add('validate-primary'); return w; } }, checkWp3Scene), /2 primary actions visible/);
    await expectFail('wp3: header solid on a connected wizard', () => renderScene(wizScene, checkWp3Scene, { paint: false }), /the header is drawn solid, the page rule says connected/);
    await expectFail('hub: nav not active', () => renderScene({ ...hubScene, build: async () => { const w = await hubScene.build(); w.q('#nav-validate').classList.remove('active'); return w; } }, checkValidateScene), /no active #nav-validate/);
}

// ── run ──
async function main() {
    if (args.includes('--selftest')) { await guardSelfTest(); return 0; }
    const out = arg('--out');
    if (!out) { console.error('usage: node --experimental-sqlite tools/preview-scenes.mjs --out <dir> [--wp 1] [--scene <id>] [--selftest]'); return 2; }
    const wps = arg('--wp') ? [Number(arg('--wp'))] : Object.keys(WORK_PACKAGES).map(Number);
    const only = arg('--scene');
    const files = [];
    for (const n of wps) {
        const wp = WORK_PACKAGES[n];
        if (!wp) { console.error('no work package ' + n); return 2; }
        for (const s of wp.scenes) {
            if (only && s.id !== only) continue;
            const inner = await renderScene(s, wp.check);
            for (const width of s.widths || WIDTHS) { const html = sceneFile(s.id, inner, width, s.scroll || ''); checkFile(html); files.push([`wp${n}-${s.id}-${width}.html`, html]); }
        }
        if (wp.palette && !only) { const html = paletteHtml(); checkFile(html, { palette: true }); files.push([`wp${n}-palette.html`, html]); }
    }
    mkdirSync(out, { recursive: true });
    for (const [name, html] of files) writeFileSync(`${out}/${name}`, html);
    console.log(`wrote ${files.length} files to ${out}`);
    return 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    try { process.exit(await main()); } catch (e) { console.error('REFUSED, no file written:\n' + e.message); process.exit(1); }
}
