// Preview generator for the Connect wallet chooser (never shipped, never run by
// npm test). Spec: cto-team/plans/2026-11-17-brand-identity-pass.md section 5.
//
//   node --experimental-sqlite test/helpers/preview-chooser.mjs <out.html>
//
// It loads the branch's REAL index.html (the .app-container shell: sidebar with
// the active nav item, topbar with the Connect wallet button, the wallet page
// section and #wallet-dashboard), mounts the REAL chooser (lib/wallet-picker-view.js)
// into it in happy-dom for each scene, and serialises the result. The not-connected
// note scene is the real script.js at /wallet/<address> (test/helpers/full-page.js).
// styles.css goes in byte for byte; Inter and Boxicons come from public/vendor
// (npm run vendor) as data: URLs; logo.png as a data: URI. Each scene is shown at
// 1280 px and 390 px in an iframe whose document is built from the one stylesheet,
// so the media queries answer to the frame width. Nothing is fetched at view time.
//
// Guards: the file is not written when a scene lacks a required element, when a
// scene has the wrong number of Solid rows, or when any stylesheet, script, font
// or image reference is not a data: URI. Each guard has a self-test at the end
// of a run with --selftest (it breaks the input and renders the failure message).

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Window } from 'happy-dom';
import { mountChooser, fakeWallet, acct, addr, tick } from './chooser-world.js';
import { mountPairingPanel } from '../../lib/walletconnect-view.js';

const root = new URL('../../', import.meta.url);
const rd = (p, enc = 'utf8') => readFileSync(new URL(p, root), enc);
const out = process.argv[2];
const selftest = process.argv.includes('--selftest');
const b64 = (p) => rd(p, null).toString('base64');

// ── assets ──
const dataFont = (p) => `url(data:font/woff2;base64,${b64(p)}) format('woff2')`;
function interCss() {
    const css = rd('public/vendor/inter.css');
    const blocks = css.match(/\/\* inter-[^*]*\*\/\s*@font-face\s*\{[^}]*\}/g) || [];
    return blocks.filter(b => /inter-latin-(300|400|500|600|700)-normal/.test(b)).map(b => {
        const file = /inter-latin-\d+-normal/.exec(b)[0];
        return b.replace(/src:[^;]*;/, `src: ${dataFont(`public/vendor/inter/${file}.woff2`)};`);
    }).join('\n');
}
function boxiconsCss() {
    const css = rd('public/vendor/boxicons/css/boxicons.min.css');
    return css.replace(/src:url\(\.\.\/fonts\/boxicons\.eot\);src:[^}]*\}/, `src:${dataFont('public/vendor/boxicons/fonts/boxicons.woff2')}}`);
}
const STYLES = rd('styles.css');
const APP_CSS = interCss() + '\n' + STYLES + '\n' + boxiconsCss();
const logoUri = 'data:image/png;base64,' + b64('logo.png');
const qrSrc = rd('public/vendor/qrcode.min.js');

// ── the real shell ──
function shellHtml() {
    const html = rd('index.html');
    const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>') + 7).replace(/<script[\s\S]*?<\/script>/g, '');
    const doc = new Window().document;
    doc.body.outerHTML = body;
    const app = doc.querySelector('.app-container');
    for (const sec of Array.from(app.querySelectorAll('.page-section'))) if (sec.getAttribute('data-page') !== 'wallet') sec.remove();
    const wallet = app.querySelector('.page-section[data-page="wallet"]');
    wallet.removeAttribute('style');
    for (const n of app.querySelectorAll('.nav-item.active')) n.classList.remove('active');
    app.querySelector('#nav-my-account').classList.add('active');
    for (const img of app.querySelectorAll('img[src="logo.png"]')) img.setAttribute('src', logoUri);
    return app.outerHTML;
}
const SHELL = shellHtml();

