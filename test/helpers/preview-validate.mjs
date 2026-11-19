// Preview generator for the Validate page, Sprint 1 (never shipped, never run
// by npm test). Spec: cto-team/plans/2026-11-17-validator-onboarding-design.md.
//
//   npm run vendor && node --experimental-sqlite test/helpers/preview-validate.mjs <out.html> [--selftest]
//
// It loads the branch's REAL index.html shell (sidebar with the Validate entry
// shown and active, the topbar, the validate page section), mounts the REAL
// view (lib/validator-status-view.js) into it in happy-dom for each scene, and
// serialises the result. The status models come from the real
// lib/validator-status.js and the key check rows from the real
// lib/session-keys.js, on synthetic data (accounts are 32 bytes of one
// repeated value; keys are repeated bytes; they belong to no one).
// styles.css goes in byte for byte; Inter 400/600 and the Boxicons the page
// names come from public/vendor as data: URLs; the logo once. Each scene is a
// 1280 px and a 390 px frame built from the one stylesheet.
//
// Guards: the file is not written when a scene lacks its required element,
// has more than one primary button (or any, when a wallet is connected and
// nothing is urgent), shows green outside the Active pill and Heartbeat word,
// or when any stylesheet, script, font or image reference is not data:.
// --selftest breaks each guard once and prints the refusal.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { encodeAddress } from '@polkadot/util-crypto';
import { mountValidatePage } from '../../lib/validator-status-view.js';
import { validatorStatusModel } from '../../lib/validator-status.js';
import { parseSessionKeys, classifyKeyOwners, keyCheckSummary } from '../../lib/session-keys.js';
import { escapeHtml } from '../../lib/html-escape.js';

const root = new URL('../../', import.meta.url);
const rd = (p, enc = 'utf8') => readFileSync(new URL(p, root), enc);
const b64 = (p) => rd(p, null).toString('base64');
const out = process.argv[2];
const selftest = process.argv.includes('--selftest');

// ── assets ──
const dataFont = (p) => `url(data:font/woff2;base64,${b64(p)}) format('woff2')`;
function interCss() {
    const css = rd('public/vendor/inter.css');
    const blocks = css.match(/\/\* inter-[^*]*\*\/\s*@font-face\s*\{[^}]*\}/g) || [];
    return blocks.filter(b => /inter-latin-(400|600|700)-normal/.test(b)).map(b => {
        const file = /inter-latin-\d+-normal/.exec(b)[0];
        return b.replace(/src:[^;]*;/, `src: ${dataFont(`public/vendor/inter/${file}.woff2`)};`);
    }).join('\n');
}
// Boxicons, cut to the glyphs the shell and the page name (fontTools' subsetter,
// `python3 -m fontTools.subset`, as WOFF): the whole font is 115 KB of the
// 500 KB budget. Without fontTools the whole woff2 goes in and the budget guard
// says so.
function boxiconsCss() {
    const css = rd('public/vendor/boxicons/css/boxicons.min.css');
    const src = rd('index.html') + rd('lib/validator-status-view.js') + rd('lib/wallet-aware.js') + rd('test/helpers/preview-validate.mjs');
    const used = new Set([...src.matchAll(/\bbx[sl]?-[a-z0-9-]+/g)].map(m => m[0]));
    const rules = css.split('}').filter(r => { const m = /\.(bx[sl]?-[a-z0-9-]+):before/.exec(r); return !m || used.has(m[1]); });
    const codes = [...new Set(rules.map(r => /:before\{content:"\\([0-9a-f]+)"/i.exec(r)).filter(Boolean).map(m => m[1].toUpperCase()))];
    let font = `url(data:font/woff2;base64,${b64('public/vendor/boxicons/fonts/boxicons.woff2')}) format('woff2')`;
    try {
        const dir = mkdtempSync(join(tmpdir(), 'bx-'));
        const outFile = join(dir, 'bx.woff');
        execFileSync('python3', ['-m', 'fontTools.subset', fileURLToPath(new URL('public/vendor/boxicons/fonts/boxicons.ttf', root)), '--unicodes=' + codes.map(c => 'U+' + c).join(','), '--flavor=woff', '--output-file=' + outFile], { stdio: 'ignore' });
        font = `url(data:font/woff;base64,${readFileSync(outFile).toString('base64')}) format('woff')`;
    } catch (e) { /* fontTools missing: the whole font, and the budget guard decides */ }
    return rules.join('}').replace(/src:url\(\.\.\/fonts\/boxicons\.eot\);src:[^}]*\}/, `src:${font}}`);
}
const STYLES = rd('styles.css');
const APP_CSS = interCss() + '\n' + STYLES + '\n' + boxiconsCss();

