// Preview generator for the setup wizard, Sprint 3 (never shipped, never run
// by npm test). Spec: cto-team/plans/2026-11-17-validator-onboarding-design.md,
// section 5.3, and CEO decision D4 (one batched signature).
//
//   npm run vendor && node --experimental-sqlite test/helpers/preview-validate-setup.mjs <out.html> [--selftest]
//
// It loads the branch's REAL index.html shell (the Validate entry shown and
// active), mounts the REAL wizard (lib/validator-setup-view.js) in happy-dom
// against a fake api whose calls are the REAL spec 393 codecs (test/fixtures),
// drives it with clicks to each scene, and serialises the result. Accounts,
// keys and balances are synthetic (32 bytes of one repeated value).
// styles.css goes in byte for byte; Inter and the Boxicons the page names come
// from public/vendor as data: URLs; the logo once. Each scene is a 1280 px and
// a 390 px frame built from the one stylesheet.
//
// Guards: the file is not written when a scene lacks its required element, has
// a primary count other than the spec's (one, or zero when nothing moves
// forward), shows green anywhere, or when any stylesheet, script, font or image
// reference is not data:. --selftest breaks each guard once and prints the refusal.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { encodeAddress } from '@polkadot/util-crypto';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { mountValidatorSetup } from '../../lib/validator-setup-view.js';
import { EXPECTED_LAYOUT } from '../../lib/session-keys.js';
import { renderCallHtml } from '../../lib/call-args-format.js';
import { callToTree } from '../../lib/call-tree.js';
import { registryFromMetadata, loadFixture } from './extrinsic-builders.js';
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
    const src = rd('index.html') + rd('lib/validator-setup-view.js') + rd('test/helpers/preview-validate-setup.mjs');
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

// ── a fake chain: real spec 393 codecs for the calls, synthetic state ──
const registry = registryFromMetadata(loadFixture('metadata-testnet-393.json').metadata);
const ex = decorateExtrinsics(registry, registry.metadata, 15);
const STASH = encodeAddress(new Uint8Array(32).fill(201), 88);
const PDEX = 10n ** 12n;
const rep = (b, n) => b.repeat(n);
const KEYS = { grandpa: '0x' + rep('11', 32), babe: '0x' + rep('22', 32), im_online: '0x' + rep('33', 32), authority_discovery: '0x' + rep('44', 32), mixnet: '0x' + rep('55', 32), beefy: '0x02' + rep('66', 32) };
const BLOB = '0x' + EXPECTED_LAYOUT.map(l => KEYS[l.name].slice(2)).join('');
const opt = (v) => (v == null ? { isSome: false, isNone: true } : { isSome: true, isNone: false, unwrap: () => v });
const num = (v) => ({ toNumber: () => Number(v), toString: () => String(v), toBigInt: () => BigInt(v) });
const keysCodec = (k) => ({ toJSON: () => ({ grandpa: k.grandpa, babe: k.babe, imOnline: k.im_online, authorityDiscovery: k.authority_discovery, mixnet: k.mixnet, beefy: k.beefy }) });
function fakeApi(o = {}) {
    const st = { bonded: null, ledger: null, nextKeys: null, validating: false, free: 1250n * PDEX, ...o };
    const validators = async () => ({});
    validators.size = async () => num(st.validating ? 5 : 0);
    const tx = new Proxy(ex, { get: (t, sec) => new Proxy(t[sec], { get: (p, m) => (...args) => { const c = p[m](...args); if (sec === 'utility') c.paymentInfo = async () => ({ partialFee: num(21_400_000_000n) }); return c; } }) });
    return { registry, tx, runtimeVersion: { specVersion: num(393) }, consts: { balances: { existentialDeposit: num(PDEX) } },
        query: {
            system: { account: async () => ({ data: { free: num(st.free), reserved: num(0), frozen: num(0) } }) },
            staking: { minValidatorBond: async () => num(100n * PDEX), minCommission: async () => num(0), maxValidatorsCount: async () => opt(null), counterForValidators: async () => num(217),
                bonded: async () => opt(st.bonded), ledger: async (c) => opt(st.ledger && String(c) === STASH ? st.ledger : null), validators, nominators: async () => opt(null) },
            session: { nextKeys: async () => opt(st.nextKeys ? keysCodec(st.nextKeys) : null), queuedKeys: async () => [], keyOwner: async () => opt(null) }
        } };
}
const PARAMS = { specVersion: 393, lowestElectedTotal: String(48_250n * PDEX), medianCommission: 30_000_000, sessionProgress: 0.4, epochDuration: 1200, blockTimeMs: 12000, activeEra: 1210, currentEra: 1210, electionPhase: 'Off' };
const BONDED = { bonded: STASH, ledger: { stash: STASH, total: num(500n * PDEX), active: num(500n * PDEX) }, nextKeys: KEYS };

// ── the real shell ──
const html = rd('index.html');
const BODY = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>') + 7).replace(/<script[\s\S]*?<\/script>/g, '');
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(5); };