// ── scenes ──
const TALISMAN = () => fakeWallet('talisman', [acct(10, 'Main account'), acct(12, 'Staking'), acct(13, 'Savings')]);
const POLKADOT = () => fakeWallet('polkadot-js', [acct(11, 'Polkadot.js account'), acct(14, 'Treasury signer')]);
const fakeT = { after() {} };
const mount = (o) => mountChooser(fakeT, { shell: SHELL, ...o });
const setup = async (o, steps = async () => {}) => {
    const w = mount(o);
    // The real QR drawer reads window.QRCode: load the vendored qrcodejs into this window.
    w.window.QRCode = new Function('document', 'window', qrSrc + ';return QRCode;')(w.doc, w.window);
    await w.picker.ready;
    await steps(w);
    return w;
};
const pairing = (onMobile) => async (w) => {
    w.phone.connect = (panel) => {
        w.phone.connects++;
        mountPairingPanel(panel, { uri: 'wc:7f6e5d4c3b2a19080706050403020100ffeeddccbbaa99887766554433221100@2?relay-protocol=irn&symKey=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', onMobile, clipboard: { writeText: async () => {} }, onCancel() {} });
        return new Promise(() => {});
    };
    w.action('phone').click(); await w.settle();
};

const SCENES = [
    { id: 'options-two', title: 'Options: two extensions and a phone (no history, so no Solid row)', primary: 0, build: () => setup({ wallets: [POLKADOT(), TALISMAN()], phone: true }) },
    { id: 'options-one', title: 'Options: one extension (its row is the one Solid)', primary: 1, build: () => setup({ wallets: [TALISMAN()] }) },
    { id: 'options-none', title: 'Options: no extension installed (Get a wallet is the one Solid)', primary: 1, build: () => setup({ phone: true }) },
    { id: 'waiting', title: 'Waiting: the extension popup is open', primary: 0, build: () => setup({ wallets: [Object.assign(TALISMAN(), { hold: true }), POLKADOT()] }, async (w) => { w.row('talisman').click(); await tick(20); }) },
    { id: 'problem', title: 'Problem: the site was refused in the extension', primary: 0, build: () => setup({ wallets: [Object.assign(POLKADOT(), { reject: true }), TALISMAN()] }, async (w) => { w.row('polkadot-js').click(); await w.settle(); w.q('.wallet-picker-back') && w.q('.wallet-picker-back').click(); await w.settle(); }) },
    { id: 'accounts-one', title: 'Accounts: the wallet shared one account (the row is the one Solid)', primary: 1, build: () => setup({ wallets: [fakeWallet('talisman', [acct(10, 'Main account')])] }, async (w) => { w.row('talisman').click(); await w.settle(); }) },
    { id: 'accounts-several', title: 'Accounts: three accounts (the choice is the user\'s, no Solid)', primary: 0, build: () => setup({ wallets: [TALISMAN()] }, async (w) => { w.row('talisman').click(); await w.settle(); }) },
    { id: 'pairing-computer', title: 'Pairing on a computer: scan the code (no button is Solid)', primary: 0, build: () => setup({ wallets: [TALISMAN()], phone: true }, pairing(false)) },
    { id: 'pairing-phone', title: 'Pairing on a phone: Open wallet is the one Solid', primary: 0, solidExtra: '.wc-open', build: () => setup({ onMobile: true, phone: true }, pairing(true)) },
    { id: 'get-first', title: 'Get a wallet: three equal choices', primary: 0, build: () => setup({}, async (w) => { w.action('get').click(); await w.settle(); }) },
    { id: 'get-retried', title: 'Get a wallet after a failed Check again: Reload page is the one Solid', primary: 0, solidExtra: '.wallet-onboarding-reload', build: () => setup({}, async (w) => { w.action('get').click(); await w.settle(); w.q('.wallet-get-check').click(); await w.settle(); }) },
    { id: 'switching', title: 'Switching: the current account carries the sidebar bar and tint', primary: 0, build: () => setup({ wallets: [TALISMAN(), POLKADOT()], current: addr(10, 42), currentSource: 'talisman', lastSource: 'talisman' }) }
];

