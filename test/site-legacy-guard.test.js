// Sprint 11 site sweep, WP1 (cto-team/plans/2026-11-26-sprint11-site-sweep.md, sections 1.2, 2.6, 3.2 and 6.4):
// scripts/check-ui-legacy.mjs, G1 (no .staking-download-btn anywhere) and G4 (no --text-muted text in styles.css
// outside the five kept rules) final, G2 (inline colour) and G3 (hue) as ceilings that may only go down. Every guard is
// broken once on a fixture built from the REAL sources with one mutation, and its MESSAGE is read (file, line, fix);
// then the guard runs on this repository as npm test runs it, and its message is shown when it refuses.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guard = await import('../scripts/check-ui-legacy.mjs').then((m) => m, () => ({}));
const need = (name) => { assert.ok(guard[name] !== undefined, `scripts/check-ui-legacy.mjs does not export ${name}`); return guard[name]; };
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GUARD = fileURLToPath(new URL('../scripts/check-ui-legacy.mjs', import.meta.url));
const WALLET_GUARD = fileURLToPath(new URL('../scripts/check-wallet-legacy.mjs', import.meta.url));

// The real repository as a map, read once; each test copies it and mutates one file.
let REPO = null;
function repo() {
    if (REPO) return REPO;
    const { read, list } = need('repoReader')(ROOT);
    REPO = new Map();
    for (const p of list()) if (/\.(m?js|cjs|html|css)$/.test(p)) REPO.set(p, read(p));
    return REPO;
}
const fixture = (mutate) => {
    const files = new Map(repo());
    mutate(files);
    return { read: (p) => (files.has(p) ? files.get(p) : null), list: () => Array.from(files.keys()) };
};
const prepend = (files, p, line) => files.set(p, line + '\n' + files.get(p));
// The counts of the real sources become the ceilings, so a fixture differs from its base by the one mutation only.
const baseline = () => need('checkSite')(fixture(() => {}), { g2: big, g3: big, g4: 1e9 }).counts;
const big = { 'script.js': 1e9, 'index.html': 1e9, 'lib/': 1e9, other: 1e9, 'styles.css': 1e9 };
const at = (c) => ({ g2: { ...c.g2 }, g3: { ...c.g3 }, g4: c.g4.sources });
const errorsOf = (files, opts) => need('checkSite')(files, opts).errors;

describe('G1: the legacy class, anywhere', () => {
    test('a .staking-download-btn added to lib/gov-detail-view.js is refused with the file, the line and "pick a tier"', () => {
        const errs = errorsOf(fixture(f => prepend(f, 'lib/gov-detail-view.js', 'const legacy = `<button type="button" class="staking-download-btn">Copy link</button>`;')), { g2: big, g3: big, g4: 1e9 });
        assert.ok(errs.some(e => /^lib\/gov-detail-view\.js:1: \.staking-download-btn no longer exists; pick a tier/.test(e)), errs.slice(0, 5).join('\n'));
    });
    test('a rule for it in styles.css is refused too', () => {
        const errs = errorsOf(fixture(f => f.set('styles.css', f.get('styles.css') + '\n.staking-download-btn { color: var(--text-primary); }\n')), { g2: big, g3: big, g4: 1e9 });
        assert.ok(errs.some(e => /^styles\.css:\d+: \.staking-download-btn no longer exists; pick a tier/.test(e)), errs.slice(0, 5).join('\n'));
    });
});

