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
// package may name its own file prefix, as R1 does: r1-<scene>-<width>.html; a
// package may bring its own page guard as `check`). WP2: the Validate hub, the dashboard and /validate/keys.
// locks: the Balance breakdown redesign (locks-<scene>-<width>.html), no primary in any scene.
// stake: the Stake PDEX card's simple view (stake-simple-<scene>-<width>.html, design 10.3 WP2): the real modal markup
// over the wallet page, the REAL lib/stake-card-view.js over a validator snapshot run through the real loadPickerData.
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
import { createKnownResults } from '../lib/known-results.js';
import { createPostAction } from '../lib/post-action.js';
import { effectsFor } from '../lib/action-effects.js';
import { createPayoutRefresh } from '../lib/payout-refresh.js';
import { describeAccountLocks } from '../lib/balance-locks.js';
import { mountBalanceLocks } from '../lib/balance-locks-view.js';
import { caughtUp, pollDeadlineMs } from '../lib/freshness.js';
import { createStakeCard } from '../lib/stake-card-view.js';
import { loadPickerData } from '../lib/stake-picker-view.js';
import { FEE_MARGIN } from '../lib/fee-preflight.js';

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

// ── R1, post-action refresh (cto-team/plans/2026-11-22-post-action-refresh-ux.md, section 7): the wallet card's
// Unpaid Rewards tile and Pay Out button after a payout. The tile and the button are the REAL markup of
// lib/payout-refresh.js with the REAL known-results store applied; the rest of the card is a fixture copy of
// script.js renderWalletDashboard (it is not importable), with the same classes. Five unpaid entries.
const R1_ENTRIES = [501, 502, 503, 504, 505].map((era, i) => ({ era, validator: vaddr(40 + i), amount: [2.4689, 2.4689, 2.4512, 2.4423, 2.4401][i] }));
const R1_KEY = (e) => `${e.era}:${e.validator}`;
const r1fmt = { pdex: (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }), number: (n) => Number(n).toLocaleString('en-US'), short: (a) => shortAddr(a), esc: escapeHtml };
function r1world({ known = [], ageMs = 0, server = R1_ENTRIES } = {}) {
    const window = new Window();
    const doc = window.document;
    doc.body.innerHTML = shellHtml('wallet', '#nav-my-account');
    const clock = () => clock.t;
    clock.t = 10_000_000;
    const store = createKnownResults({ storage: null, now: clock });
    store.add(known.map(k => ({ account: ME, domain: 'rewards.unpaid', op: k.op, key: R1_KEY(R1_ENTRIES[k.i]), block: 4_210_377, txHash: '0x' + '12'.repeat(32) })));
    clock.t += ageMs;
    const core = createPostAction({ effects: effectsFor, known: store, now: clock });
    const wallet = { address: ME, rewards: { claimedTotal: 41.2, unpaidTotal: server.reduce((t, e) => t + e.amount, 0), unpaidCount: server.length, unclaimedFresh: true, unpaidEntries: server } };
    const pr = createPayoutRefresh({ doc, known: store, post: core, data: () => wallet, fmt: r1fmt, now: clock });
    const tile = (label, value, cls = '') => `<div class="staking-summary-card"><div class="label">${label}</div><div class="value${cls}">${value}</div></div>`;
    const btn = (id, icon, title, sub, primary = '') => `<button class="wallet-action-btn${primary}" id="${id}"><i class='bx ${icon}'></i><div><strong>${title}</strong><span>${sub}</span></div></button>`;
    doc.querySelector('#wallet-dashboard').innerHTML = `<div class="list-container glass">
        <div class="list-header"><h2><i class='bx bx-wallet'></i> My Account</h2><div style="display:flex; gap:14px; align-items:center;"><button class="staking-download-btn">Switch wallet</button><button class="staking-download-btn">Disconnect</button></div></div>
        <div style="padding: 12px 24px 0;"><a href="#" class="item-link" style="color:var(--text-secondary);font-size:0.78rem;">${ME}</a></div>
        <div class="staking-summary-grid">${tile('Total Balance', '1,204.5521 PDEX', ' accent')}${tile('Total Staked', '1,150.0000 PDEX')}${tile('Claimed Rewards', '41.2000 PDEX')}${pr.tileHtml(wallet)}</div>
        <div id="wallet-actions-slot"><div class="wallet-action-bar" id="wallet-action-bar">${btn('wallet-act-send', 'bx-paper-plane', 'Send PDEX', 'Transfer to any Polkadex address', ' primary')}${btn('wallet-act-stake', 'bx-plus-circle', 'Stake more', 'Add bond &amp; choose validators')}${pr.buttonHtml(wallet)}${btn('wallet-act-unstake', 'bx-minus-circle', 'Unstake', 'Begin the unbonding period')}${btn('wallet-act-identity', 'bx-id-card', 'Set identity', 'Display name, email, twitter')}</div></div>
    </div>`;
    pr.paint({ reason: 'render' });   // as renderWalletDashboard does after its innerHTML
    const qa = (sel) => Array.from(doc.querySelectorAll(sel));
    const visible = (el) => !!el && !el.closest('[hidden]');
    return { window, doc, qa, visible, q: (sel) => doc.querySelector(sel), d: { account: { status: 'connected', address: ME } } };
}
const R1_SCENES = [
    { id: 'rewards-before', primary: 1, need: '#wallet-act-payout:not([aria-disabled])', build: async () => r1world() },
    { id: 'rewards-just-paid', primary: 1, need: '#wallet-act-payout[aria-disabled="true"]', build: async () => r1world({ known: [0, 1, 2, 3, 4].map(i => ({ op: 'remove', i })) }) },
    { id: 'rewards-checking', primary: 1, need: '#wallet-act-payout[aria-describedby="wallet-payout-why"]', build: async () => r1world({ known: [{ op: 'remove', i: 0 }, { op: 'remove', i: 1 }, { op: 'remove', i: 2 }, { op: 'hold', i: 3 }, { op: 'hold', i: 4 }] }) },
    { id: 'rewards-could-not-refresh', primary: 1, need: '#wallet-unpaid-label .ui-chip.is-wait.is-bare', build: async () => r1world({ known: [{ op: 'remove', i: 0 }, { op: 'remove', i: 1 }, { op: 'remove', i: 2 }, { op: 'hold', i: 3 }, { op: 'hold', i: 4 }], ageMs: 181_000 }) },
    { id: 'rewards-one-minute-later', primary: 1, need: '#wallet-act-payout[disabled]', build: async () => r1world({ known: [0, 1, 2, 3, 4].map(i => ({ op: 'remove', i })), ageMs: 60_000, server: [] }) }
];
function checkR1Scene(w, s, err) {
    if (!w.doc.querySelector('aside.sidebar .nav-item.active#nav-my-account')) err.push('no active #nav-my-account in the sidebar');
    if (!w.doc.querySelector('.page-section[data-page="wallet"] #wallet-dashboard #wallet-unpaid-tile')) err.push('no #wallet-unpaid-tile in the wallet dashboard');
    const n = w.qa('.wallet-action-btn.primary').filter(w.visible).length;
    if (n !== s.primary) err.push(`${n} primary actions visible, the spec table wants ${s.primary}`);
    if (s.need && w.qa(s.need).filter(w.visible).length < 1) err.push(`no visible ${s.need}`);
}