// ── synthetic chain data ──
const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const STASH = addr(91), OTHER = addr(92), PROXY = addr(93);
const short = (a) => a.slice(0, 8) + '...' + a.slice(-6);
const PDEX = 10n ** 12n;
const rep = (b, n) => b.repeat(n);
const KEYS = { grandpa: '0x' + rep('1a', 32), babe: '0x' + rep('2b', 32), im_online: '0x' + rep('3c', 32), authority_discovery: '0x' + rep('4d', 32), mixnet: '0x' + rep('5e', 32), beefy: '0x02' + rep('6f', 32) };
const BLOB = '0x' + Object.values(KEYS).map(h => h.slice(2)).join('');
const PARAMS = { specVersion: 393, layout: { ok: true, bytes: 193, hexLength: 388 }, minValidatorBond: String(100n * PDEX), minCommission: 0, maxValidatorsCount: null,
    lowestElectedTotal: String(41_250n * PDEX), medianCommission: 100_000_000 };
const base = {
    address: STASH, bonded: true, controller: STASH, ledger: { total: String(12_000n * PDEX), active: String(12_000n * PDEX) },
    intent: true, prefs: { commission: 50_000_000, blocked: false }, nextKeys: KEYS, queuedKeys: KEYS, inQueued: true, inSession: true,
    activeImOnlineKey: KEYS.im_online, disabled: false, imOnline: true, heartbeat: true, blocks: 3,
    activeEra: 1412, currentEra: 1412, sessionIndex: 8471, sessionProgress: 0.42, epochDuration: 1200, blockTimeMs: 12000, sessionsPerEra: 6, eraStartSession: 8469,
    exposure: { total: String(96_400n * PDEX), own: String(12_000n * PDEX), nominatorCount: 287, pageCount: 2 }, nextExposure: null,
    points: { points: 1340, rank: 37, of: 200 }, lastEra: { points: 7120, reward: String(412n * PDEX) },
    lastSlashEra: null, incidents: [], identity: { name: 'Example Validator', judgements: [] }, proxies: [{ delegate: PROXY, type: 'Staking' }], bondingDuration: 28
};
const ACTIVE = validatorStatusModel(base, PARAMS);
const WAITING = validatorStatusModel({ ...base, inSession: false, inQueued: false, queuedKeys: null, activeImOnlineKey: null, heartbeat: null, blocks: null, exposure: null, points: null, lastEra: null, proxies: [] }, PARAMS);
const ELECTED = validatorStatusModel({ ...base, inSession: false, activeImOnlineKey: null, heartbeat: null, blocks: null, exposure: null, points: null, lastEra: null, proxies: [] }, PARAMS);

function checkFor(blob, owners) {
    const p = parseSessionKeys(blob, { specVersion: 393 });
    const r = classifyKeyOwners(p.keys, { owners, queued: [], stash: STASH, nextKeys: null });
    return { ok: true, for: STASH, specVersion: 393, bytes: p.bytes, warnings: p.warnings, conflict: r.conflict, sameAsNext: r.sameAsNext, rows: r.rows, summary: keyCheckSummary(r, p.keys) };
}
const VALID = checkFor(BLOB, [null, null, null, null, null, null]);
const CONFLICT = checkFor(BLOB, [OTHER, null, null, null, null, null]);

// ── the real shell ──
const html = rd('index.html');
const BODY = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>') + 7).replace(/<script[\s\S]*?<\/script>/g, '');
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

