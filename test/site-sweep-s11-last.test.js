// Sprint 11, the designer's last follow-ups (colour roles approved by the CEO: pink is only the one main action; text
// that is not a main action is neutral or takes its own role). The REAL styles.css is parsed (test/helpers/css-rules.js
// through test/helpers/phone-width.js); the markup checks use the real tx-found scene built by tools/preview-scenes.mjs.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { parseRules } from './helpers/css-rules.js';
import { RULES, STYLES, declsIn, declared, px } from './helpers/phone-width.js';

const TOOL = fileURLToPath(new URL('../tools/preview-scenes.mjs', import.meta.url));
const d = (sel) => declsIn(sel, '');
const line = (sel) => (RULES.find(r => r.selectors.includes(sel)) || {}).line;

describe('1: the mobile wallet call to action is the one main action (gradient, light text)', () => {
    test('.mobile-wallet-cta is background var(--brand-gradient) with color var(--text-primary), no plain pink fill, no #fff', () => {
        assert.equal(d('.mobile-wallet-cta').background, 'var(--brand-gradient)');
        assert.equal(d('.mobile-wallet-cta').color, 'var(--text-primary)');
    });
});

describe('2: home links to blocks and hashes are neutral, underlined on hover, like addresses', () => {
    for (const sel of ['.view-all', '.item-title']) {
        test(`${sel}: color var(--text-primary)`, () => assert.equal(d(sel).color, 'var(--text-primary)', `styles.css:${line(sel)}`));
        test(`${sel}:hover underlines`, () => assert.equal(d(sel + ':hover')['text-decoration'], 'underline'));
    }
});

describe('3: pink text under 18 px', () => {
    test('.addr-label, .motion-index and .help-glossary dt are var(--text-primary); .brand-eyebrow (a caption) is var(--text-secondary)', () => {
        assert.equal(d('.addr-label').color, 'var(--text-primary)');
        assert.equal(d('.motion-index').color, 'var(--text-primary)');
        assert.equal(d('.help-glossary dt').color, 'var(--text-primary)');
        assert.equal(d('.brand-eyebrow').color, 'var(--text-secondary)');
    });
    test('the two compound motion indexes follow .motion-index', () => {
        assert.equal(d('.gov-proposal-link.motion-index').color, 'var(--text-primary)');
        assert.equal(d('.gov-item-link.motion-index').color, 'var(--text-primary)');
    });
    test('.badge.stake-badge-warn is the amber attention role like the other warn chips', () => {
        const w = d('.badge.stake-badge-warn');
        assert.equal(w.color, 'var(--accent-amber)');
        assert.equal(w.background, 'var(--accent-amber-tint)');
        assert.equal(w.border, '1px solid var(--accent-amber-line)');
    });
});

describe('4: a long JSON string wraps instead of scrolling the page sideways', () => {
    test('.json-string has overflow-wrap: anywhere in the stylesheet', () => assert.equal(d('.json-string')['overflow-wrap'], 'anywhere'));
    describe('the real tx-found scene at 375', () => {
        let dir = null, doc = null, err = null;
        before(() => {
            dir = mkdtempSync(join(tmpdir(), 's11-last-'));
            try {
                execFileSync(process.execPath, ['--experimental-sqlite', TOOL, '--wp', 'site', '--out', dir], { stdio: 'pipe', timeout: 400000, maxBuffer: 1 << 26 });
                const html = readFileSync(join(dir, 'site-tx-found-375.html'), 'utf8');
                const inner = /srcdoc="([^"]*)"/.exec(html)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
                const win = new Window({ url: 'https://explorer.test/', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
                win.document.body.innerHTML = (/<body[^>]*>([\s\S]*)<\/body>/.exec(inner) || [])[1] || '';
                doc = win.document;
            } catch (e) { err = String(e.stderr || e.message).split('\n').slice(0, 4).join('\n'); }
        }, { timeout: 560000 });
        after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
        test('site-tx-found-375: every drawn .json-string inside .json-container wraps (overflow-wrap anywhere)', () => {
            assert.equal(err, null, err);
            const strings = Array.from(doc.querySelectorAll('.json-container .json-string'));
            assert.ok(strings.length > 0, 'the scene has no .json-string to wrap');
            const bad = strings.filter(e => declared(e, 'overflow-wrap', 375) !== 'anywhere').map(e => e.textContent.slice(0, 30));
            assert.deepEqual(bad, []);
        });
    });
});