// ── Locked balances (cto-team/plans/2026-11-22-locked-balances-redesign.md, section 7): the Balance breakdown on
// My Account, drawn by the REAL lib/balance-locks-view.js from REAL model snapshots (lib/balance-locks.js
// describeAccountLocks), with the REAL post-action core where a scene needs an action. Own account, header
// connected (a looked-up or no-wallet scene says so). No scene shows a primary (spec 2.3).
const LPDEX = 10n ** 12n;
const ls = (v) => v.toString();
const LP = (x) => BigInt(Math.round(x * 1e4)) * 10n ** 8n;
const LNOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const LDAY = 86400000;
const llock = (id, amount) => ({ id, amount: ls(amount), reasons: 'All' });
// A ledger as the chain keeps it: total = active + every unlocking chunk.
const lbond = (total, chunks, over = {}) => ({ bonded: true, total: ls(total), active: ls(total - chunks.reduce((a, c) => a + BigInt(c.value), 0n)), unlocking: '0', chunks,
    currentEra: 120, activeEra: 120, activeEraStart: LNOW, spans: 0, controller: ME, stash: ME, ...over });
function lsnap(over = {}) {
    return { address: ME, now: LNOW, free: ls(20_000n * LPDEX), reserved: '0', frozen: '0', ed: ls(LPDEX), block: 1_000_000, blockMs: 12000, bondingDays: 28, eraMs: LDAY,
        locks: [], freezes: [], holds: [], reserves: [], staking: { bonded: false, total: '0', active: '0', unlocking: '0', chunks: [], currentEra: null, activeEra: null, activeEraStart: null, spans: 0, controller: null, stash: null },
        democracy: null, elections: null, identity: null, proxy: null, pallets: { vesting: false, ormlVesting: false }, ...over };
}
const lmodel = (over, head = 41) => ({ address: ME, ...describeAccountLocks(lsnap(over)), freshness: { v: 1, chainHead: head } });
// The CEO's account as his screenshot shows it: a staking hold and ledger total of 17,348.0818 PDEX, active 17,068.0232,
// one chunk of 280.0586 PDEX unlocking at era 1907 (about 2026-12-16); a 15,000 PDEX council vote and its 13.59 PDEX deposit.
const LHOLD = LP(17348.0818);
const LSTAKE = { holds: [{ id: 'Staking.Staking', amount: ls(LHOLD) }], staking: lbond(LHOLD, [{ value: ls(LP(280.0586)), era: 1907 }], { currentEra: 1883, activeEra: 1883 }) };
const L_CEO = (head) => lmodel({ ...LSTAKE, reserved: ls(LHOLD + LP(13.59)), frozen: ls(15_000n * LPDEX), locks: [llock('phrelect', 15_000n * LPDEX)],
    elections: { voter: { votes: 5, stake: ls(15_000n * LPDEX), deposit: ls(LP(13.59)) }, candidacy: null } }, head);