describe('G2: colour written in markup (ceilings per bucket, may only go down)', () => {
    const run = (p, line) => { const c = baseline(); return errorsOf(fixture(f => prepend(f, p, line)), at(c)); };
    test('(a) style="color: var(--text-secondary)" in script.js: refused with the file, the line, the form and the fix', () => {
        const errs = run('script.js', 'const a = `<p style="color: var(--text-secondary)">x</p>`;');
        assert.ok(errs.some(e => /G2 inline colour: \d+ lines in script\.js .*Move the colour into a class\. Lines: .*script\.js:1 \(a colour, background or border in a style attribute\)/.test(e)), errs.join('\n').slice(0, 1500));
    });
    test('(b) el.style.background = \'var(--error)\' in a lib file: refused', () => {
        const errs = run('lib/discussion-links.js', "function paint(el) { el.style.background = 'var(--error)'; }");
        assert.ok(errs.some(e => /G2 inline colour: \d+ lines in lib\/ .*Move the colour into a class\. Lines: .*lib\/discussion-links\.js:1 \(a colour, background or border set on \.style from script\)/.test(e)), errs.join('\n').slice(0, 1500));
    });
    test('(c) style="color:${tone}": refused (the guard cannot see the value)', () => {
        const errs = run('script.js', 'const b = `<span style="color:${tone}">n</span>`;');
        assert.ok(errs.some(e => /G2 inline colour: .*Move the colour into a class\. Lines: .*script\.js:1 \(a style attribute built from an interpolation\)/.test(e)), errs.join('\n').slice(0, 1500));
    });
    test('(d) control: style="width:${pct}%" passes (layout only)', () => {
        const errs = run('script.js', 'const c = `<div class="motion-bar-fill" style="width:${pct}%"></div>`;');
        assert.ok(!errs.some(e => /^G2 /.test(e)), errs.filter(e => /^G2 /.test(e)).join('\n'));
    });
    test('(e) an exemption entry that matches nothing fails (no stale exemptions)', () => {
        const stale = need('EXEMPT').concat([{ file: 'script.js', fn: 'renderBrandPage', match: /no-such-swatch/, guards: ['G2'], why: 'a test entry' }]);
        const errs = errorsOf(fixture(() => {}), { g2: big, g3: big, g4: 1e9, exempt: stale });
        assert.ok(errs.some(e => /script\.js renderBrandPage: the exemption matches nothing \(a stale exemption\)/.test(e)), errs.slice(-3).join('\n'));
    });
    test('on this repository every exemption matches a line (no stale exemption)', () => {
        const errs = errorsOf(fixture(() => {}), { g2: big, g3: big, g4: 1e9 });
        assert.deepEqual(errs.filter(e => /stale exemption/.test(e)), []);
    });
    test('every exemption carries its reason, and one without a reason fails', () => {
        for (const e of need('EXEMPT')) assert.ok(e.why && e.why.length > 10, `${e.file} ${e.fn || ''}: no reason`);
        const bare = need('EXEMPT').map((e, i) => (i === 0 ? { ...e, why: '' } : e));
        const errs = errorsOf(fixture(() => {}), { g2: big, g3: big, g4: 1e9, exempt: bare });
        assert.ok(errs.some(e => /exemption without a reason/.test(e)));
    });
});

