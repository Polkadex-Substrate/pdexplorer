// T9 of the Multisig wallets and Advanced cards spec (cto-team/plans/2026-11-25-multisig-and-advanced-cards.md, 6.1):
// scripts/check-wallet-legacy.mjs fails the build on a .staking-download-btn or a colour, background or border written
// in markup anywhere on the wallet page and its sub-views, and caps the 34 legacy uses elsewhere. Each rule is broken
// once on a fixture first and its MESSAGE is read (file, line, offending text), not only its exit code.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkLegacy, report, lineOffences, functionLines, WALLET_FILES, WALLET_FUNCTIONS, CEILING, EXCLUDE } from '../scripts/check-wallet-legacy.mjs';

const GUARD = fileURLToPath(new URL('../scripts/check-wallet-legacy.mjs', import.meta.url));
const SCRIPT = ['function renderApiError(c) {', '  c.innerHTML = "<p>ok</p>";', '}',
    ...WALLET_FUNCTIONS.filter(n => n !== 'renderApiError').map(n => `async function ${n}(a, { b = {} } = {}) {\n  return a;\n}`)].join('\n');
const clean = () => {
    const files = { 'script.js': SCRIPT, 'index.html': '<button class="x">a</button>' };
    for (const f of WALLET_FILES) files[f] = 'export const x = `<button class="ui-action">Go</button>`;\n';
    return files;
};
const run = (files, ceiling = CEILING) => checkLegacy({ read: (p) => (p in files ? files[p] : null), list: () => Object.keys(files), ceiling });

describe('T9: the guard, broken once per rule on a fixture', () => {
    test('a clean fixture passes', () => {
        const r = run(clean());
        assert.equal(r.ok, true, report(r));
        assert.match(report(r), /^wallet legacy guard: OK/);
    });
    test('the class in a wallet-page file: refused with the file, the line and the text', () => {
        const f = clean();
        f['lib/multisig-view.js'] = 'const a = 1;\nconst b = `<button class="staking-download-btn multisig-discover">Refresh discovery</button>`;\n';
        const r = run(f);
        assert.equal(r.ok, false);
        const text = report(r);
        assert.match(text, /^WALLET LEGACY GUARD FAILED/);
        assert.match(text, /lib\/multisig-view\.js:2: \.staking-download-btn: const b = `<button class="staking-download-btn multisig-discover">Refresh discovery/);
        assert.match(text, /Pick the tier/);
    });
    test('a colour, a background, a border, an interpolated style and a style set from script are each refused', () => {
        for (const [line, why] of [
            ['<span style="color:var(--error);">x</span>', /a colour, background or border in a style attribute/],
            ['<div style="padding:4px;background:rgba(0,0,0,0.3)">', /a colour, background or border in a style attribute/],
            ['<div style="border-top:1px solid var(--border-color)">', /a colour, background or border in a style attribute/],
            ['<div style="${MUTED}">', /a style attribute built from an interpolation/],
            ['value.style.color = "red";', /a colour, background or border set on \.style from script/],
            ["ta.setAttribute('style', 'color:red');", /a colour, background or border set with setAttribute/]
        ]) {
            const f = clean();
            f['lib/payout-refresh.js'] = line + '\n';
            const r = run(f);
            assert.equal(r.ok, false, line);
            assert.match(report(r), new RegExp('lib/payout-refresh\\.js:1: ' + why.source), line);
        }
    });
    test('a layout-only style attribute, a comment and a border-radius pass', () => {
        assert.deepEqual(lineOffences('<div style="padding: 8px 24px 20px;">'), []);
        assert.deepEqual(lineOffences('<div style="height:220px;">'), []);
        assert.deepEqual(lineOffences('// the old .staking-download-btn used style="color:red"'), []);
        assert.deepEqual(lineOffences('<div style="border-radius:4px">'), []);
        assert.deepEqual(lineOffences("modal.style.display = 'none';"), []);
    });
    test('script.js is checked inside the wallet renderers only, found by name; a renamed renderer is refused', () => {
        const f = clean();
        f['script.js'] = SCRIPT.replace('c.innerHTML = "<p>ok</p>";', 'c.innerHTML = `<button class="staking-download-btn" data-api-error-retry>Retry</button>`;')
            + '\nfunction elsewhere() {\n  return `<button class="staking-download-btn">CSV</button>`;\n}\n';
        const r = run(f);
        assert.equal(r.ok, false);
        assert.match(report(r), /script\.js:2 \(renderApiError\): \.staking-download-btn/);
        assert.equal(r.outside.length, 1, 'the use outside the renderers is counted toward the ceiling, not refused');
        const g = clean();
        g['script.js'] = SCRIPT.replace('function renderProxyList(', 'function renderProxyRows(');
        assert.match(report(run(g)), /function renderProxyList not found/);
    });
    test('a wallet-page file that is missing is refused (the guard never passes on nothing)', () => {
        const f = clean();
        delete f['lib/wallet-advanced-view.js'];
        assert.match(report(run(f)), /lib\/wallet-advanced-view\.js: the file is missing/);
    });
    test('the ceiling: 34 uses elsewhere pass, 35 are refused with every place named', () => {
        const f = clean();
        f['lib/discussion-auth.js'] = Array.from({ length: 34 }, () => '<button class="staking-download-btn">x</button>').join('\n');
        assert.equal(run(f).ok, true);
        f['index.html'] = '<a class="staking-download-btn">y</a>';
        const r = run(f);
        assert.equal(r.ok, false);
        assert.match(report(r), /used 35 times outside the wallet page; the ceiling is 34 and may only go down/);
        assert.match(report(r), /index\.html:1/);
    });
    test('the ceiling scan is an exclusion list: a new file is read without being added anywhere', () => {
        const f = clean();
        f['lib/brand-new-view.js'] = Array.from({ length: 35 }, () => 'staking-download-btn').join('\n');
        assert.equal(run(f).ok, false);
        f['test/fixture.js'] = f['lib/brand-new-view.js'];
        delete f['lib/brand-new-view.js'];
        assert.equal(run(f).ok, true, 'test/ is on the exclusion list');
        assert.ok(EXCLUDE.some(x => x.test('node_modules/a.js')));
    });
    test('functionLines finds a declaration by name past a parameter default with braces', () => {
        const src = 'const x = 1;\nasync function renderProxyList(a, { b = {} } = {}) {\n  if (a) { return 1; }\n  return 2;\n}\n';
        assert.deepEqual(functionLines(src, 'renderProxyList'), [2, 5]);
        assert.equal(functionLines(src, 'renderMissing'), null);
    });
});

describe('T9: the guard on this repository (run as npm test runs it)', () => {
    test('scripts/check-wallet-legacy.mjs exits 0: no legacy control on the wallet page, the ceiling holds', () => {
        const r = spawnSync(process.execPath, [GUARD], { encoding: 'utf8' });
        assert.equal(r.status, 0, `the guard refused:\n${r.stderr || r.stdout}`);
        assert.match(r.stdout, /wallet legacy guard: OK/);
    });
});