const L_CEO_AFTER = () => lmodel({ ...LSTAKE, reserved: ls(LHOLD) }, 42);
const L_DEM = (dem, lockAmount, over = {}) => lmodel({ locks: [llock('democrac', lockAmount)], frozen: ls(lockAmount), democracy: { delegating: false, lockingPeriod: 216000, prior: { until: 0, amount: '0' }, ...dem }, ...over });
const L_VOTE = (index, aye, conviction, amount) => ({ index, aye, conviction, balance: ls(amount) });
const L_ORPHAN = (head) => lmodel({ locks: [llock('staking ', 60n * LPDEX)], frozen: ls(60n * LPDEX) }, head);
const L_READY = (over = {}) => lmodel({ holds: [{ id: 'Staking.Staking', amount: ls(1_000n * LPDEX) }], reserved: ls(1_000n * LPDEX),
    staking: lbond(1_000n * LPDEX, [{ value: ls(150n * LPDEX), era: 110 }, { value: ls(LP(280.0586)), era: 144 }], over) });
const L_SCENES_DATA = {
    'ceo-case': [L_CEO()],
    'ready-withdraw': [L_READY()],
    'democracy-unlock-now': [L_DEM({ votes: [L_VOTE(4, false, 'None', 400n * LPDEX)], referenda: { 4: { finished: true, approved: true, end: 900_000 } } }, 400n * LPDEX)],
    'democracy-mixed': [L_DEM({ prior: { until: 1_000_000 + 7200 * 3, amount: ls(300n * LPDEX) }, votes: [L_VOTE(7, true, 'Locked2x', 120n * LPDEX), L_VOTE(9, true, 'None', 200n * LPDEX)],
        referenda: { 7: { finished: true, approved: true, end: 950_000 }, 9: { ongoing: true, end: 1_000_000 + 7200 * 5 } } }, 300n * LPDEX)],
    'democracy-tidy': [L_DEM({ prior: { until: 1_000_000 + 7200 * 9, amount: ls(400n * LPDEX) }, votes: [L_VOTE(4, false, 'None', 100n * LPDEX)], referenda: { 4: { finished: true, approved: true, end: 900_000 } } }, 400n * LPDEX)],
    delegating: [L_DEM({ delegating: true, target: THEM, conviction: 'Locked2x', balance: ls(250n * LPDEX) }, 250n * LPDEX)],
    'leftover-lock': [L_ORPHAN()],
    'old-and-unknown': [lmodel({ locks: [llock('ormlvest', 12n * LPDEX), llock('vesting ', 5n * LPDEX), llock('zzzzzzzz', 3n * LPDEX)], frozen: ls(12n * LPDEX), freezes: [{ id: 'X', amount: ls(LPDEX) }] })],
    'deposits-all': [lmodel({ reserved: ls(20n * LPDEX), holds: ['Preimage.Preimage', 'Council.ProposalSubmission', 'TechnicalCommittee.ProposalSubmission', 'Session.Keys', 'DelegatedStaking.StakingDelegation', 'SafeMode.EnterOrExtend', 'X.Y'].map(id => ({ id, amount: ls(LPDEX) })),
        reserves: [{ id: 'abcdefgh', amount: ls(LPDEX) }], identity: { deposit: ls(LPDEX), subsDeposit: ls(2n * LPDEX), subs: 2 }, proxy: { deposit: ls(LPDEX), count: 1, announcementDeposit: ls(LPDEX) },
        elections: { voter: null, candidacy: { role: 'Member', deposit: ls(LPDEX) } } })],
    vesting: [lmodel({ locks: [llock('vesting ', 500n * LPDEX)], frozen: ls(500n * LPDEX), pallets: { vesting: true } })],
    empty: [lmodel({})],
    'fee-blocked': [lmodel({ free: ls(100n * LPDEX), reserved: ls(50n * LPDEX), frozen: ls(300n * LPDEX), locks: [llock('democrac', 300n * LPDEX)], holds: [{ id: 'Staking.Staking', amount: ls(50n * LPDEX) }],
        staking: lbond(50n * LPDEX, []) })]
};
// A world: the wallet page, the panel mounted with a manual clock and the real core; steps act on it.
async function locksWorld(models, { connected = ME, page = 'wallet', steps = null, api = () => ({}), submit = null, pending = false } = {}) {
    const window = new Window({ url: 'https://explorer.test/wallet' });
    const doc = window.document;
    doc.body.innerHTML = shellHtml('wallet', '#nav-my-account');
    doc.querySelector('#wallet-dashboard').innerHTML = '<div id="wallet-locks-slot"></div>';
    const el = doc.querySelector('#wallet-locks-slot');
    let t = 0, seq = 0;
    const timers = new Map();
    const clock = { now: () => t, set: (f, ms) => { const id = ++seq; timers.set(id, { at: t + Math.max(0, Number(ms) || 0), f }); return id; }, clear: (id) => timers.delete(id) };
    const tickTo = async (ms) => { const end = t + ms; for (;;) { const d = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!d) break; timers.delete(d[0]); t = d[1].at; d[1].f(); await tick(5); } t = end; };
    const queue = models.slice();
    const fetchJson = async () => { if (pending) return new Promise(() => {}); const m = queue.length > 1 ? queue.shift() : queue[0]; if (m instanceof Error) throw m; return m; };
    const known = createKnownResults({ storage: null, now: clock.now });
    const post = createPostAction({ effects: effectsFor, known, same: (a, b) => a === b, now: clock.now, setTimer: clock.set, clearTimer: clock.clear, caughtUp, deadlineMs: pollDeadlineMs });
    const jobs = [];
    const fakeSubmit = submit || (async (o) => {
        const seen = post.observe({ key: o.action.key, params: o.action.params });
        const show = seen.show((a, st) => ({ stage: st, outcome: { ok: true } }));
        const stage = seen.stage(o.onStage);
        jobs.push({ o, inBlock: async (block) => { show({}, 'inBlock', [{ event: { section: 'system', method: 'ExtrinsicSuccess', data: [] } }], null, { blockNumber: block, txHash: '0x' + 'ab'.repeat(32), address: connected }); stage('inBlock', { stage: 'inBlock', outcome: { ok: true } }); await o.onSuccess(); await tick(5); } });
    });
    const opts = { fetchJson, helpIcon, page, post, unstake: () => page === 'wallet' && connected === ME, openUnstake: () => {},
        now: clock.now, setTimer: clock.set, clearTimer: clock.clear, reducedMotion: () => false,
        actions: { submit: fakeSubmit, connected: () => connected, isSame: (a, b) => a === b, api } };
    const mounting = mountBalanceLocks(el, ME, opts);
    if (!pending) await mounting;
    await tick(5);
    const qa = (sel) => Array.from(doc.querySelectorAll(sel));
    const w = { window, doc, el, qa, remount: () => mountBalanceLocks(el, ME, opts), visible: (x) => !!x && !x.closest('[hidden]'), q: (sel) => doc.querySelector(sel), jobs, tickTo, d: { account: connected ? { status: 'connected', address: connected } : { status: 'none' } } };
    if (steps) await steps(w);
    return w;
}
// A deliberate confirm: a second after the press that opened the strip (a quicker one is the same gesture and ignored).
const lpress = async (w, sel, confirm = true) => { w.q(sel).click(); await tick(5); const yes = confirm && w.q('.lock-confirm .ui-action'); if (yes) { await w.tickTo(1000); yes.click(); await tick(5); } };
const LOCKS_SCENES = [
    ...Object.entries(L_SCENES_DATA).map(([id, models]) => ({ id, primary: 0, connected: ME, build: () => locksWorld(models) })),
    { id: 'first-load', primary: 0, connected: ME, need: '.lock-skeleton', build: () => locksWorld([L_CEO()], { pending: true }) },
    { id: 'read-failed', primary: 0, connected: ME, need: '.lock-failed', build: () => locksWorld([new Error('down')]) },
    { id: 'looked-up', primary: 0, connected: THEM, need: '.lock-connect', build: () => locksWorld([L_CEO()], { connected: THEM, page: 'account' }) },
    { id: 'no-wallet', primary: 0, need: '.lock-connect', build: () => locksWorld([L_ORPHAN()], { connected: null, page: 'account' }) },
    { id: 'controller-differs', primary: 0, connected: ME, need: '.lock-connect', build: () => locksWorld([L_READY({ controller: THEM })]) },
    { id: 'confirm-open', primary: 0, connected: ME, need: '.lock-confirm', build: () => locksWorld([L_CEO()], { steps: async (w) => { w.q('[data-lock-action="elections-remove"]').click(); await tick(5); } }) },
    { id: 'busy', primary: 0, connected: ME, need: '.ui-action[aria-busy="true"]', build: () => locksWorld([L_CEO()], { submit: () => new Promise(() => {}), steps: (w) => lpress(w, '[data-lock-action="elections-remove"]') }) },
    { id: 'settled', primary: 0, connected: ME, need: '.lock-row.is-settled', build: () => locksWorld([L_CEO(), L_CEO_AFTER()], { steps: async (w) => { await lpress(w, '[data-lock-action="elections-remove"]'); await w.jobs[0].inBlock(42); } }) },
    { id: 'changed-in-place', primary: 0, connected: ME, need: '.lock-row-msg.is-positive', build: () => locksWorld([L_DEM({ votes: [L_VOTE(4, false, 'None', 400n * LPDEX), L_VOTE(7, true, 'Locked2x', 120n * LPDEX)], referenda: { 4: { finished: true, approved: true, end: 900_000 }, 7: { finished: true, approved: true, end: 950_000 } } }, 400n * LPDEX),
        L_DEM({ votes: [L_VOTE(7, true, 'Locked2x', 120n * LPDEX)], referenda: { 7: { finished: true, approved: true, end: 950_000 } } }, 120n * LPDEX, {}), ], { steps: async (w) => { await lpress(w, '[data-lock-action="democracy-unlock"]'); await w.jobs[0].inBlock(42); } }) },
    { id: 'checking', primary: 0, connected: ME, need: '.ui-chip.is-bare', build: () => locksWorld([L_ORPHAN(), lmodel({}, 42)], { api: () => ({ query: { balances: { locks: () => new Promise(() => {}) } } }), steps: async (w) => { await lpress(w, '[data-lock-action="migrate-currency"]'); w.jobs[0].inBlock(42); await tick(10); } }) },
    { id: 'failed', primary: 0, connected: ME, need: '.lock-row-msg[role="alert"]', build: () => locksWorld([L_CEO()], { submit: async (o) => { o.onError('The transaction failed on chain: you have no council vote to remove.'); }, steps: (w) => lpress(w, '[data-lock-action="elections-remove"]') }) },
    { id: 'not-confirmed', primary: 0, connected: ME, need: '.lock-row-msg.is-wait', build: () => locksWorld([L_ORPHAN()], { submit: async (o) => { o.onStage('unconfirmed'); }, steps: (w) => lpress(w, '[data-lock-action="migrate-currency"]') }) },
    { id: 'could-not-refresh', primary: 0, connected: ME, need: '.lock-behind', build: () => locksWorld([L_CEO(), new Error('down')], { steps: async (w) => { await w.remount(); await tick(5); } }) }
].map(s => ({ ...s, widths: [1280, 375] }));
// The scene guard (spec 7): the panel is there, no primary, no table, no chain id outside Details, every button an
// action button (whose 44 px is the stylesheet's, test/lock-rows.test.js), and the scene's own element.
const LOCK_CHAIN_ID = /phrelect|Staking\.Staking|democrac\b|withdrawUnbonded|removeVoter|migrateCurrency|ormlvest|zzzzzzzz|Preimage\.Preimage|\.ProposalSubmission/;
function checkLocksScene(w, s, err) {
    if (!w.doc.querySelector('aside.sidebar .nav-item.active#nav-my-account')) err.push('no active #nav-my-account in the sidebar');
    const panel = w.doc.querySelector('.page-section[data-page="wallet"] #wallet-locks-slot section.balance-locks');
    if (!panel) { err.push('no Balance breakdown panel'); return; }
    const n = w.qa(PAGE_PRIMARY_SELECTOR).filter(w.visible).length;
    if (n !== s.primary) err.push(`${n} primary actions visible, the spec table wants ${s.primary}`);
    if (panel.querySelector('table, [role="table"]')) err.push('a table in the panel');
    const shown = panel.cloneNode(true);
    for (const d of shown.querySelectorAll('details')) d.remove();
    if (LOCK_CHAIN_ID.test(shown.textContent)) err.push(`a chain id outside Details: ${shown.textContent.match(LOCK_CHAIN_ID)[0]}`);
    for (const b of panel.querySelectorAll('button')) if (!b.classList.contains('ui-action') && !b.classList.contains('validate-secondary') && !b.classList.contains('validate-text-btn')) err.push(`a button that is not an action button: ${b.className}`);
    if (s.need && w.qa(s.need).filter(w.visible).length < 1) err.push(`no visible ${s.need}`);
}

