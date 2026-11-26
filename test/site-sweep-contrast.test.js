// Sprint 11 site sweep, WP1 (cto-team/plans/2026-11-26-sprint11-site-sweep.md, sections 1.0, 2.1, 3.1, 3.2 and 6.1):
// the parsed stylesheet. T1 the kit classes of 2.1 with their exact declarations; T2 the tiers (no legacy class, the
// holding .is-solid primary, the danger text hover, a disabled .ui-action); T3 contrast computed from the :root tokens
// with the WCAG formula: the 40 rules of 3.1 read at 4.5:1 or better on the surface at 0.75rem or more, and only the
// five rules of 3.2 keep --text-muted. Plus the WP1 rules the signing modals need (I31, I34, I35, P13).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRules, rootProps } from './helpers/css-rules.js';

const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const RULES = parseRules(CSS).map(r => ({ ...r, media: (r.media || '').replace(/\s*\{\s*$/, '').replace(/\s+/g, ' ').trim() }));
const { props } = rootProps(CSS);
// Every declaration of the base-media rules that name exactly this selector, later rules winning.
const base = (sel) => { const out = {}; for (const r of RULES) if (!r.media && r.selectors.includes(sel)) Object.assign(out, r.decls); return out; };
const anyRule = (sel) => RULES.some(r => r.selectors.includes(sel));

// ── WCAG contrast from the tokens ──
const resolve = (v, seen = 0) => { const m = /^var\((--[\w-]+)(?:,\s*([^)]+))?\)$/.exec(String(v || '').trim()); if (!m || seen > 6) return String(v || '').trim(); return resolve(props[m[1]] || m[2], seen + 1); };
const rgb = (h) => { const x = h.replace('#', ''); const f = x.length === 3 ? x.split('').map(c => c + c).join('') : x.slice(0, 6); return [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16)); };
const lum = (h) => { const [r, g, b] = rgb(h).map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const rem = (v) => { const m = /^([\d.]+)(rem|em|px)$/.exec(String(v || '')); return m ? (m[2] === 'px' ? Number(m[1]) / 16 : Number(m[1])) : null; };

describe('T1: the kit classes of 2.1, exact declarations', () => {
    const TS = 'var(--text-secondary)', TP = 'var(--text-primary)', AMBER = 'var(--accent-amber)', BORDER = '1px solid var(--border-color)';
    const KIT = {
        '.ui-state': { padding: '24px', 'text-align': 'center', 'font-size': '0.9rem', 'line-height': '1.6', color: TS },
        '.ui-state.is-roomy': { padding: '40px 24px' },
        '.ui-state > .bx': { 'margin-right': '8px', 'font-size': '18px', 'vertical-align': '-3px' },
        '.ui-state.is-wait': { color: TP }, '.ui-state.is-failed': { color: TP }, '.ui-state.is-invalid': { color: TP },
        '.ui-state.is-wait > .bx': { color: AMBER }, '.ui-state.is-failed > .bx': { color: AMBER },
        '.ui-state.is-invalid > .bx': { color: 'var(--accent-red)' },
        '.ui-caption': { 'font-size': '0.82rem', 'line-height': '1.5', color: TS },
        '.data-table .ui-caption': { 'font-size': '0.75rem' }, '.staking-summary-card .ui-caption': { 'font-size': '0.75rem' },
        '.ui-caption.is-warn': { color: AMBER },
        '.ui-lede': { margin: '0 0 12px', 'font-size': '0.9rem', 'line-height': '1.6', color: TS },
        '.ui-quiet': { color: TS, 'font-weight': '400' },
        '.ui-strong': { color: TP, 'font-weight': '600' },
        '.ui-positive': { color: 'var(--brand-secondary)', 'font-weight': '500' },
        '.ui-code': { padding: '1px 6px', 'border-radius': '3px', background: 'rgba(255, 255, 255, 0.05)', color: 'var(--accent-violet-text)', 'font-family': 'monospace', 'font-size': '0.85em', 'overflow-wrap': 'anywhere' },
        '.ui-glyph': { 'flex-shrink': '0' },
        '.ui-glyph.is-muted': { color: TS }, '.ui-glyph.is-green': { color: 'var(--accent-green)' }, '.ui-glyph.is-amber': { color: AMBER },
        '.ui-glyph.is-red': { color: 'var(--accent-red)' }, '.ui-glyph.is-blue': { color: 'var(--accent-blue-text)' }, '.ui-glyph.is-violet': { color: 'var(--accent-violet-text)' },
        '.ui-ruled': { 'padding-bottom': '12px', 'border-bottom': BORDER },
        '.ui-ruled-top': { 'padding-top': '12px', 'border-top': BORDER },
        '.list-header.is-ruled': { padding: '20px', 'border-bottom': BORDER },
        'table.ui-kv': { width: '100%', 'border-collapse': 'collapse' },
        'table.ui-kv tr:nth-child(even)': { background: 'rgba(255, 255, 255, 0.02)' },
        'table.ui-kv td': { padding: '12px 20px' },
        'table.ui-kv td:first-child': { color: TS },
        '.ui-kv-wrap': { 'margin-bottom': '20px', border: BORDER, 'border-radius': 'var(--radius-sm)', background: 'rgba(255, 255, 255, 0.02)', overflow: 'hidden' },
        '.ui-readout': { padding: '12px 16px', background: 'var(--bg-dark)', border: BORDER, 'border-radius': 'var(--radius-sm)', 'font-family': 'monospace', 'font-size': '0.85rem', 'overflow-wrap': 'anywhere' },
        '.ui-chart-box': { height: '250px', padding: '16px', background: 'var(--bg-dark)', border: BORDER, 'border-radius': 'var(--radius-sm)' },
        '.ui-fieldset': { margin: '0 0 16px', padding: '0', border: '0' },
        '.ui-hr': { margin: '24px 0 16px', border: '0', 'border-top': BORDER }
    };
    for (const [sel, want] of Object.entries(KIT)) {
        test(`${sel}: exactly ${JSON.stringify(want)}`, () => {
            assert.deepEqual(base(sel), want, `${sel} in styles.css`);
        });
    }
    test('none of them names --text-muted, a hex or an rgb triple other than the white neutral; violet text is --accent-violet-text, never --violet', () => {
        for (const sel of Object.keys(KIT)) {
            const d = JSON.stringify(base(sel));
            assert.doesNotMatch(d, /--text-muted|#[0-9a-f]{3,8}\b/i, sel);
            for (const m of d.matchAll(/rgba?\(([^)]*)\)/g)) assert.match(m[1], /^255, 255, 255,/, `${sel}: ${m[0]} is not the white neutral`);
            assert.doesNotMatch(d, /var\(--violet\)/, sel);
        }
    });
});

describe('T2: the tiers (section 1.0)', () => {
    test('no rule names .staking-download-btn; .staking-search-bar button keeps its three rules', () => {
        const hits = RULES.filter(r => r.selectors.some(s => s.includes('staking-download-btn'))).map(r => `line ${r.line}: ${r.selectors.join(', ')}`);
        assert.deepEqual(hits, []);
        for (const s of ['.staking-search-bar button', '.staking-search-bar button:hover', '.staking-search-bar button:active']) assert.ok(anyRule(s), `${s} went`);
    });
    test('.validate-primary.is-solid { background: var(--brand-primary) } is the only rule that gives a .validate-primary a non-gradient background', () => {
        assert.deepEqual(base('.validate-primary.is-solid'), { background: 'var(--brand-primary)' });
        const others = RULES.filter(r => r.selectors.some(s => /\.validate-primary(?![\w-])/.test(s) && s !== '.validate-primary.is-solid' && s !== '.validate-primary')
            && (r.decls.background || r.decls['background-color']) && !/gradient|none|transparent/.test(r.decls.background || r.decls['background-color']));
        assert.deepEqual(others.map(r => `line ${r.line}: ${r.selectors.join(', ')}`), []);
    });
    test('.validate-text-btn.is-danger:hover is red (the hover of a destructive text link)', () => {
        assert.equal(base('.validate-text-btn.is-danger:hover').color, 'var(--accent-red)');
    });
    test('.ui-action:disabled { opacity: 0.55; cursor: not-allowed; } (Review motion, row 6)', () => {
        assert.deepEqual(base('.ui-action:disabled'), { opacity: '0.55', cursor: 'not-allowed' });
    });
    test('.legal-page .ui-action { margin-top: 12px; } (Reset all preferences, row 9)', () => {
        assert.deepEqual(base('.legal-page .ui-action'), { 'margin-top': '12px' });
    });
    test('the sort glyph: .table-th .bx-sort { opacity: 0.7; } (3.1, the inline 0.4 goes)', () => {
        assert.equal(base('.table-th .bx-sort').opacity, '0.7');
    });
});

describe('T3: contrast (section 3), computed from the tokens', () => {
    const SURFACE = props['--bg-surface'];
    // [selector as written, font-size after ('same': unchanged), colour after]
    const SAME = 'same';
    const R31 = [
        ['.search-container input::placeholder', SAME], ['.table-filter-bar .table-col-filter::placeholder, .table-filter-search .table-global-search::placeholder', SAME],
        ['.staking-search-bar input::placeholder', SAME], ['.item-time', '0.82rem'], ['.validators-table .sortable i, .validators-table .sortable-holder i', SAME],
        ['.table-summary', '0.82rem'], ['.table-summary-muted', SAME], ['.table-showmore-remaining', '0.82rem'], ['.data-table tbody .table-empty-row', '0.9rem'],
        ['.staking-summary-card .value-usd', '0.82rem'], ['.council-vote-count', SAME], ['.council-vote-clear-btn', '0.82rem', 'var(--text-primary)'],
        ['.council-vote-empty', SAME], ['.council-vote-row-meta', '0.75rem'], ['.council-vote-remove', SAME], ['.wallet-empty-msg', '0.9rem'],
        ['.mobile-wallet-head span', '0.82rem'], ['.wallet-step', '0.82rem'], ['.donate-disclaimer', '0.82rem'], ['.discussion-thread-meta', '0.82rem'],
        ['.discussion-closed-note', '0.9rem'], ['.md-body blockquote', SAME], ['.md-empty', SAME], ['.md-help', '0.82rem'], ['.motion-hash', '0.75rem'],
        ['.motion-meta', '0.82rem'], ['.help-breadcrumb', SAME], ['.help-prevnext span', '0.82rem'], ['.help-inline-icon', SAME], ['.brand-type-label', '0.82rem'],
        ['.price-page-source', '0.82rem'], ['.stake-val-history', '0.75rem'], ['.stake-seg-n', SAME], ['.stake-shown', SAME], ['.stake-why', '0.75rem'],
        ['.gd-muted', SAME], ['.gd-vote', '0.82rem'], ['.balance-locks-empty', '0.9rem'], ['.proxy-deposit', '0.82rem'], ['.ia-hint', '0.82rem']
    ];
    // The sizes at f33320f of the rules whose size stays ("same"): the size is not part of the change.
    const WAS = { '.validators-table .sortable i, .validators-table .sortable-holder i': '0.9em', '.council-vote-empty': '0.82rem', '.council-vote-remove': '0.95rem', '.help-breadcrumb': '0.82rem', '.help-inline-icon': '14px' };
    const rule = (sel) => RULES.find(r => !r.media && r.selectors.join(', ') === sel);
    test('there are 40 rules in the table', () => assert.equal(R31.length, 40));
    for (const [sel, size, colour = 'var(--text-secondary)'] of R31) {
        test(`3.1 ${sel}: ${colour}, ${size === SAME ? 'size unchanged' : size}, 4.5:1 or better on --bg-surface, 0.75rem or more`, () => {
            const r = rule(sel);
            assert.ok(r, `no base rule for ${sel}`);
            assert.equal(r.decls.color, colour);
            const c = resolve(r.decls.color);
            assert.ok(ratio(c, SURFACE) >= 4.5, `${sel}: ${c} is ${ratio(c, SURFACE).toFixed(2)}:1 on ${SURFACE}`);
            if (size !== SAME) assert.equal(r.decls['font-size'], size);
            else if (WAS[sel]) assert.equal(r.decls['font-size'], WAS[sel], `${sel}: the size was not to change`);
            const fs = r.decls['font-size'];
            if (fs && !/em$/.test(fs.replace(/rem$/, ''))) { const v = rem(fs); if (v != null && /rem|px/.test(fs)) assert.ok(v >= 0.75, `${sel}: ${fs} is under 0.75rem`); }
        });
    }
    test('.help-inline-icon has no opacity under 1 (a control glyph needs 3:1)', () => {
        const op = rule('.help-inline-icon').decls.opacity;
        assert.ok(op === undefined || Number(op) >= 1, `opacity ${op}`);
    });
    test('3.2: only the five kept rules have color: var(--text-muted), at any width', () => {
        const KEEP = ['select option:disabled, select optgroup:disabled', '.table-filter-search > i', '.table-pageellipsis', '.wallet-validator-row i', '.wallet-picker-empty-icon'];
        const hits = RULES.filter(r => /var\(--text-muted\)/.test(r.decls.color || '')).map(r => r.selectors.join(', '));
        assert.deepEqual(hits.filter(s => !KEEP.includes(s)), []);
        assert.deepEqual(KEEP.filter(s => !hits.includes(s)), [], 'a kept rule went missing (the guard names five)');
    });
    test('the guard measures: --text-muted is 3.85:1 on the surface, --text-secondary 7.34:1', () => {
        assert.equal(ratio(resolve('var(--text-muted)'), SURFACE).toFixed(2), '3.85');
        assert.equal(ratio(resolve('var(--text-secondary)'), SURFACE).toFixed(2), '7.34');
    });
});

describe('WP1 rules for the signing modals and the off-kit hues of section 9', () => {
    test('I34: the referendum side buttons are neutral at rest and take the green or red tokens only when pressed', () => {
        const b = base('.referendum-side-btn');
        assert.equal(b.background, 'rgba(255, 255, 255, 0.02)');
        assert.equal(b.border, '2px solid var(--border-color)');
        assert.equal(b.color, 'var(--text-secondary)');
        assert.equal(b['min-height'], '44px');
        assert.deepEqual(base('.referendum-side-btn[data-side="aye"][aria-pressed="true"]'), { background: 'var(--accent-green-tint)', 'border-color': 'var(--accent-green)', color: 'var(--accent-green)' });
        assert.deepEqual(base('.referendum-side-btn[data-side="nay"][aria-pressed="true"]'), { background: 'var(--accent-red-tint)', 'border-color': 'var(--accent-red)', color: 'var(--accent-red)' });
        assert.equal(base('.referendum-side-btn[aria-pressed="false"] .bx-check').display, 'none', 'the check shows on the pressed side only');
    });
    test('I35: the referenda table triggers carry the tokens by class', () => {
        assert.deepEqual(base('.referendum-vote-trigger.is-aye'), { color: 'var(--accent-green)', 'border-color': 'var(--accent-green-line)' });
        assert.deepEqual(base('.referendum-vote-trigger.is-nay'), { color: 'var(--accent-red)', 'border-color': 'var(--accent-red-line)' });
        const t = base('.referendum-vote-trigger');
        assert.equal(t.padding, '4px 10px');
        assert.equal(t['font-size'], '0.78rem');
    });
    test('I31: a hint or message state is a data-state rule, not a colour set from script', () => {
        for (const el of ['.staking-error', '.stake-hint']) {
            assert.equal(base(`${el}[data-state="note"]`).color, 'var(--text-secondary)', el);
            assert.equal(base(`${el}[data-state="ok"]`).color, 'var(--text-primary)', el);
            assert.equal(base(`${el}[data-state="error"]`).color, 'var(--text-primary)', el);
        }
        assert.equal(base('[data-state="ok"] > .ui-hint-icon').color, 'var(--accent-green)');
        assert.equal(base('[data-state="error"] > .ui-hint-icon').color, 'var(--accent-red)');
    });
    test('P13: the council vote card is the kit card at its own width; the tour card is .is-wide over the page (z-index 1100)', () => {
        assert.equal(base('.ui-modal-card.is-picker')['max-width'], '820px');
        assert.equal(base('.ui-modal.is-tour')['z-index'], '1100');
    });
    // Amended in the second red commit: the CTA is an action, and colour-roles guard 3 allows no accent fill on an
    // action, so it takes the neutral fill with the blue line and text; the badge (not an action) keeps the blue tint.
    test('section 9: .email-alerts-cta and .badge.stake-badge-info use the blue tokens (no cyan, no #8ab8ff)', () => {
        const cta = base('.email-alerts-cta');
        assert.deepEqual([cta.background, cta.border, cta.color], ['rgba(255, 255, 255, 0.05)', '1px solid var(--accent-blue-line)', 'var(--accent-blue-text)']);
        const hover = base('.email-alerts-cta:hover');
        assert.deepEqual([hover['border-color'], hover.color], ['var(--accent-blue)', 'var(--text-primary)']);
        assert.doesNotMatch(JSON.stringify(hover), /0, 196, 255/);
        const info = base('.badge.stake-badge-info');
        assert.deepEqual([info.background, info.color, info.border], ['var(--accent-blue-tint)', 'var(--accent-blue-text)', '1px solid var(--accent-blue-line)']);
    });
});

describe('WP1 review fixes: two stale rules', () => {
    test('.council-withdraw-actions button:disabled is gone (it outranked .validate-primary:disabled at 0.45)', () => {
        assert.equal(RULES.some(r => r.selectors.some(s => /\.council-withdraw-actions\s+button:disabled/.test(s))), false);
        assert.equal(base('.validate-primary:disabled').opacity, '0.45');
    });
    test('.ui-modal-card > .modal-submit-btn:first-child is gone (a close button is always first, so it never matched)', () => {
        assert.equal(RULES.some(r => r.selectors.some(s => /modal-submit-btn:first-child/.test(s))), false);
    });
});