describe('5: Nay matches Aye; no off-kit red', () => {
    test('.motion-btn.nay background is var(--accent-red-tint)', () => assert.equal(d('.motion-btn.nay').background, 'var(--accent-red-tint)'));
    test('.motion-tx-error uses the red tint and line tokens', () => {
        const e = d('.motion-tx-error');
        assert.equal(e.background, 'var(--accent-red-tint)');
        assert.equal(e.border, '1px solid var(--accent-red-line)');
    });
    test('rgba(255, 77, 77, a) is written only in :root, where the tokens are defined', () => {
        const css = STYLES.replace(/\/\*[\s\S]*?\*\//g, '');
        const rootEnd = css.indexOf('}', css.indexOf(':root'));
        const hits = [];
        css.split('\n').forEach((l, i) => { if (/rgba\(\s*255\s*,\s*77\s*,\s*77\b/.test(l) && css.split('\n').slice(0, i).join('\n').length > rootEnd) hits.push(`styles.css:${i + 1} ${l.trim().slice(0, 80)}`); });
        assert.deepEqual(hits, []);
    });
});

// ── The site-wide pink-text guard ──
// Brand pink as a text colour is for one thing, the main action (a gradient fill with light text), and for glyphs at
// 18 px or more. Skipped by kind: hover, focus and pressed states (a transient cue), and icons and glyphs (a drawn
// symbol, not read text). Everything else that sets color to the brand pink must be listed here, with its reason.
const PINK = /var\(--brand-primary\)|rgba\(\s*230\s*,\s*0\s*,\s*122|#e6007a/i;
const STATE = /:(hover|focus|focus-visible|active)\b|\[aria-pressed="true"\]/;
const ICON = /(icon|spinner|chevron|\.bx\b)|(^|[\s>+~])i(?=$|[\s.:[>+~])/;
const EXEMPT = new Map([
    ['.stat-value.highlight', 'a 24 px headline figure (.stat-value is 1.5rem), large text'],
    ['.ui-tile.is-pink', 'a glyph tile, the glyph is 20 px or more (test/colour-roles.test.js)'],
    ['.wallet-ext-tile.is-lg[data-kind="phone"]', 'a glyph at 20 px or more (test/colour-roles.test.js)'],
    ['.data-table thead th.table-th.sorted', 'state marker: the one sorted column head; a pink header would be the only cue that the sort is on'],
    ['.help-nav-link.active', 'state marker: the current page in the help sidebar, on its own pink tint']
]);
const underEighteen = (r) => { const n = px(r.decls['font-size']); return n == null || n < 18; };
const pinkText = (rules) => rules.filter(r => PINK.test(r.decls.color || '') && underEighteen(r))
    .flatMap(r => r.selectors.filter(s => !STATE.test(s) && !ICON.test(s) && !EXEMPT.has(s)).map(s => `styles.css:${r.line} ${s} { color: ${r.decls.color} }`));
describe('guard: no selector colours text with the brand pink under 18 px outside the named exemptions', () => {
    test('the stylesheet', () => assert.deepEqual(pinkText(RULES), [], 'pink text under 18 px (use var(--text-primary), var(--text-secondary) or a role colour, or add a reasoned exemption)'));
    test('the guard sees what it is meant to see (a pink caption, a pink link and an rgba pink are caught; a hover, an icon, a 24 px figure and a listed state are not)', () => {
        const probe = parseRules('.a { color: var(--brand-primary); font-size: 0.8rem; } .b { color: var(--brand-primary); } .c { color: rgba(230, 0, 122, 0.9); font-size: 12px; } .d:hover { color: var(--brand-primary); } .e i { color: var(--brand-primary); } .f { color: var(--brand-primary); font-size: 1.5rem; } .help-nav-link.active { color: var(--brand-primary); } .g { color: var(--text-primary); }');
        assert.equal(pinkText(probe).length, 3);
        assert.deepEqual(pinkText(probe).map(x => x.split(' ')[1]), ['.a', '.b', '.c']);
    });
    test('every exemption still exists and still sets pink (a stale exemption hides nothing and must go)', () => {
        for (const sel of EXEMPT.keys()) assert.ok(RULES.some(r => r.selectors.includes(sel) && PINK.test(r.decls.color || '')), `${sel} is exempt but no longer sets pink`);
    });
});