// ── Stake card WP2 (cto-team/plans/2026-11-22-stake-card-simple-and-advanced.md, section 10.3): the simple view of the
// Stake PDEX card open over My Account, own account connected. The card is the REAL lib/stake-card-view.js in the REAL
// modal markup of index.html; the validators are "Validator A" to "Validator L" (and T) at filler addresses.
const STAKE_NET = { minStake: 100, eraDurationMs: 86_400_000, unbondingMs: 28 * 86_400_000 };
const sdur = (ms) => { const h = ms / 3600000; return h < 48 ? (Math.round(h * 10) / 10) + ' hours' : (Math.round(h / 24 * 10) / 10) + ' days'; };
const sval = (n, apr, over = {}) => ({ address: vaddr(40 + n), name: `Validator ${String.fromCharCode(64 + n)}`, active: true, commission: [5, 3, 7, 5, 10, 4, 6, 5, 8, 2, 9, 5][(n - 1) % 12], blocked: false,
    selfStake: 1000 + n, totalStake: 50000, exposurePages: n === 6 ? 2 : 1, exposureNominators: 20, backers: 20, identity: { hasIdentity: false, verified: false, parent: null }, slashEras: [],
    commissionHistory: { raisedRecently: false, pendingRaise: false }, perf: { 28: { status: 'ok', apr, erasUsed: 28, electedEras: 28, missedEras: 0, reliability: 100 } }, ...over });