async function scene({ api = fakeApi(), drive = async () => {} }) {
    const w = new Window({ url: 'http://localhost/validate/setup', width: 1280, height: 900 });
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
    await mountValidatorSetup(el, { account: { status: 'connected', address: STASH }, getApi: () => api, isMultisig: () => false, revision: () => 'r1', submit: () => {},
        fetchJson: async (u) => { if (u === '/api/validator/params') return PARAMS; throw new Error('unexpected ' + u); },
        esc: escapeHtml, shortAddr: (a) => a.slice(0, 8) + '...' + a.slice(-6), isAddress: () => true,
        helpIcon: (slug, tip) => `<a href="/help/${slug}" class="help-icon" title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}"><i class='bx bx-help-circle'></i></a>`,
        renderCall: (c) => renderCallHtml(callToTree(c), {}, { raw: false }), apiWaitMs: 50 });
    await settle();
    const click = async (sel) => { el.querySelector(sel).click(); await settle(); };
    const type = async (sel, v) => { const i = el.querySelector(sel); i.value = v; i.dispatchEvent(new w.Event('input', { bubbles: true })); await settle(); };
    await drive({ el, click, type, w });
    return { app, el };
}
const toKeys = async ({ click }) => { await click('[data-setup-action="next"]'); };
const toBond = async (h) => { await toKeys(h); await h.type('#validate-setup-keys', BLOB); await h.click('[data-setup-action="use-keys"]'); };
const toCommission = async (h) => { await toBond(h); await h.type('#validate-setup-bond', '500'); await h.click('[data-setup-action="next"]'); };
const toReview = async (h) => { await toCommission(h); await h.type('#validate-setup-commission', '5'); await h.click('[data-setup-action="next"]'); const b = h.el.querySelector('#validate-setup-ack'); b.checked = true; b.dispatchEvent(new h.w.Event('change', { bubbles: true })); await settle(); };

const SCENES = [
    { id: 'step1-node', title: 'Step 1, a fresh account: the statement, Check my node (secondary), one primary "My node is ready"', build: () => scene({}), need: ['ol.validate-steps [aria-current="step"]', '#validate-setup-node'], primary: 1 },
    { id: 'step2-keys', title: 'Step 2: the keys pasted and parsed (6 keys, 193 bytes); "Use these keys" enabled', build: () => scene({ drive: async (h) => { await toKeys(h); await h.type('#validate-setup-keys', BLOB); } }), need: ['#validate-setup-keys[data-input-kind="hex"]', '.validate-setup-cmd'], primary: 1 },
    { id: 'step3-bond', title: 'Step 3: bond against the live minimum and the lowest elected backing, three payee choices', build: () => scene({ drive: async (h) => { await toBond(h); await h.type('#validate-setup-bond', '500'); } }), need: ['#validate-setup-bond[data-input-kind="amount"]', 'fieldset.validate-setup-payee'], primary: 1 },
    { id: 'step5-review', title: 'Step 5, review: each call in plain words, the call name and its arguments; fee, one signature, the slashing panel ticked, timing', build: () => scene({ drive: toReview }), need: ['ol.validate-review > li', '.validate-warnings', '#validate-setup-ack:checked'], primary: 1 },
    { id: 'resume-bonded-keys', title: 'Resume: already bonded with keys registered: opens at Commission, steps 2 and 3 "Done on chain"', build: () => scene({ api: fakeApi(BONDED) }), need: ['.validate-step-done', '#validate-setup-commission'], primary: 1 },
    { id: 'resume-review', title: 'Resume review: the batch holds staking.validate only', build: () => scene({ api: fakeApi(BONDED), drive: async (h) => { await h.type('#validate-setup-commission', '5'); await h.click('[data-setup-action="next"]'); } }), need: ['ol.validate-review > li'], primary: 1 }
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
    if (greens.length) err.push('green on [' + greens.join(', ') + '], the wizard has none');
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
    const h = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Validate, Sprint 3: setup wizard</title>
<style id="app-css">${APP_CSS}</style>
<style id="chrome-css">${CHROME_CSS}</style></head><body>
<h1>Validate, Sprint 3: the setup wizard (feat/validator-s3-setup)</h1>
<p class="lead">The branch's real index.html shell, styles.css and view, in frames at 1280 px and 390 px, driven to each step against a fake chain whose calls are the real spec 393 codecs. Accounts, keys and balances are synthetic. Labels and titles are outside the frames.</p>
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
    await expectFail('wrong primary count', () => renderScene({ ...one, primary: 0 }), /primary buttons/);
    await expectFail('missing element', () => renderScene({ ...one, need: ['.does-not-exist'] }), /no \.does-not-exist/);
    await expectFail('green on a neutral word', () => renderScene({ ...one, build: async () => { const r = await one.build(); r.el.querySelector('.validate-step-name').classList.add('is-positive'); return r; } }), /green on/);
    const ok = await build([one]);
    await expectFail('remote font url', async () => checkFile(ok.replace('</style>', '@font-face{src:url(https://x.test/a.woff2)}</style>')), /not a data: URI/);
    await expectFail('styles.css changed', async () => checkFile(ok.replace('.validate-review {', '.validate-review  {')), /byte for byte/);
    await expectFail('over budget', async () => checkFile(ok + 'x'.repeat(600 * 1024)), /500 KB budget/);
}

if (selftest) { await guardSelfTest(); process.exit(0); }
if (!out) { console.error('usage: node --experimental-sqlite test/helpers/preview-validate-setup.mjs <out.html> [--selftest]'); process.exit(2); }
try {
    const h = await build(SCENES);
    writeFileSync(out, h);
    console.log(`wrote ${out}: ${h.length} bytes, ${SCENES.length} scenes`);
    process.exit(0);
} catch (e) {
    console.error('REFUSED, file not written:\n' + e.message);
    process.exit(1);
}