async function scene({ model, check = null }) {
    const w = new Window({ url: 'http://localhost/validate', width: 1280, height: 900 });
    const doc = w.document;
    doc.body.outerHTML = BODY;
    const app = doc.querySelector('.app-container');
    for (const sec of Array.from(app.querySelectorAll('.page-section'))) if (sec.getAttribute('data-page') !== 'validate') sec.remove();
    for (const m of Array.from(app.querySelectorAll('[id$="-modal"]'))) m.remove();
    app.querySelector('.page-section[data-page="validate"]').setAttribute('style', 'display: flex;');
    for (const n of app.querySelectorAll('.nav-item.active')) n.classList.remove('active');
    const nav = app.querySelector('#nav-validate');
    nav.hidden = false; nav.classList.add('active');
    for (const img of app.querySelectorAll('img[src="logo.png"]')) img.setAttribute('src', 'data:image/png;base64,LOGO_ONCE');
    const btn = app.querySelector('#connect-wallet-btn');
    btn.classList.add('is-connected');
    app.querySelector('#connect-wallet-label').textContent = short(STASH);
    const fetchJson = async (u) => {
        if (u === '/api/validator/params') return PARAMS;
        if (/\/status$/.test(u)) return model;
        if (u.startsWith('/api/session-keys/check')) return check;
        throw new Error('unexpected ' + u);
    };
    const el = doc.getElementById('validate-root');
    await mountValidatePage(el, { urlAddress: '', account: { status: 'connected', address: STASH }, isSame: (a, b) => a === b, fetchJson,
        helpIcon: (slug, tip) => `<a href="/help/${slug}" class="help-icon" title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}"><i class='bx bx-help-circle'></i></a>`,
        esc: escapeHtml, shortAddr: short, navigate: () => {} });
    if (check) {
        el.querySelector('#validate-keys-input').value = BLOB;
        el.querySelector('#validate-keys-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
        await tick(30);
    }
    return { app, el };
}

const SCENES = [
    { id: 'active', title: 'Active validator: wallet connected, nothing urgent (no primary button)', build: () => scene({ model: ACTIVE }), need: ['.validate-pill.is-positive', '.validate-rows'], primary: 0 },
    { id: 'waiting', title: 'Waiting validator: keys registered, not elected this era', build: () => scene({ model: WAITING }), need: ['.validate-pill.is-neutral', '.validate-rows'], primary: 0 },
    { id: 'elected', title: 'Elected for the next session: keys queued for session 8472', build: () => scene({ model: ELECTED }), need: ['.validate-pill.is-neutral', '.validate-rows'], primary: 0 },
    { id: 'keys-valid', title: 'Session keys checker: a valid line, none registered to another account', build: () => scene({ model: ACTIVE, check: VALID }), need: ['.validate-keys-table', '#validate-keys-msg'], primary: 0 },
    { id: 'keys-conflict', title: 'Session keys checker: the grandpa key is registered to another account (role="alert")', build: () => scene({ model: ACTIVE, check: CONFLICT }), need: ['.validate-keys-table', '.validate-alert[role="alert"]'], primary: 0 }
];

const GREEN = /var\(--success\)|var\(--brand-secondary\)/;
async function renderScene(s) {
    const { app, el } = await s.build();
    const err = [];
    if (!app.querySelector('aside.sidebar .nav-item.active#nav-validate')) err.push('the Validate nav entry is not shown and active');
    for (const sel of s.need) if (!el.querySelector(sel)) err.push('no ' + sel);
    const n = el.querySelectorAll('.validate-primary').length;
    if (n > 1 || n !== s.primary) err.push(`${n} primary buttons, the spec wants ${s.primary}`);
    const greens = Array.from(el.querySelectorAll('.is-positive')).filter(x => !(x.classList.contains('validate-pill') && x.textContent === 'Active') && !(x.classList.contains('validate-word') && x.textContent === 'Heartbeat received'));
    if (greens.length) err.push('green outside the Active pill and the Heartbeat word: ' + greens.map(g => g.textContent).join(', '));
    if (/style="[^"]*--success/.test(el.innerHTML) || GREEN.test(el.getAttribute('style') || '')) err.push('an inline green style');
    if (err.length) throw new Error(`scene "${s.id}": ${err.join('; ')}`);
    return app.outerHTML;
}