const SAPR = [19.42, 18.97, 18.61, 18.2, 17.88, 17.5, 17.31, 16.9, 16.4, 15.8, 15.1, 14.6];
const slist = (over = {}) => SAPR.map((apr, i) => sval(i + 1, apr, over[i + 1] || {}));
const STAKE_T = (over = {}) => sval(20, 17.9, { name: 'Validator T', active: false, ...over });
const ssnap = (list, full = true) => loadPickerData(async (url) => (url.endsWith('validator-choice')
    ? (full ? { validators: list, activeEra: 1884, maxNominations: 16, exposurePageSize: 256 } : { status: 'Initializing', validators: [] })
    : { validators: list.map(v => ({ address: v.address, name: v.name, commission: v.commission, totalStake: v.totalStake })), commissionHistoryEra: 1884 }));
const sfirst = (balance = { free: 1204.55, transferable: 1203.55 }) => ({ address: ME, balance, staking: { totalStaked: 0, nominating: [], ledgerRead: 'ok', controller: null }, network: STAKE_NET });
const sstaker = (ns, totalStaked = 1150) => ({ address: ME, balance: { free: 1204.55, transferable: 54.55 },
    staking: { totalStaked, nominating: ns.map(n => ({ address: vaddr(40 + n), name: `Validator ${String.fromCharCode(64 + n)}` })), ledgerRead: 'ok', controller: totalStaked > 0 ? ME : null }, network: STAKE_NET });
