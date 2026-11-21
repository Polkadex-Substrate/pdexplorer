// Product colour roles, work package 1 (spec cto-team/plans/2026-11-21-validate-redesign-and-colour-roles.md,
// sections 1, 2, 6, 7, 8): the tokens, the shared ui-* parts and the wallet connect page.
//
// Pink acts, violet structures, green is good, amber is attention, blue is guidance, red is failure.
// Colour is carried by small full-strength parts on neutral surfaces; no accent tint ever fills a row or a card.
//
// Every guard here is a function of the CSS text (or of rendered markup) so it can be run on a broken copy
// and made to fail with a message that names the selector (see the last describe).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { readRepo } from './helpers/source.js';
import { parseRules, rootProps } from './helpers/css-rules.js';
import { mountChooser, fakeWallet, acct, addr } from './helpers/chooser-world.js';
import { buildAccountListHtml, buildOptionRowsHtml, tileHtml, SAFETY_LINE, DIFFERENT_WALLET_HTML } from '../lib/wallet-picker.js';
import { buildGetWalletHtml, SEED_NOTE, STILL_MISSING, NO_WALLET_LINE } from '../lib/wallet-onboarding.js';
import { mountPairingPanel } from '../lib/walletconnect-view.js';
import { PHONE_SOURCE } from '../lib/wallet-sources.js';
import { escapeHtml } from '../lib/html-escape.js';

const CSS = readRepo('styles.css', import.meta.url);
const RULES = parseRules(CSS);
const msg = (e) => e.join('\n');
const find = (sel, prop) => { let v; for (const r of RULES) if (!r.media && r.selectors.includes(sel) && prop in r.decls) v = r.decls[prop]; return v; };

// ── section 2.2: the dark column, exactly ──
const TOKENS = {
    '--accent-violet': 'var(--violet)',
    '--accent-violet-text': '#A48FE4',
    '--accent-violet-tint': 'rgba(103, 69, 210, 0.18)',
    '--accent-violet-line': 'rgba(103, 69, 210, 0.55)',
    '--accent-green': 'var(--success)',
    '--accent-green-tint': 'rgba(20, 241, 149, 0.12)',
    '--accent-green-line': 'rgba(20, 241, 149, 0.35)',
    '--accent-green-wash': 'rgba(20, 241, 149, 0.06)',
    '--accent-amber': '#FFA500',
    '--accent-amber-tint': 'rgba(255, 165, 0, 0.12)',
    '--accent-amber-line': 'rgba(255, 165, 0, 0.35)',
    '--accent-amber-wash': 'rgba(255, 165, 0, 0.06)',
    '--accent-blue': '#148FE8',
    '--accent-blue-text': '#4FABEE',
    '--accent-blue-tint': 'rgba(20, 143, 232, 0.16)',
    '--accent-blue-line': 'rgba(20, 143, 232, 0.45)',
    '--accent-blue-wash': 'rgba(20, 143, 232, 0.06)',
    '--accent-red': 'var(--error)',
    '--accent-red-tint': 'rgba(255, 77, 77, 0.12)',
    '--accent-red-line': 'rgba(255, 77, 77, 0.35)',
    '--accent-red-wash': 'rgba(255, 77, 77, 0.08)',
    '--accent-pink-tint': 'rgba(230, 0, 122, 0.12)',
    '--accent-pink-line': 'rgba(230, 0, 122, 0.40)',
    '--warning': 'var(--accent-amber)'
};
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
function checkTokens(css) {
    const { props, counts } = rootProps(css), err = [];
    for (const [name, want] of Object.entries(TOKENS)) {
        if (counts[name] !== 1) { err.push(`:root declares ${name} ${counts[name] || 0} times, wanted 1`); continue; }
        if (!same(props[name], want)) err.push(`:root ${name} is "${props[name]}", the spec (2.2) says "${want}"`);
    }
    return err;
}