function checkFile(h) {
    const err = [];
    const css = /<style id="app-css">([\s\S]*?)<\/style>/.exec(h);
    if (!css) err.push('no <style id="app-css">');
    else {
        if (!css[1].includes(STYLES)) err.push('styles.css is not inlined byte for byte');
        if (!/@font-face\s*\{[^}]*font-family:\s*'Inter'[^}]*src:\s*url\(data:/.test(css[1])) err.push('no Inter @font-face with a data: source');
        if (!/@font-face\{[^}]*font-family:boxicons[^}]*src:url\(data:/.test(css[1])) err.push('no Boxicons @font-face with a data: source');
    }
    const urls = [...h.matchAll(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g)].map(m => m[2]).filter(u => !/^data:/.test(u) && !/^#/.test(u));
    const refs = [...h.matchAll(/<(?:link|script|img)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g)].map(m => m[1]).filter(u => !/^data:/.test(u));
    for (const u of [...urls, ...refs]) err.push('a stylesheet, script, font or image reference is not a data: URI: ' + u.slice(0, 80));
    if (h.length > 500 * 1024) err.push(`the file is ${h.length} bytes, over the 500 KB budget`);
    if (err.length) throw new Error(err.join('\n'));
}

const FRAME_JS = `
const css = document.getElementById('app-css').textContent;
const logo = document.getElementById('logo-once').textContent;
for (const f of document.querySelectorAll('iframe[data-scene]')) {
  const t = document.getElementById('t-' + f.dataset.scene);
  f.srcdoc = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + css + '</style></head><body>' + t.innerHTML.split('LOGO_ONCE').join(logo) + '</body></html>';
  f.addEventListener('load', () => { try { const d = f.contentDocument; f.style.height = Math.max(240, d.documentElement.scrollHeight) + 'px'; } catch (e) {} });
}`;
const CHROME_CSS = `body{margin:0;padding:24px;background:#08080C;color:#F2F2F6;font-family:Inter,system-ui,sans-serif}
h1{font-size:1.2rem;margin:0 0 4px}p.lead{margin:0 0 24px;color:#9A9AAE;font-size:.85rem;max-width:900px}
section.scene{margin:0 0 40px}section.scene h2{font-size:1rem;margin:0 0 12px}
.frames{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap}
figure{margin:0}figcaption{font-size:.75rem;color:#9A9AAE;margin:0 0 6px}
iframe{border:1px solid #2A2A38;background:#08080C;display:block;max-width:none}
iframe[data-w="1280"]{width:1280px}iframe[data-w="390"]{width:390px}`;

async function build(scenes) {
    const list = [];
    for (const s of scenes) list.push({ ...s, html: await renderScene(s) });
    const body = list.map(s => `<section class="scene"><h2>${escapeHtml(s.title)}</h2><div class="frames">
<figure><figcaption>1280 px</figcaption><iframe data-scene="${s.id}" data-w="1280" title="${s.id} at 1280 px"></iframe></figure>
<figure><figcaption>390 px</figcaption><iframe data-scene="${s.id}" data-w="390" title="${s.id} at 390 px"></iframe></figure></div>
<template id="t-${s.id}">${s.html}</template></section>`).join('\n');
    const h = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Validate, Sprint 1: validator status and session keys checker</title>
<style id="app-css">${APP_CSS}</style>
<style id="chrome-css">${CHROME_CSS}</style></head><body>
<h1>Validate, Sprint 1: validator status and session keys checker (feat/validator-s1-status)</h1>
<p class="lead">The branch's real index.html shell, styles.css and view, in frames at 1280 px and 390 px, on synthetic chain data. Read-only: no validator actions in this sprint. Labels and titles are outside the frames.</p>
${body}
<script id="logo-once" type="text/plain">${b64('logo.png')}</script><script>${FRAME_JS}</script></body></html>`;
    checkFile(h);
    return h;
}

async function guardSelfTest() {
    const expectFail = async (name, fn, re) => {
        try { await fn(); } catch (e) { if (re.test(e.message)) { console.log(`guard ok (${name}): ${e.message.split('\n')[0]}`); return; } throw new Error(`guard "${name}" failed with the wrong message: ${e.message}`); }
        throw new Error(`guard "${name}" did not refuse`);
    };
    const one = SCENES[0];
    await expectFail('wrong primary count', () => renderScene({ ...one, primary: 1 }), /primary buttons/);
    await expectFail('missing element', () => renderScene({ ...one, need: ['.does-not-exist'] }), /no \.does-not-exist/);
    await expectFail('green on a neutral row', () => renderScene({ ...one, build: async () => { const r = await one.build(); r.el.querySelector('.validate-word').classList.add('is-positive'); r.el.querySelector('.validate-word').textContent = 'Match'; return r; } }), /green outside/);
    const ok = await build([one]);
    await expectFail('remote font url', async () => checkFile(ok.replace('</style>', '@font-face{src:url(https://x.test/a.woff2)}</style>')), /not a data: URI/);
    await expectFail('styles.css changed', async () => checkFile(ok.replace('.validate-pill {', '.validate-pill  {')), /byte for byte/);
    await expectFail('over budget', async () => checkFile(ok + 'x'.repeat(600 * 1024)), /500 KB budget/);
}

if (selftest) { await guardSelfTest(); process.exit(0); }
if (!out) { console.error('usage: node --experimental-sqlite test/helpers/preview-validate.mjs <out.html> [--selftest]'); process.exit(2); }
try {
    const h = await build(SCENES);
    writeFileSync(out, h);
    console.log(`wrote ${out}: ${h.length} bytes, ${SCENES.length} scenes`);
    process.exit(0);
} catch (e) {
    console.error('REFUSED, file not written:\n' + e.message);
    process.exit(1);
}