async function stakeWorld({ data, list = slist(), full = true, payee = { kind: 'staked', account: '' }, typed = '', steps = null }) {
    const window = new Window({ url: 'https://explorer.test/wallet' });
    const doc = window.document;
    doc.body.innerHTML = shellHtml('wallet', '#nav-my-account');
    doc.querySelector('#wallet-dashboard').innerHTML = `<div class="list-container glass"><div class="list-header"><h2><i class='bx bx-wallet'></i> My Account</h2></div></div>`;
    const html = rd('index.html');
    const modal = html.slice(html.indexOf('<div id="stake-modal"'), html.indexOf('<!-- Payout Rewards Modal -->')).replace('style="display: none;', 'style="display: flex;');
    doc.querySelector('.app-container').insertAdjacentHTML('beforeend', modal);
    let selected = [];
    const card = createStakeCard({ root: doc.getElementById('stake-modal'), storage: null, esc: escapeHtml, short: shortAddr, duration: sdur, same: (a, b) => a === b,
        connected: () => ME, feeFloorPlanck: FEE_MARGIN, quota: () => 16, reload: () => {},
        selection: { get: () => selected.slice(), set: (rows) => { selected = rows.map(r => ({ address: r.address, name: r.name })); } } });
    selected = (data.staking.nominating || []).map(v => ({ address: v.address, name: v.name }));
    card.open({ data });
    if (data.staking.totalStaked > 0) card.setPayee(payee);
    card.setSnapshot(await ssnap(list, full));
    const qa = (sel) => Array.from(doc.querySelectorAll(sel));
    const w = { window, doc, qa, q: (sel) => doc.querySelector(sel), card, visible: (x) => !!x && !x.closest('[hidden]'), d: { account: { status: 'connected', address: ME } },
        type: (v) => { const i = doc.getElementById('stake-amount-input'); i.value = v; i.dispatchEvent(new window.Event('input', { bubbles: true })); },
        dropOne: () => { selected = selected.slice(0, -1); card.markManual(); } };
    if (typed) w.type(typed);
    if (steps) await steps(w);
    return w;
}
const STAKE_SCENES = [
    { id: 'stake-simple-first-empty', primary: 1, build: () => stakeWorld({ data: sfirst() }) },
    { id: 'stake-simple-first-amount', primary: 1, need: '[data-sc="SC-23"]', build: () => stakeWorld({ data: sfirst(), typed: '250' }) },
    { id: 'stake-simple-picks-open', primary: 1, need: 'details.stake-validators[open] [data-sc="SC-32"]', build: () => stakeWorld({ data: sfirst(), typed: '250',
        steps: (w) => { w.q('details.stake-validators').open = true; w.q('details.stake-call-details').open = true; } }) },
    { id: 'stake-simple-existing-add', primary: 1, need: '[data-sc="SC-11b"]', build: () => stakeWorld({ data: sstaker([1, 2, 3, 4, 5, 7, 8, 9]), typed: '25' }) },
    { id: 'stake-simple-unhealthy', primary: 1, need: '[data-sc="SC-160"]', build: () => stakeWorld({ data: sstaker([1, 2, 3, 20]), list: [...slist(), STAKE_T()] }) },
    { id: 'stake-simple-replacement', primary: 1, need: '.stake-proposal [data-group="removed"] .ui-chip', build: () => stakeWorld({ data: sstaker([1, 2, 3, 20]), list: [...slist(), STAKE_T()],
        steps: (w) => w.q('[data-stake-action="replace"]').click() }) },
    { id: 'stake-simple-short-pool', primary: 1, need: '[data-sc="SC-37"]', build: () => stakeWorld({ data: sfirst(), list: slist(Object.fromEntries(SAPR.map((_, i) => [i + 1, i < 3 ? {} : { active: false }]))) }) },
    { id: 'stake-simple-no-data', primary: 1, need: '[data-sc="SC-114"]', build: () => stakeWorld({ data: sfirst(), full: false, typed: '250' }) },
    { id: 'stake-simple-cannot-stake', primary: 0, need: '[data-sc="SC-115"]', build: () => stakeWorld({ data: sfirst({ free: 61.3, transferable: 60.3 }) }) },
    { id: 'stake-simple-over-limit', primary: 1, need: '[data-sc="SC-102"]', build: () => stakeWorld({ data: sfirst(), typed: '1203.55' }) },
    { id: 'stake-simple-low-reserve', primary: 1, need: '[data-sc="SC-104"]', build: () => stakeWorld({ data: sfirst(), typed: '1203.45' }) },
    { id: 'stake-simple-staked-no-validators', primary: 1, need: '[data-sc="SC-140"]', build: () => stakeWorld({ data: sstaker([]) }) },
    { id: 'stake-simple-manual-selection', primary: 1, need: '[data-sc="SC-30b"]', build: () => stakeWorld({ data: sfirst(), typed: '250', steps: (w) => w.dropOne() }) }
].map(s => ({ ...s, connected: ME, widths: [1280, 375] }));
function checkStakeScene(w, s, err) {
    if (!w.doc.querySelector('aside.sidebar .nav-item.active#nav-my-account')) err.push('no active #nav-my-account in the sidebar');
    const modal = w.doc.querySelector('#stake-modal');
    if (!modal || modal.style.display !== 'flex') { err.push('the stake card is not open'); return; }
    const n = w.qa(PAGE_PRIMARY_SELECTOR).filter(w.visible).length;
    if (n !== s.primary) err.push(`${n} primary actions visible, the spec table wants ${s.primary}`);
    for (const b of w.qa('#stake-modal button').filter(w.visible)) if (/\bis-(positive|wait|info|ok|warn)\b/.test(b.className)) err.push(`a coloured action: ${b.className}`);
    for (const c of w.qa('#stake-modal .ui-chip').filter(w.visible)) if (!c.querySelector('.bx') || !c.textContent.trim()) err.push('a chip without an icon and a word');
    if (s.need && w.qa(s.need).filter(w.visible).length < 1) err.push(`no visible ${s.need}`);
}