// ── colour maths (WCAG 2.1), alpha composited on the surface ──
const SURFACE = [0x12, 0x12, 0x1A];
function parseColour(v, props) {
    v = String(v).trim();
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    if (ref) return parseColour(props[ref[1]], props);
    let m = /^#([0-9a-f]{6})$/i.exec(v);
    if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
    m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/.exec(v);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    throw new Error('cannot read colour ' + v);
}
const over = (fg, bg) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3]));
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// ── what counts as a kit hue (R6): the six kit colours, the two lighter text tints, surfaces, text greys, any grey ──
const KIT = new Set(['230,0,122', '103,69,210', '20,241,149', '0,230,118', '255,165,0', '20,143,232', '255,77,77', '164,143,228', '79,171,238', '18,18,26', '8,8,12', '20,20,30', '156,163,175', '107,114,128']);
const CHOOSER = /(^|[^\w-])(ui-|wallet-(option|account|ext|get|onboarding|picker|group)|wc-|wp-|validate-)/;
function hueOffenders(css) {
    const out = [];
    const check = (where, value) => {
        for (const h of value.matchAll(/#([0-9a-fA-F]{3,8})\b|rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
            let rgb;
            if (h[1]) {
                const x = h[1].length === 3 ? h[1].split('').map(c => c + c).join('') : h[1].slice(0, 6);
                rgb = [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
            } else rgb = [Number(h[2]), Number(h[3]), Number(h[4])];
            if (rgb[0] === rgb[1] && rgb[1] === rgb[2]) continue;
            if (!KIT.has(rgb.join(','))) out.push(`${where} uses ${h[0]}, which is not a kit colour or a 2.2 value`);
        }
    };
    for (const r of parseRules(css)) {
        if (!r.selectors.some(s => CHOOSER.test(s))) continue;
        for (const [p, v] of Object.entries(r.decls)) check(`styles.css:${r.line} "${r.selectors.join(', ')}" { ${p} }`, v);
    }
    for (const [n, v] of Object.entries(rootProps(css).props)) check(`:root ${n}`, v);
    return out;
}

// ── actions: the last compound of a selector names a button, a link, a pill or a row ──
const lastCompound = (s) => s.split(/[\s>+~]+/).pop();
const ACTION_LAST = /(btn|button|-action\b|-link\b|-retry|-check\b|-cancel|-reload|-open\b|-install|-cta|-back\b|^a(?=$|[:.[])|-row\b|:hover|:focus)/;
const ACCENT_FILL = /var\(--accent-(green|amber|blue|red)[\w-]*\)|var\(--(success|error|warning|brand-secondary)\)|#14f195|#00e676|#ffa500|#148fe8|#ff4d4d/i;
function actionAccentOffenders(css) {
    const out = [];
    for (const r of parseRules(css)) for (const s of r.selectors) {
        const last = lastCompound(s);
        if (!ACTION_LAST.test(last) || /\.ui-|\.wallet-account-badge/.test(last)) continue;
        for (const p of ['background', 'background-color', 'background-image']) {
            if (r.decls[p] && ACCENT_FILL.test(r.decls[p])) out.push(`styles.css:${r.line} "${s}" { ${p}: ${r.decls[p]} } is an accent fill on an action`);
        }
    }
    return out;
}
// Raw violet and raw blue are never a text colour (2.98:1 and 4.48:1 on their tints).
function rawTextOffenders(css) {
    const out = [];
    for (const r of parseRules(css)) for (const s of r.selectors) {
        const v = r.decls.color;
        if (v && /var\(--(violet|accent-violet|accent-blue)\)|#6745d2|#148fe8/i.test(v)) out.push(`styles.css:${r.line} "${s}" { color: ${v} } is raw violet or raw blue as text (use the -text token)`);
    }
    return out;
}
// No tint or wash token on a row, a card or a path card (R1). The Current row keeps the violet wash of Revision 3.
const ROWISH = /^(\.wallet-option|\.wallet-option-row|\.wallet-account-btn|\.wallet-account-row|\.list-container|\.validate-tile|\.validate-path-card)(?![\w-])/;
const TINT = /var\(--accent-[\w]+-(tint|wash)\)|rgba\((230, 0, 122|103, 69, 210|20, 241, 149|255, 165, 0|20, 143, 232|255, 77, 77),/;
function rowFillOffenders(css) {
    const out = [];
    for (const r of parseRules(css)) for (const s of r.selectors) {
        const last = lastCompound(s);
        if (!ROWISH.test(last) || /is-current|is-readonly/.test(s)) continue;
        for (const p of ['background', 'background-color', 'background-image']) if (r.decls[p] && TINT.test(r.decls[p])) out.push(`styles.css:${r.line} "${s}" { ${p}: ${r.decls[p]} } tints a row or a card`);
    }
    return out;
}

describe('2.2 the tokens', () => {
    test('1: every token of the dark column is declared once in :root with the spec value', () => {
        assert.deepEqual(checkTokens(CSS), [], msg(checkTokens(CSS)));
    });
    test('1b: --warning is the kit amber, and the four rules that read it no longer carry an off-kit fallback', () => {
        const { props } = rootProps(CSS);
        assert.equal(props['--warning'], 'var(--accent-amber)');
        assert.equal(props['--accent-amber'].toUpperCase(), '#FFA500');
        assert.ok(!/var\(--warning,/.test(CSS), 'no rule reads --warning with a fallback colour (it resolves to the kit amber)');
        assert.ok((CSS.match(/var\(--warning\)/g) || []).length >= 4, 'the four rules that read it still do');
    });
    test('1c: the light column is not shipped (the explorer is dark only)', () => {
        const { body } = rootProps(CSS);
        for (const light of ['#087446', '#8C5B00', '#0F6BAE', '#BF3A3A']) assert.ok(!body.toUpperCase().includes(light), light + ' is a light-theme value');
        assert.ok(!/data-theme/.test(CSS) && !/prefers-color-scheme:\s*light/.test(CSS));
    });
    test('2: hue guard, no colour outside the kit in the ui-*, chooser and validate rules or in :root', () => {
        assert.deepEqual(hueOffenders(CSS), [], msg(hueOffenders(CSS)));
    });
    test('3: no accent fill on an action; raw violet and raw blue are never text', () => {
        assert.deepEqual(actionAccentOffenders(CSS), [], msg(actionAccentOffenders(CSS)));
        assert.deepEqual(rawTextOffenders(CSS), [], msg(rawTextOffenders(CSS)));
    });
    test('4: no tint or wash on a row, a card or a path card', () => {
        assert.deepEqual(rowFillOffenders(CSS), [], msg(rowFillOffenders(CSS)));
    });
    test('5: contrast, recomputed. Text tokens 4.5 on #12121A and on their own tint; glyph tokens 3.0; white on solid parts', () => {
        const { props } = rootProps(CSS), err = [];
        const col = (n) => parseColour(`var(${n})`, props);
        const pairs = [['violet-text', 'violet-tint'], ['green', 'green-tint'], ['amber', 'amber-tint'], ['blue-text', 'blue-tint'], ['red', 'red-tint']];
        for (const [t, tint] of pairs) {
            const fg = col('--accent-' + t), bg = over(col('--accent-' + tint), SURFACE);
            const onSurface = ratio(fg.slice(0, 3), SURFACE), onTint = ratio(fg.slice(0, 3), bg);
            if (onSurface < 4.5) err.push(`--accent-${t} on #12121A is ${onSurface.toFixed(2)}, needs 4.5`);
            if (onTint < 4.5) err.push(`--accent-${t} on --accent-${tint} is ${onTint.toFixed(2)}, needs 4.5`);
        }
        if (ratio(col('--accent-blue').slice(0, 3), SURFACE) < 3) err.push('--accent-blue edges are under 3.0');
        if (ratio(col('--brand-primary').slice(0, 3), SURFACE) < 3) err.push('--brand-primary glyph is under 3.0');
        if (ratio([255, 255, 255], col('--accent-violet').slice(0, 3)) < 6) err.push('white on the solid violet step marker is under 6.0');
        if (ratio([255, 255, 255], col('--brand-primary').slice(0, 3)) < 4.5) err.push('white on pink is under 4.5');
        // The spec's own figures (2.3), to one decimal: the guard measures what the spec measured.
        assert.equal(ratio(col('--accent-violet-text').slice(0, 3), SURFACE).toFixed(1), '6.8');
        assert.equal(ratio(col('--accent-amber').slice(0, 3), SURFACE).toFixed(1), '9.4');
        assert.deepEqual(err, [], msg(err));
    });
});

describe('2.4 the shared ui-* parts', () => {
    test('6: chip, 24 px, 0.82rem 600, one variant per role; each takes the role tint and the role text token', () => {
        for (const [p, v] of [['height', '24px'], ['padding', '0 8px'], ['border-radius', 'var(--radius-sm)'], ['font-size', '0.82rem'], ['font-weight', '600'], ['gap', '4px']]) assert.equal(find('.ui-chip', p), v, '.ui-chip ' + p);
        const want = { 'is-positive': ['green', 'green'], 'is-wait': ['amber', 'amber'], 'is-info': ['blue', 'blue-text'], 'is-step': ['violet', 'violet-text'], 'is-error': ['red', 'red'] };
        for (const [c, [tint, text]] of Object.entries(want)) {
            assert.equal(find(`.ui-chip.${c}`, 'background'), `var(--accent-${tint}-tint)`, c + ' background');
            assert.equal(find(`.ui-chip.${c}`, 'color'), `var(--accent-${text})`, c + ' text');
        }
        assert.equal(find('.ui-chip.is-neutral', 'background'), 'rgba(255, 255, 255, 0.06)');
        assert.equal(find('.ui-chip.is-neutral', 'color'), 'var(--text-primary)');
        assert.equal(find('.ui-chip.is-step', 'border'), '1px solid var(--accent-violet-line)', 'the step chip is a violet outline');
    });
    test('7: tile, 36 default, 28 and 48, radius 8 (12 at 48), one variant per role, brand is the gradient', () => {
        assert.equal(find('.ui-tile', 'width'), '36px'); assert.equal(find('.ui-tile', 'height'), '36px');
        assert.equal(find('.ui-tile', 'border-radius'), '8px');
        assert.equal(find('.ui-tile.is-sm', 'width'), '28px'); assert.equal(find('.ui-tile.is-lg', 'width'), '48px');
        assert.equal(find('.ui-tile.is-lg', 'border-radius'), '12px');
        const want = { 'is-violet': ['violet', 'violet-text'], 'is-green': ['green', 'green'], 'is-amber': ['amber', 'amber'], 'is-blue': ['blue', 'blue-text'] };
        for (const [c, [tint, text]] of Object.entries(want)) {
            assert.equal(find(`.ui-tile.${c}`, 'background'), `var(--accent-${tint}-tint)`, c);
            assert.equal(find(`.ui-tile.${c}`, 'border-color'), `var(--accent-${tint}-line)`, c);
            assert.equal(find(`.ui-tile.${c}`, 'color'), `var(--accent-${text})`, c);
        }
        assert.equal(find('.ui-tile.is-pink', 'background'), 'var(--accent-pink-tint)');
        assert.equal(find('.ui-tile.is-pink', 'border-color'), 'var(--accent-pink-line)');
        assert.equal(find('.ui-tile.is-brand', 'background'), 'var(--brand-gradient)');
        assert.equal(find('.ui-tile.is-neutral', 'background'), 'rgba(255, 255, 255, 0.08)');
    });
    test('8: step marker, 28 px circle; later, open, current (solid violet, tint ring), done (green)', () => {
        assert.equal(find('.ui-step', 'width'), '28px'); assert.equal(find('.ui-step', 'border-radius'), '50%');
        assert.equal(find('.ui-step', 'font-weight'), '700');
        assert.equal(find('.ui-step.is-later', 'border-color'), 'rgba(255, 255, 255, 0.16)');
        assert.equal(find('.ui-step.is-open', 'border-color'), 'var(--accent-violet-line)');
        assert.equal(find('.ui-step.is-open', 'color'), 'var(--accent-violet-text)');
        assert.equal(find('.ui-step.is-current', 'background'), 'var(--accent-violet)');
        assert.equal(find('.ui-step.is-current', 'box-shadow'), '0 0 0 3px var(--accent-violet-tint)');
        assert.equal(find('.ui-step.is-done', 'background'), 'var(--accent-green-tint)');
        assert.equal(find('.ui-step.is-done', 'color'), 'var(--accent-green)');
    });
    test('9: panel, wash over the surface, 1 px role line, 3 px inset role edge; .is-line drops border, wash and edge', () => {
        assert.equal(find('.ui-panel', 'padding'), '12px 16px');
        assert.equal(find('.ui-panel', 'border-radius'), 'var(--radius-sm)');
        for (const [c, role] of [['is-warn', 'amber'], ['is-info', 'blue'], ['is-error', 'red'], ['is-ok', 'green']]) {
            assert.match(find(`.ui-panel.${c}`, 'background'), new RegExp(`--accent-${role}-wash.*var\\(--bg-surface\\)`), c + ' wash over the surface');
            assert.equal(find(`.ui-panel.${c}`, 'border-color'), `var(--accent-${role}-line)`, c);
            assert.equal(find(`.ui-panel.${c}`, 'box-shadow'), `inset 3px 0 0 var(--accent-${role})`, c);
        }
        for (const p of ['border', 'background', 'box-shadow']) assert.ok(['0', 'none'].includes(find('.ui-panel.is-line', p)), '.is-line ' + p);
        const at = (s) => RULES.findIndex(r => r.selectors.includes(s));
        assert.ok(at('.ui-panel.is-warn') >= 0 && at('.ui-panel.is-warn') < at('.ui-panel.is-line'), '.is-line comes after the variants so it wins at equal specificity');
    });
    test('10: dot, trust row, hairline, primary', () => {
        assert.equal(find('.ui-dot', 'width'), '8px'); assert.equal(find('.ui-dot', 'border-radius'), '50%');
        for (const [c, role] of [['is-green', 'green'], ['is-amber', 'amber'], ['is-red', 'red'], ['is-blue', 'blue']]) assert.equal(find(`.ui-dot.${c}`, 'background'), `var(--accent-${role})`, c);
        assert.equal(find('.ui-trust', 'display'), 'flex'); assert.equal(find('.ui-trust', 'gap'), '12px');
        assert.equal(find('.ui-hairline::before', 'height'), '2px');
        assert.equal(find('.ui-hairline::before', 'background'), 'var(--brand-gradient)');
        assert.equal(find('.ui-hairline', 'position'), 'relative'); assert.equal(find('.ui-hairline', 'overflow'), 'hidden');
        assert.equal(find('.validate-primary', 'background'), 'var(--brand-gradient)');
        assert.equal(find('.validate-primary:hover', 'box-shadow'), '0 0 0 3px var(--brand-primary-glow)');
        assert.equal(find('.validate-primary:disabled', 'opacity'), '0.45');
    });
    test('11: forced colours, chips, tiles, step markers and panels fall back to the system palette', () => {
        const hit = RULES.filter(r => /forced-colors/.test(r.media) && ['.ui-chip', '.ui-tile', '.ui-step', '.ui-panel'].every(s => r.selectors.includes(s)));
        assert.equal(hit.length, 1, 'one forced-colors rule names all four parts');
        assert.equal(hit[0].decls.border, '1px solid CanvasText'); assert.equal(hit[0].decls.background, 'Canvas');
        const cur = RULES.filter(r => /forced-colors/.test(r.media) && r.selectors.includes('.ui-step.is-current'));
        assert.ok(cur.length === 1 && /Highlight/.test(cur[0].decls.background), 'the current step uses Highlight');
    });
});

// ── rendered wallet page states ──
const KINDS = ['ext', 'phone', 'get', 'apps', 'multisig', 'watch', 'quiet'];
const talisman = (n = 3) => fakeWallet('talisman', [acct(10, 'Main account'), acct(12, 'Staking'), acct(13, 'Savings')].slice(0, n));
const polkadot = () => fakeWallet('polkadot-js', [acct(11, 'Polkadot.js account')]);
// primary: how many primaries (a lead row, a solo account, Reload page, Open wallet) the spec table gives the state.
const SCENES = {
    'none-installed': { primary: 1, build: async (t) => mountChooser(t, { phone: true }) },
    'two-ext-and-phone': { primary: 0, build: async (t) => mountChooser(t, { wallets: [polkadot(), talisman()], phone: true }) },
    'ext-shared-accounts': { primary: 0, build: async (t) => { const w = mountChooser(t, { wallets: [polkadot(), talisman()] }); await w.picker.ready; w.row('talisman').click(); await w.settle(); w.q('#wallet-picker-back').click(); await w.settle(); return w; } },
    'waiting': { primary: 0, hold: true, build: async (t) => { const w = mountChooser(t, { wallets: [Object.assign(talisman(), { hold: true }), polkadot()] }); await w.picker.ready; w.row('talisman').click(); await new Promise(r => setTimeout(r, 20)); return w; } },
    'problem': { primary: 0, build: async (t) => { const w = mountChooser(t, { wallets: [Object.assign(polkadot(), { reject: true }), talisman()] }); await w.picker.ready; w.row('polkadot-js').click(); await w.settle(); return w; } },
    'switch-current': { primary: 0, build: async (t) => mountChooser(t, { wallets: [talisman(), polkadot()], current: addr(10, 42), currentSource: 'talisman', lastSource: 'talisman' }) },
    'accounts-five': { primary: 0, build: async (t) => { const w = mountChooser(t, { wallets: [fakeWallet('talisman', [10, 12, 13, 15, 16].map(n => acct(n, 'Account ' + n)))] }); await w.picker.ready; w.row('talisman').click(); await w.settle(); return w; } },
    'get': { primary: 0, build: async (t) => { const w = mountChooser(t, {}); await w.picker.ready; w.action('get').click(); await w.settle(); return w; } },
    'get-retried': { primary: 1, build: async (t) => { const w = mountChooser(t, {}); await w.picker.ready; w.action('get').click(); await w.settle(); w.q('.wallet-get-check').click(); await w.settle(); return w; } },
    'mobile-apps': { primary: 1, build: async (t) => mountChooser(t, { onMobile: true, phone: true }) }
};
const primaries = (w) => w.qa('.wallet-picker .is-primary, .wallet-onboarding-reload, .wc-open').filter(w.visible);
// A held wallet never answers, so the waiting scene is not settled (and its wallet is released at the end).
async function scene(t, name) { const w = await SCENES[name].build(t); await w.picker.ready; if (!SCENES[name].hold) await w.settle(); else t.after(() => w.wallets.forEach(x => x.release())); return w; }

describe('6.1 row types on the wallet page', () => {
    for (const name of Object.keys(SCENES)) {
        test(`12: ${name}: never more than one primary, and as many as the spec table says`, async (t) => {
            const w = await scene(t, name);
            assert.ok(primaries(w).length <= 1, 'more than one primary');
            assert.equal(primaries(w).length, SCENES[name].primary, `${name} shows ${primaries(w).length} primaries: ${primaries(w).map(e => e.className).join(' | ')}`);
        });
    }
    test('13: every rendered option row has a data-kind, and its tile carries the same one (one accent per row)', async (t) => {
        const err = [];
        for (const name of Object.keys(SCENES)) {
            const w = await scene(t, name);
            for (const row of w.qa('.wallet-option-row')) {
                const k = row.getAttribute('data-kind');
                if (!KINDS.includes(k)) { err.push(`${name}: a row has data-kind "${k}"`); continue; }
                const tile = row.querySelector('.wallet-ext-tile');
                if (!tile || tile.getAttribute('data-kind') !== k) err.push(`${name}: row "${row.textContent.trim().slice(0, 24)}" is ${k} but its tile is ${tile && tile.getAttribute('data-kind')}`);
            }
        }
        assert.deepEqual(err, [], msg(err));
    });
    test('14: the kinds are the spec ones: extension, phone, get (lead and quiet), apps on a phone, quiet', async (t) => {
        const a = await scene(t, 'two-ext-and-phone');
        assert.equal(a.row('talisman').getAttribute('data-kind'), 'ext');
        assert.equal(a.action('phone').getAttribute('data-kind'), 'phone');
        assert.equal(a.action('get').getAttribute('data-kind'), 'get', 'the quiet Get a wallet row is get');
        const b = await scene(t, 'none-installed');
        assert.equal(b.action('get').getAttribute('data-kind'), 'get', 'the lead Get a wallet row is get');
        const c = await scene(t, 'mobile-apps');
        assert.equal(c.action('apps').getAttribute('data-kind'), 'apps');
        const d = await scene(t, 'switch-current');
        assert.equal(d.q('#wallet-picker-different').getAttribute('data-kind'), 'quiet');
        assert.match(DIFFERENT_WALLET_HTML, /<span class="wallet-ext-tile is-lg tile-icon" data-kind="quiet"/);
    });
    test('15: the CSS gives each kind its edge, tile, glyph and pill border (6.1), once', () => {
        const row = (k) => `.wallet-option-row[data-kind="${k}"]`, tile = (k) => `.wallet-ext-tile[data-kind="${k}"]`;
        const edges = { ext: 'var(--accent-violet)', phone: 'var(--brand-primary)', get: 'var(--accent-blue)', apps: 'var(--accent-blue)', quiet: 'transparent' };
        for (const [k, v] of Object.entries(edges)) assert.equal(find(row(k), '--row-edge'), v, `${k} edge`);
        assert.equal(find(row('multisig'), '--row-edge'), undefined, 'multisig rows have no edge');
        assert.equal(find(row('watch'), '--row-edge'), undefined, 'the read-only row has no edge');
        const tints = { ext: ['violet', 'violet-text'], get: ['blue', 'blue-text'], apps: ['blue', 'blue-text'], multisig: ['violet', 'violet-text'], watch: ['amber', 'amber'] };
        for (const [k, [tint, text]] of Object.entries(tints)) {
            assert.equal(find(tile(k), 'background'), `var(--accent-${tint}-tint)`, `${k} tile fill`);
            assert.equal(find(tile(k), 'border-color'), `var(--accent-${tint}-line)`, `${k} tile border`);
            assert.equal(find(tile(k), 'color'), `var(--accent-${text})`, `${k} glyph`);
        }
        assert.equal(find(tile('phone'), 'background'), 'var(--accent-pink-tint)');
        assert.equal(find(tile('phone'), 'border-color'), 'var(--accent-pink-line)');
        assert.equal(find('.wallet-ext-tile.is-lg[data-kind="phone"]', 'color'), 'var(--brand-primary)', 'a pink glyph only at 20 px or more');
        assert.equal(find(tile('quiet'), 'background'), 'rgba(255, 255, 255, 0.08)');
        assert.equal(find(tile('quiet'), 'color'), 'var(--accent-violet-text)');
        assert.equal(find(`${row('ext')} .wallet-option-action:not(.is-count)`, 'border-color'), 'var(--accent-violet-line)');
        assert.equal(find(`${row('phone')} .wallet-option-action:not(.is-count)`, 'border-color'), 'var(--accent-pink-line)');
        // Waiting is amber, the Current badge is green, a problem icon is amber, the spinner is amber.
        assert.equal(find('.wallet-option.is-waiting .wallet-option-row', 'border-color'), 'var(--accent-amber-line)');
        assert.equal(find('.wallet-option-spin', 'color'), 'var(--accent-amber)');
        assert.equal(find('.wallet-option-problem .bx-error', 'color'), 'var(--accent-amber)');
        assert.equal(find('.wallet-account-badge', 'color'), 'var(--accent-green)');
        assert.equal(find('.wallet-account-badge', 'border'), '1px solid var(--accent-green-line)');
    });
    test('16: option rows keep neutral fills by position; edges come from the kind, only account lists alternate pink and violet (R7)', () => {
        assert.equal(find('.wallet-option-list > .wallet-option:nth-child(odd)', '--row-fill'), 'rgba(255, 255, 255, 0.03)');
        assert.equal(find('.wallet-option-list > .wallet-option:nth-child(even)', '--row-fill'), 'rgba(255, 255, 255, 0.06)');
        assert.equal(find('.wallet-option-list > .wallet-option:nth-child(odd)', '--row-edge'), undefined, 'no positional edge on option rows');
        assert.equal(find('.wallet-option-list > .wallet-option:nth-child(even)', '--row-edge'), undefined);
        assert.equal(find('#wallet-accounts .wallet-account-list > li:nth-child(odd)', '--row-edge'), 'var(--brand-primary)');
        assert.equal(find('#wallet-accounts .wallet-account-list > li:nth-child(even)', '--row-edge'), 'var(--violet)');
    });
});

describe('6.2 page furniture and colour is never the only signal', () => {
    test('17: header tile and hairline; the Connected chip only in the switch view; the shield trust row', async (t) => {
        const c = await scene(t, 'two-ext-and-phone');
        assert.ok(c.q('section.wallet-picker.ui-hairline'), 'hairline');
        const tile = c.q('.wallet-picker-head .ui-tile.is-brand');
        assert.ok(tile && tile.querySelector('.bx-wallet'), 'the gradient wallet tile in the header');
        assert.equal(c.q('.wallet-picker-head .ui-chip'), null, 'no Connected chip when nothing is connected');
        const s = await scene(t, 'switch-current');
        const chip = s.q('.wallet-picker-head .ui-chip.is-positive');
        assert.ok(chip && /Connected/.test(chip.textContent) && chip.querySelector('.bx-check'));
        for (const w of [c, s]) {
            const f = w.q('#wallet-picker-footnote');
            assert.ok(f.classList.contains('ui-trust'), 'trust row');
            assert.ok(f.querySelector('.ui-tile.is-green.is-sm .bx-shield-quarter'));
            assert.equal(f.textContent.replace(/\s+/g, ' ').trim(), SAFETY_LINE, 'the safety line, verbatim');
        }
    });
    test('18: the empty sub line keeps its text and gains the blue info icon', async (t) => {
        const w = await scene(t, 'none-installed');
        const sub = w.q('#wallet-picker-sub');
        assert.equal(sub.textContent.trim(), NO_WALLET_LINE);
        assert.ok(sub.querySelector('.bx-info-circle'));
    });
    test('19: More options: a violet marker; View any address has an amber tile and a Read only chip with an icon', async (t) => {
        const w = await scene(t, 'two-ext-and-phone');
        const view = w.q('#wallet-picker-view');
        assert.equal(view.getAttribute('data-kind'), 'watch');
        const sum = view.querySelector('summary');
        assert.ok(sum.querySelector('.ui-tile.is-amber .bx-show'), 'amber show tile');
        const chip = view.parentElement.querySelector(':scope > .ui-chip.is-wait');   // beside the summary, so its text stays exactly 'View any address'
        assert.ok(chip && chip.textContent.trim() === 'Read only' && chip.querySelector('.bx'), 'Read only chip');
        assert.equal(sum.textContent.trim(), 'View any address');
        assert.equal(find('.wallet-picker-disclosure > summary::before', 'color'), 'var(--accent-violet-text)');
    });
    test('20: a wallet that shared accounts shows a green chip with a check and the count word; a paired phone shows a green dot and "connected"', async (t) => {
        const w = await scene(t, 'ext-shared-accounts');
        const chip = w.row('talisman').querySelector('.ui-chip.is-positive.is-count');
        assert.ok(chip && chip.querySelector('.bx-check') && chip.textContent.trim() === '3 accounts', 'chip: ' + (chip && chip.outerHTML));
        const html = buildOptionRowsHtml({ sources: [], phone: { connected: true, peer: 'Nova Wallet', count: 2 }, esc: escapeHtml });
        const d = new Window().document; d.body.innerHTML = `<ul>${html}</ul>`;
        const sub = d.querySelector('[data-action="phone"] .wallet-option-sub');
        assert.ok(sub.querySelector('.ui-dot.is-green'), 'green dot');
        assert.match(sub.textContent, /Nova Wallet connected/);
        assert.ok(d.querySelector('[data-action="phone"] .ui-chip.is-positive.is-count'));
    });
    test('21: waiting has a spinner and a sentence; a problem has an amber icon, the unchanged sentence and Try again', async (t) => {
        const w = await scene(t, 'waiting');
        const li = w.q('li.wallet-option.is-waiting');
        assert.ok(li.querySelector('.wallet-option-spin') && /Approve the request in Talisman/.test(li.textContent));
        const p = await scene(t, 'problem');
        const prob = p.q('.wallet-option-problem');
        assert.ok(prob.querySelector('.bx-error'), 'amber triangle icon');
        assert.match(prob.textContent, /Polkadot.js did not allow this site/);
        assert.ok(prob.querySelector('.wallet-option-retry'));
    });
    test('22: the Current row has a green badge with a check and the word; group heads take their kind; the read-only group has the amber tile and the chip', () => {
        const html = buildAccountListHtml({ accounts: [{ address: addr(10, 42), name: 'Main', source: 'talisman' }, { address: addr(11, 42), name: 'Read', source: '' }], current: addr(10, 42), currentSource: 'talisman', isSame: (a, b) => a === b, esc: escapeHtml, shortAddr: (a) => a.slice(0, 6) });
        const d = new Window().document; d.body.innerHTML = html;
        const badge = d.querySelector('.wallet-account-badge');
        assert.ok(badge.classList.contains('ui-chip') && badge.classList.contains('is-positive') && badge.querySelector('.bx-check') && badge.textContent.trim() === 'Current');
        const heads = Array.from(d.querySelectorAll('.wallet-group-head'));
        assert.equal(heads[0].querySelector('.wallet-ext-tile').getAttribute('data-kind'), 'ext', 'extension group head is violet');
        const ro = heads.find(h => h.querySelector('.wallet-ext-tile[data-kind="watch"]'));
        assert.ok(ro && ro.querySelector('.ui-chip.is-wait') && /Read only/.test(ro.textContent), 'read-only group: amber tile and chip');
        assert.ok(tileHtml(PHONE_SOURCE, escapeHtml).includes('data-kind="phone"'));
        assert.ok(tileHtml('', escapeHtml).includes('data-kind="watch"'));
        assert.ok(tileHtml('multisig', escapeHtml).includes('data-kind="multisig"'));
    });
    test('23: Get a wallet: install rows are all extension rows with an Install pill that carries the link icon; the notes use panels and the blue guide icon', async (t) => {
        const w = await scene(t, 'get');
        const rows = w.qa('#wallet-picker-get .wallet-option-row');
        assert.equal(rows.length, 3);
        for (const r of rows) {
            assert.equal(r.getAttribute('data-kind'), 'ext');
            const pill = r.querySelector('.wallet-option-action');
            assert.ok(pill.querySelector('.bx-link-external') && pill.textContent.trim() === 'Install');
        }
        const seed = w.q('#wallet-picker-get .ui-panel.is-warn.is-line');
        assert.ok(seed && seed.textContent.trim() === SEED_NOTE && seed.querySelector('.bx-error'));
        assert.ok(w.q('#wallet-picker-get a.wallet-get-guide .bx-book-open'), 'guide icon');
        const r = await scene(t, 'get-retried');
        const still = r.q('#wallet-picker-get .wallet-onboarding-note');
        assert.ok(still.classList.contains('ui-panel') && still.classList.contains('is-warn') && still.classList.contains('is-line') && still.textContent.trim() === STILL_MISSING);
        assert.ok(r.q('.wallet-onboarding-reload'), 'Reload page stays the one primary');
        assert.ok(buildGetWalletHtml({ onMobile: true }).includes('ui-panel is-warn is-line'), 'the phone view has the seed note panel too');
    });
    test('24: pairing: violet step markers, an amber dot with the word while waiting, and the dot survives a status change', () => {
        const d = new Window().document; const el = d.createElement('div'); d.body.appendChild(el);
        const p = mountPairingPanel(el, { uri: 'wc:abc@2?relay-protocol=irn&symKey=00', onMobile: false, clipboard: {}, onCancel() {} });
        const st = el.querySelector('.wc-status');
        assert.ok(st.querySelector('.ui-dot.is-amber'));
        assert.match(st.textContent, /Waiting for your phone/);
        p.setStatus('Approve on your phone...');
        assert.match(el.querySelector('.wc-status').textContent, /Approve on your phone/);
        assert.ok(el.querySelector('.wc-status .ui-dot'));
        assert.equal(find('.wc-steps li::marker', 'color'), 'var(--accent-violet-text)');
    });
    test('25: every chip and panel on every scene has an icon and a word, every dot sits beside a word, every icon is aria-hidden', async (t) => {
        const err = [];
        for (const name of Object.keys(SCENES)) {
            const w = await scene(t, name);
            for (const c of w.qa('.ui-chip')) { if (!c.querySelector('.bx')) err.push(`${name}: chip "${c.textContent.trim()}" has no icon`); if (!c.textContent.trim()) err.push(`${name}: a chip has no word`); }
            for (const c of w.qa('.ui-panel')) { if (!c.querySelector('.bx')) err.push(`${name}: a panel has no icon`); if (!c.textContent.trim()) err.push(`${name}: a panel has no text`); }
            for (const d of w.qa('.ui-dot')) if (!d.parentElement.textContent.trim()) err.push(`${name}: a dot has no word beside it`);
            for (const i of w.qa('.ui-chip .bx, .ui-tile .bx, .ui-panel .bx')) if (!i.closest('[aria-hidden="true"]')) err.push(`${name}: an icon is not aria-hidden`);
        }
        assert.deepEqual(err, [], msg(err));
    });
});

describe('the guards fail on broken copies, and the message names the selector', () => {
    test('26: a restored violet row fill, an accent on an action, raw violet as text, an off-kit hue and a changed token', () => {
        const a = rowFillOffenders(CSS + '\n.wallet-option-row { background: rgba(103, 69, 210, 0.14); }\n');
        assert.ok(a.some(m => m.includes('".wallet-option-row"') && m.includes('rgba(103, 69, 210, 0.14)')), msg(a));
        const b = actionAccentOffenders(CSS + '\n.wallet-option-action { background: var(--accent-green); }\n');
        assert.ok(b.some(m => m.includes('".wallet-option-action"') && m.includes('--accent-green')), msg(b));
        const c = rawTextOffenders(CSS + '\n.ui-chip.is-step { color: var(--violet); }\n');
        assert.ok(c.some(m => m.includes('".ui-chip.is-step"') && m.includes('raw violet')), msg(c));
        const d = hueOffenders(CSS + '\n.ui-chip.is-x { color: #7B2FF7; }\n');
        assert.ok(d.some(m => m.includes('.ui-chip.is-x') && m.includes('#7B2FF7')), msg(d));
        const e = checkTokens(CSS.replace('--accent-amber: #FFA500;', '--accent-amber: #FFB000;'));
        assert.ok(e.some(m => m.includes('--accent-amber') && m.includes('#FFB000')), msg(e));
        assert.deepEqual([...checkTokens(CSS), ...hueOffenders(CSS), ...actionAccentOffenders(CSS), ...rawTextOffenders(CSS), ...rowFillOffenders(CSS)], []);
    });
});