describe('G3: hues outside the kit', () => {
    test('(a) \'#f5a623\' in a string in script.js: refused with the file, the line, the value and "not a kit colour"', () => {
        const c = baseline();
        const errs = errorsOf(fixture(f => prepend(f, 'script.js', "const tone = '#f5a623';")), at(c));
        assert.ok(errs.some(e => /G3 hue: \d+ lines in script\.js .*not a kit colour.*Lines \(value\): .*script\.js:1 \(#f5a623\)/.test(e)), errs.join('\n').slice(0, 1500));
    });
    test('(b) color: orange in styles.css: refused with the line and the value', () => {
        const c = baseline();
        const errs = errorsOf(fixture(f => f.set('styles.css', f.get('styles.css').replace('.ui-section-title {', '.pv-guard-probe { color: orange; }\n.ui-section-title {'))), at(c));
        assert.ok(errs.some(e => /G3 hue: \d+ lines in styles\.css hold a colour that is not a kit colour.*styles\.css:\d+ \(orange\)/.test(e)), errs.join('\n').slice(0, 1500));
    });
    // Added in the second red commit: the colour-name detector read "violet" and "green" inside token names.
    test('(d) control: token names are not hues (var(--accent-violet-text), var(--accent-green-tint), var(--brand-secondary)) in styles.css or a string', () => {
        const c = baseline();
        const errs = errorsOf(fixture(f => {
            prepend(f, 'script.js', "const a = `<span style=\"display:none\" data-tone=\"color: var(--accent-violet-text)\">x</span>`;");
            f.set('styles.css', f.get('styles.css') + '\n.pv-guard-probe { color: var(--accent-violet-text); background: var(--accent-green-tint); border-color: var(--accent-red-line); }\n');
        }), at(c));
        assert.ok(!errs.some(e => /^G3 /.test(e)), errs.filter(e => /^G3 /.test(e)).join('\n').slice(0, 600));
        assert.deepEqual(need('sourceHues')('el.className = `x`; const v = "color: var(--accent-green)";'), []);
        assert.deepEqual(need('cssHues')('.a { color: var(--accent-violet-text); }', need('kitColours')(repo().get('styles.css'))), []);
    });
    test('(c) control: var(--accent-amber) passes', () => {
        const c = baseline();
        const errs = errorsOf(fixture(f => { prepend(f, 'script.js', "const tone = 'var(--accent-amber)';"); f.set('styles.css', f.get('styles.css') + '\n.pv-guard-probe { color: var(--accent-amber); }\n'); }), at(c));
        assert.ok(!errs.some(e => /^G3 /.test(e)), errs.filter(e => /^G3 /.test(e)).join('\n'));
    });
});

describe('G4: --text-muted as the colour of text people must read', () => {
    test('.ui-caption { color: var(--text-muted) } is refused with the selector, the line and "text people must read"', () => {
        const errs = errorsOf(fixture(f => f.set('styles.css', f.get('styles.css') + '\n.ui-caption { color: var(--text-muted); }\n')), { g2: big, g3: big, g4: 1e9 });
        assert.ok(errs.some(e => /^styles\.css:\d+: \.ui-caption \{ color: var\(--text-muted\) \} is text people must read/.test(e)), errs.filter(e => /text-muted/.test(e)).join('\n'));
    });
    test('the five rules of 3.2 keep it, each with its reason; deleting a reason fails ("exemption without a reason")', () => {
        const keep = need('MUTED_KEEP');
        assert.deepEqual(Object.keys(keep).sort(), ['.table-filter-search > i', '.table-pageellipsis', '.wallet-picker-empty-icon', '.wallet-validator-row i', 'select option:disabled, select optgroup:disabled']);
        for (const [sel, why] of Object.entries(keep)) assert.ok(why && why.length > 10, `${sel}: no reason`);
        const bare = { ...keep, '.table-pageellipsis': '' };
        const errs = errorsOf(fixture(() => {}), { g2: big, g3: big, g4: 1e9, keep: bare });
        assert.ok(errs.some(e => /\.table-pageellipsis: exemption without a reason/.test(e)), errs.filter(e => /reason/.test(e)).join('\n'));
    });
});

describe('the guards on this repository (run as npm test runs it)', () => {
    test('scripts/check-ui-legacy.mjs exits 0: G1 and G4 clean, G2, G3 and the G4 source count within their ceilings', () => {
        const r = spawnSync(process.execPath, [GUARD], { encoding: 'utf8' });
        assert.equal(r.status, 0, `the guard refused:\n${(r.stderr || r.stdout).split('\n').slice(0, 12).join('\n')}`);
        assert.match(r.stdout, /site legacy guard: OK/);
    });
    test('scripts/check-wallet-legacy.mjs exits 0 with the ceiling at 0: no .staking-download-btn is left outside the wallet page', () => {
        const r = spawnSync(process.execPath, [WALLET_GUARD], { encoding: 'utf8' });
        assert.equal(r.status, 0, `the wallet guard refused:\n${(r.stderr || r.stdout).slice(0, 800)}`);
        assert.match(r.stdout, /wallet legacy guard: OK \(wallet-page sources clean; 0 of 0 uses/);
    });
});