// ── work packages: later rounds add theirs here ──
const WORK_PACKAGES = { 1: { scenes: WALLET_SCENES, palette: true }, 2: { scenes: VALIDATE_SCENES, check: checkValidateScene }, 3: { scenes: WP3_SCENES, check: checkWp3Scene }, r1: { scenes: R1_SCENES, check: checkR1Scene, prefix: 'r1' }, locks: { scenes: LOCKS_SCENES, check: checkLocksScene, prefix: 'locks' },
    stake: { scenes: STAKE_SCENES, check: checkStakeScene, prefix: '' } };

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
    await expectFail('r1: payout tile missing', () => renderScene({ ...R1_SCENES[0], build: async () => { const w = await R1_SCENES[0].build(); w.q('#wallet-unpaid-tile').remove(); return w; } }, checkR1Scene), /no #wallet-unpaid-tile/);
    const lockScene = LOCKS_SCENES[0];
    await expectFail('locks: a primary in the panel', () => renderScene({ ...lockScene, build: async () => { const w = await lockScene.build(); w.q('.ui-action').classList.add('validate-primary'); return w; } }, checkLocksScene), /1 primary actions visible/);
    await expectFail('locks: a chain id outside Details', () => renderScene({ ...lockScene, build: async () => { const w = await lockScene.build(); w.q('.lock-line').textContent = 'phrelect'; return w; } }, checkLocksScene), /a chain id outside Details: phrelect/);
    const stakeScene = STAKE_SCENES[1];
    await expectFail('stake: two primaries', () => renderScene({ ...stakeScene, build: async () => { const w = await stakeScene.build(); w.q('[data-stake-action="choose"]').classList.add('validate-primary'); return w; } }, checkStakeScene), /2 primary actions visible/);
    await expectFail('hub: nav not active', () => renderScene({ ...hubScene, build: async () => { const w = await hubScene.build(); w.q('#nav-validate').classList.remove('active'); return w; } }, checkValidateScene), /no active #nav-validate/);
}

// ── run ──
async function main() {
    if (args.includes('--selftest')) { await guardSelfTest(); return 0; }
    const out = arg('--out');
    if (!out) { console.error('usage: node --experimental-sqlite tools/preview-scenes.mjs --out <dir> [--wp 1] [--scene <id>] [--selftest]'); return 2; }
    const wps = arg('--wp') ? [arg('--wp')] : Object.keys(WORK_PACKAGES);
    const only = arg('--scene');
    const files = [];
    for (const n of wps) {
        const wp = WORK_PACKAGES[n];
        if (!wp) { console.error('no work package ' + n); return 2; }
        for (const s of wp.scenes) {
            if (only && s.id !== only) continue;
            const inner = await renderScene(s, wp.check);
            for (const width of s.widths || WIDTHS) { const html = sceneFile(s.id, inner, width, s.scroll || ''); checkFile(html); files.push([`${wp.prefix === '' ? '' : (wp.prefix || 'wp' + n) + '-'}${s.id}-${width}.html`, html]); }
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