const Q = (w, sel) => w.qa(sel).filter(w.visible).length;
async function renderScene(s) {
    const w = await s.build();
    const err = [];
    const app = w.doc.querySelector('.app-container');
    if (!app) err.push('no .app-container');
    if (!w.doc.querySelector('aside.sidebar .nav-item.active')) err.push('no aside.sidebar .nav-item.active');
    if (!w.doc.querySelector('header.topbar .connect-wallet-btn')) err.push('no header.topbar .connect-wallet-btn');
    if (!w.doc.querySelector('section.list-container.glass.wallet-picker')) err.push('no section.list-container.glass.wallet-picker');
    if (!w.doc.querySelector('.wallet-ext-tile')) err.push('no .wallet-ext-tile');
    const n = Q(w, '.wallet-picker .is-primary');
    if (n !== s.primary) err.push(`${n} .is-primary rows visible, the spec wants ${s.primary}`);
    if (s.solidExtra && Q(w, s.solidExtra) !== 1) err.push(`${Q(w, s.solidExtra)} of ${s.solidExtra} visible, the spec wants exactly 1`);
    if (err.length) throw new Error(`scene "${s.id}": ${err.join('; ')}`);
    return app.outerHTML;
}

function noteScene() {
    const view = addr(5, 88);   // a synthetic address that belongs to no one
    const r = execFileSync('node', ['--experimental-sqlite', new URL('test/helpers/full-page.js', root).pathname, JSON.stringify({ path: 'wallet/' + view, dumpHtml: true, steps: [{ event: 'visibilitychange', wait: 500 }] })], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
    const line = r.split('\n').find(l => l.startsWith('RESULT '));
    const res = JSON.parse(line.slice(7));
    const html = res.appHtml;
    const err = [];
    if (!/class="wallet-viewing-note is-readonly"/.test(html)) err.push('no .wallet-viewing-note.is-readonly in the real page');
    if (!/<aside class="sidebar"/.test(html)) err.push('no aside.sidebar');
    if (err.length) throw new Error('scene "note": ' + err.join('; '));
    return html.replace(/<img src="logo\.png"/g, `<img src="${logoUri}"`);
}

// ── guards on the whole file ──
function checkFile(html) {
    const err = [];
    const css = /<style id="app-css">([\s\S]*?)<\/style>/.exec(html);
    if (!css) err.push('no <style id="app-css">');
    else {
        if (!css[1].includes(STYLES)) err.push('styles.css is not inlined byte for byte');
        if (!/@font-face\s*\{[^}]*font-family:\s*'Inter'[^}]*src:\s*url\(data:/.test(css[1])) err.push('no Inter @font-face with a data: source');
        if (!/@font-face\{[^}]*font-family:boxicons[^}]*src:url\(data:/.test(css[1])) err.push('no Boxicons @font-face with a data: source');
    }
    if (!html.includes('class="app-container"')) err.push('no .app-container');
    const urls = [...html.matchAll(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g)].map(m => m[2]).filter(u => !/^data:/.test(u) && !/^#/.test(u));
    const refs = [...html.matchAll(/<(?:link|script|img)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g)].map(m => m[1]).filter(u => !/^data:/.test(u));
    for (const u of [...urls, ...refs]) err.push('a stylesheet, script, font or image reference is not a data: URI: ' + u.slice(0, 80));
    if (err.length) throw new Error(err.join('\n'));
}

// ── assemble ──
const FRAME_JS = `
const css = document.getElementById('app-css').textContent;
for (const f of document.querySelectorAll('iframe[data-scene]')) {
  const t = document.getElementById('t-' + f.dataset.scene);
  f.srcdoc = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + css + '</style></head><body>' + t.innerHTML + '</body></html>';
  f.addEventListener('load', () => { try { f.style.height = Math.max(240, f.contentDocument.documentElement.scrollHeight) + 'px'; } catch (e) {} });
}`;
const CHROME_CSS = `body{margin:0;padding:24px;background:#08080C;color:#F2F2F6;font-family:Inter,system-ui,sans-serif}
h1{font-size:1.2rem;margin:0 0 4px}p.lead{margin:0 0 24px;color:#9A9AAE;font-size:.85rem;max-width:900px}
section.scene{margin:0 0 40px}section.scene h2{font-size:1rem;margin:0 0 12px}
.frames{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap}
figure{margin:0}figcaption{font-size:.75rem;color:#9A9AAE;margin:0 0 6px}
iframe{border:1px solid #2A2A38;background:#08080C;display:block;max-width:none}
iframe[data-w="1280"]{width:1280px}iframe[data-w="390"]{width:390px}`;

async function build(scenes, files = {}) {
    const parts = [];
    const sceneList = [];
    for (const s of scenes) sceneList.push({ id: s.id, title: s.title, html: await renderScene(s) });
    sceneList.push({ id: 'note', title: 'Not-connected note on /wallet/<address> (the real page, nothing connected)', html: noteScene() });
    const body = sceneList.map(s => `<section class="scene"><h2>${s.title}</h2><div class="frames">
<figure><figcaption>1280 px</figcaption><iframe data-scene="${s.id}" data-w="1280" title="${s.id} at 1280 px"></iframe></figure>
<figure><figcaption>390 px</figcaption><iframe data-scene="${s.id}" data-w="390" title="${s.id} at 390 px"></iframe></figure></div>
<template id="t-${s.id}">${s.html}</template></section>`).join('\n');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connect wallet: brand identity pass</title>
<style id="app-css">${APP_CSS}</style>
<style id="chrome-css">${CHROME_CSS}</style></head><body>
<h1>Connect wallet chooser: brand identity pass (feat/connect-chooser)</h1>
<p class="lead">The branch's real index.html shell, styles.css and chooser, in frames at 1280 px and 390 px. Labels and titles are outside the frames.</p>
${body}
<script>${FRAME_JS}</script></body></html>`;
    checkFile(html);
    return html;
}

// ── self-tests: each guard, broken once, must refuse with a readable message ──
async function guardSelfTest() {
    const expectFail = async (name, fn, re) => {
        try { await fn(); } catch (e) { if (re.test(e.message)) { console.log(`guard ok (${name}): ${e.message.split('\n')[0]}`); return; } throw new Error(`guard "${name}" failed with the wrong message: ${e.message}`); }
        throw new Error(`guard "${name}" did not refuse`);
    };
    const one = SCENES[1];
    await expectFail('wrong Solid count', () => renderScene({ ...one, primary: 2 }), /\.is-primary rows visible/);
    await expectFail('missing element', () => renderScene({ ...one, build: async () => { const w = await one.build(); w.doc.querySelector('header.topbar .connect-wallet-btn').remove(); return w; } }), /no header\.topbar \.connect-wallet-btn/);
    const ok = await build([one]);
    await expectFail('remote font url', async () => checkFile(ok.replace('</style>', '@font-face{src:url(https://x.test/a.woff2)}</style>')), /not a data: URI/);
    await expectFail('remote image', async () => checkFile(ok.replace('<template', '<img src="logo.png"><template')), /not a data: URI/);
    await expectFail('font without data source', async () => checkFile(ok.replace(/font-family:\s*'Inter'/g, "font-family: 'Other'")), /Inter @font-face/);
    await expectFail('styles.css changed', async () => checkFile(ok.replace('.wallet-ext-tile {', '.wallet-ext-tile  {')), /byte for byte/);
}

if (selftest) { await guardSelfTest(); process.exit(0); }
if (!out) { console.error('usage: node --experimental-sqlite test/helpers/preview-chooser.mjs <out.html> [--selftest]'); process.exit(2); }
try {
    const html = await build(SCENES);
    writeFileSync(out, html);
    console.log(`wrote ${out}: ${html.length} bytes, ${SCENES.length + 1} scenes`);
    process.exit(0);
} catch (e) {
    console.error('REFUSED, file not written:\n' + e.message);
    process.exit(1);
}
