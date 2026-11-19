// Preview generator for the node guide and Check my node, Sprint 2 (never
// shipped, never run by npm test). Spec: cto-team/plans/2026-11-17-validator-
// onboarding-design.md, section 3, and the CEO decisions D1 and D3.
//
//   npm run vendor && node --experimental-sqlite test/helpers/preview-validate-node.mjs <out.html> [--selftest]
//
// It loads the branch's REAL index.html shell (the Validate entry shown and
// active), mounts the REAL guide (lib/validator-node-guide.js, with the real
// release constant, which is pending) and the REAL check card into it in
// happy-dom, and serialises the result. The telemetry answers are synthetic,
// in the shape GET /api/telemetry/node returns (made-up node names).
// styles.css goes in byte for byte; Inter and the Boxicons the page names come
// from public/vendor as data: URLs; the logo once. Each scene is a 1280 px and
// a 390 px frame built from the one stylesheet.
//
// Guards: the file is not written when a scene lacks its required element, has
// a primary button (the pending guide has none), shows green anywhere but the
// "In sync" word, or when any stylesheet, script, font or image reference is
// not data:. --selftest breaks each guard once and prints the refusal.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { mountNodeGuide } from '../../lib/validator-node-guide.js';
import { NODE_RELEASE, releaseState } from '../../lib/validator-node-release.js';
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
    const src = rd('index.html') + rd('lib/validator-node-guide.js') + rd('lib/node-check-view.js') + rd('test/helpers/preview-validate-node.mjs');
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

// ── synthetic telemetry answers (the route's shape) ──
const PENDING_REL = { state: 'pending', version: null };
const FOUND = { feed: 'ok', name: 'example-validator-01', head: 18_402_991, release: PENDING_REL, count: 1, similar: [],
    nodes: [{ name: 'example-validator-01', version: '7.0.0-566b080ba1a', best: 18_402_990, finalized: 18_402_988, peers: 24, validator: false, networkId: '12D3KooWExamplePeerIdForThePreview1', stale: false, secondsAgo: 4, behind: 1, versionVsRelease: null }] };
const NOT_FOUND = { feed: 'ok', name: 'example-validator', head: null, release: PENDING_REL, count: 0, nodes: [], similar: ['example-validator-01', 'example-validator-02'] };
if (releaseState(NODE_RELEASE).published) throw new Error('this preview shows the pending release; the constant is now published');

// ── the real shell ──
const html = rd('index.html');
const BODY = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>') + 7).replace(/<script[\s\S]*?<\/script>/g, '');
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

async function scene({ nodeName = '', answer = null, only = null }) {
    const w = new Window({ url: 'http://localhost/validate/node', width: 1280, height: 900 });
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
    const el = doc.getElementById('validate-root');
    const wired = mountNodeGuide(el, { esc: escapeHtml, nodeName, fetchJson: async (u) => { if (u.startsWith('/api/telemetry/node')) return answer; throw new Error('unexpected ' + u); },
        helpIcon: (slug, tip) => `<a href="/help/${slug}" class="help-icon" title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}"><i class='bx bx-help-circle'></i></a>`, setNodeParam: () => {} });
    await wired.ran;
    await tick(20);
    if (only) for (const s of Array.from(el.querySelectorAll('section.validate-guide-step'))) if (s.getAttribute('aria-labelledby') !== only) s.remove();
    return { app, el };
}

const SCENES = [
    { id: 'guide-pending', title: 'The node guide, official release pending (D1): no primary button, build from source only in the closed Advanced block', build: () => scene({}), need: ['.validate-pending', 'details.validate-advanced:not([open])', '.validate-checklist', '#node-check-form'], primary: 0, green: [] },
    { id: 'check-found', title: 'Check my node: found and in sync (green only within 5 blocks of head and 3 or more peers). Section 4 only', build: () => scene({ nodeName: FOUND.name, answer: FOUND, only: 'node-step-check' }), need: ['.validate-node-verdict', '.validate-node-notes'], primary: 0, green: ['In sync'] },
    { id: 'check-not-found', title: 'Check my node: not found, with similar names. Section 4 only', build: () => scene({ nodeName: NOT_FOUND.name, answer: NOT_FOUND, only: 'node-step-check' }), need: ['.validate-node-verdict', '[data-node-name]'], primary: 0, green: [] }
];

const GREEN = /var\(--success\)|var\(--brand-secondary\)/;
async function renderScene(s) {
    const { app, el } = await s.build();
    const err = [];
    if (!app.querySelector('aside.sidebar .nav-item.active#nav-validate')) err.push('the Validate nav entry is not shown and active');
    for (const sel of s.need) if (!el.querySelector(sel)) err.push('no ' + sel);
    const n = el.querySelectorAll('.validate-primary').length;
    if (n > 1 || n !== s.primary) err.push(`${n} primary buttons, the spec wants ${s.primary}`);
    const greens = Array.from(el.querySelectorAll('.is-positive')).map(x => x.textContent);
    if (JSON.stringify(greens) !== JSON.stringify(s.green)) err.push('green on [' + greens.join(', ') + '], the spec wants [' + s.green.join(', ') + ']');
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
    const h = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Validate, Sprint 2: node guide and Check my node</title>
<style id="app-css">${APP_CSS}</style>
<style id="chrome-css">${CHROME_CSS}</style></head><body>
<h1>Validate, Sprint 2: node guide and Check my node (feat/validator-s2-node)</h1>
<p class="lead">The branch's real index.html shell, styles.css and view, in frames at 1280 px and 390 px, with synthetic telemetry answers. The release constant is pending. Labels and titles are outside the frames.</p>
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
    await expectFail('green on a neutral word', () => renderScene({ ...one, build: async () => { const r = await one.build(); r.el.querySelector('.validate-word').classList.add('is-positive'); return r; } }), /green on/);
    const ok = await build([one]);
    await expectFail('remote font url', async () => checkFile(ok.replace('</style>', '@font-face{src:url(https://x.test/a.woff2)}</style>')), /not a data: URI/);
    await expectFail('styles.css changed', async () => checkFile(ok.replace('.validate-cmd {', '.validate-cmd  {')), /byte for byte/);
    await expectFail('over budget', async () => checkFile(ok + 'x'.repeat(600 * 1024)), /500 KB budget/);
}

if (selftest) { await guardSelfTest(); process.exit(0); }
if (!out) { console.error('usage: node --experimental-sqlite test/helpers/preview-validate-node.mjs <out.html> [--selftest]'); process.exit(2); }
try {
    const h = await build(SCENES);
    writeFileSync(out, h);
    console.log(`wrote ${out}: ${h.length} bytes, ${SCENES.length} scenes`);
    process.exit(0);
} catch (e) {
    console.error('REFUSED, file not written:\n' + e.message);
    process.exit(1);
}
