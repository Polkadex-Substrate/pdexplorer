#!/usr/bin/env node
// Guard: the whole site draws no legacy controls and no colour outside the kit
// (spec cto-team/plans/2026-11-26-sprint11-site-sweep.md, sections 2.6 and 3.2).
//
//   node scripts/check-ui-legacy.mjs          exit 0, or exit 1 with one line per offence
//
// G1 legacy class   .staking-download-btn anywhere (sources and styles.css): it no longer exists.
// G2 inline colour  a colour, background or border written in markup or set from script (the wallet guard's own
//                   detector, lineOffences). While the sweep lands it runs as ceilings per bucket that may only go
//                   down (script.js, index.html, lib/, other files); the named exemptions of 2.5 are not counted.
// G3 hue            a hex colour, rgb(), rgba(), hsl() or a CSS colour name inside a source string, and a hex or rgb
//                   triple in styles.css that is not a kit colour or a neutral. Ceilings while the sweep lands.
// G4 muted text     color: var(--text-muted) in a styles.css rule: only the five selectors of 3.2, each with its
//                   reason. In the sources the inline uses leave with the patterns of section 2: a ceiling for now.
//
// The scan reads every .js, .mjs, .cjs and .html file outside the wallet guard's EXCLUDE list (an exclusion list,
// not an allowlist: a new file is scanned without anyone adding it), and styles.css.
// Run by npm test through test/site-legacy-guard.test.js, which also breaks each rule once on a fixture.

import { fileURLToPath } from 'node:url';
import { lineOffences, functionLines, repoReader, EXCLUDE } from './check-wallet-legacy.mjs';

export { repoReader };
const SCANNED = /\.(m?js|cjs|html)$/;
const CLASS = 'staking-download-btn';
const isComment = (line) => { const t = line.trim(); return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('<!--'); };

// Ceilings: the lines left after WP1 of the sweep, measured. They may only go down; WP2 takes script.js and lib/ to the
// exempt lines only, WP3 takes index.html and styles.css to the plain rule.
// At f33320f: G2 script.js 317, index.html 163, lib/ 35 (not counting the exemptions and the layout-only interpolations);
// G3 script.js 82, index.html 40, lib/ 24, styles.css 73; G4 sources 104. WP1 also took the email alerts modal (row I16).
// WP3 took index.html and styles.css to the plain rule (0) and the source uses of --text-muted to 0. lib/ keeps the 17 lines of
// lib/chart-configs.js and the Legend colour that no work package of sprint 11 owns.
export const G2_CEILING = Object.freeze({ 'script.js': 0, 'index.html': 0, 'lib/': 0, other: 0 });
export const G3_CEILING = Object.freeze({ 'script.js': 0, 'index.html': 0, 'lib/': 17, other: 0, 'styles.css': 0 });
export const G4_SOURCE_CEILING = 0;

// The exemptions of 2.5, by file and function name (never by line number), each with its reason. An entry that
// matches nothing fails the guard: no stale exemptions. guards: which guards the entry lifts.
export const EXEMPT = Object.freeze([
    { file: 'lib/validator-alerts.js', fn: 'frame', guards: ['G2', 'G3'], why: 'Email markup: mail clients need inline styles; it is not a page' },
    { file: 'server.js', guards: ['G2', 'G3'], why: 'Mail server.js sends: mail clients need inline styles; it is not a page' },
    { file: 'script.js', fn: 'renderBrandPage', guards: ['G2', 'G3'], why: 'Brand page swatches and the light logo card: the colour is the content' },
    { file: 'script.js', fn: 'initDonatePage', match: /colorDark|colorLight/, guards: ['G3'], why: 'QR code colours: a QR code is black on white by function' },
    { file: 'lib/walletconnect-view.js', fn: 'drawQr', match: /colorDark|colorLight/, guards: ['G3'], why: 'QR code colours: a QR code is black on white by function' },
    { file: 'lib/help-topics.js', match: /<code>#[0-9A-Fa-f]{6}<\/code>/, guards: ['G3'], why: 'Hex shown as text in help: prose inside code, not a style' },
    { file: 'index.html', match: /<meta name="theme-color"|<link rel="mask-icon"/, guards: ['G3'], why: 'Browser chrome colour (meta theme-color, mask-icon): an attribute that takes a literal colour, not var(); each value is a :root token (--brand-primary, --bg-dark)' }
]);

// The five rules of 3.2 that keep --text-muted, each with its reason.
export const MUTED_KEEP = Object.freeze({
    'select option:disabled, select optgroup:disabled': 'disabled content is outside the contrast rule and must look unavailable',
    '.table-filter-search > i': 'decorative glyph beside a labelled field; 3.85:1 passes the 3:1 for glyphs',
    '.table-pageellipsis': 'decoration between page buttons',
    '.wallet-validator-row i': 'decorative chevron',
    '.wallet-picker-empty-icon': '24 px decorative glyph'
});

// ── styles.css, read as rules (comments blanked so line numbers stay true) ──
export function cssRules(css) {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
    const rules = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(clean))) {
        const head = m[1].trim();
        if (!head || head.startsWith('@')) continue;
        const before = clean.slice(0, m.index);
        const decls = {};
        for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim().replace(/\s+/g, ' '); }
        rules.push({ line: before.split('\n').length + (m[1].match(/^\s*/)[0].split('\n').length - 1), selector: head.replace(/\s+/g, ' '), decls, body: m[2] });
    }
    return rules;
}

// ── hues ──
const HEX = /(^|[^&\w#])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const FUNC = /\b(rgba?|hsla?)\(\s*([^)]*)\)/g;
const NAMES = 'orange|red|white|black|green|blue|yellow|gray|grey|purple|pink|cyan|magenta|gold|silver|navy|teal|lime|maroon|olive|violet|crimson|tomato|coral';
const NAMED = new RegExp(`(?:color|background(?:-color)?|border(?:-[a-z]+)*|fill|stroke|outline(?:-color)?)\\s*:\\s*[^;"'\`]*?\\b(${NAMES})\\b`, 'i');
const NAMED_JS = new RegExp(`\\.style\\.\\w+\\s*=\\s*['"\`](${NAMES})['"\`]`, 'i');
const full = (h) => (h.length <= 4 ? h.slice(0, 3).split('').map(c => c + c).join('') : h.slice(0, 6)).toUpperCase();

// The kit: every hex and rgb triple the :root block defines, plus white and black.
export function kitColours(css) {
    const start = css.indexOf(':root');
    const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
    const hex = new Set(['FFFFFF', '000000']), rgb = new Set(['255,255,255', '0,0,0']);
    for (const m of body.matchAll(HEX)) hex.add(full(m[2]));
    for (const m of body.matchAll(FUNC)) if (/^rgb/.test(m[1])) rgb.add(m[2].split(',').slice(0, 3).map(s => s.trim()).join(','));
    for (const h of hex) rgb.add([0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).join(','));
    return { hex, rgb, rootEnd: css.slice(0, css.indexOf('}', start)).split('\n').length };
}
// A token name is not a hue: "violet" in var(--accent-violet-text) names a kit token.
const untoken = (line) => line.replace(/var\(--[\w-]+/g, 'var(--token');
// A source line's hues: hex, rgb/hsl, or a colour name in a declaration or a style assignment.
export function sourceHues(raw) {
    if (isComment(raw)) return [];
    const line = untoken(raw);
    const out = [];
    for (const m of line.matchAll(HEX)) out.push('#' + m[2]);
    for (const m of line.matchAll(FUNC)) out.push(`${m[1]}(${m[2]})`);
    const n = NAMED.exec(line) || NAMED_JS.exec(line);
    if (n) out.push(n[1]);
    return out;
}
// A styles.css line's hues that are not kit colours or neutrals.
export function cssHues(raw, kit) {
    const line = untoken(raw);
    const out = [];
    for (const m of line.matchAll(HEX)) if (!kit.hex.has(full(m[2]))) out.push('#' + m[2]);
    for (const m of line.matchAll(FUNC)) {
        if (!/^rgb/.test(m[1])) { out.push(`${m[1]}(${m[2]})`); continue; }
        if (!kit.rgb.has(m[2].split(',').slice(0, 3).map(s => s.trim()).join(','))) out.push(`${m[1]}(${m[2]})`);
    }
    const n = /(?:^|[\s;{])(?:color|background(?:-color)?|border(?:-[a-z]+)*|fill|stroke|outline(?:-color)?)\s*:\s*[^;]*?\b(orange|red|green|blue|yellow|gray|grey|purple|pink|cyan|magenta|gold|silver|navy|teal|lime|maroon|olive|violet|crimson|tomato|coral)\b/i.exec(line);
    if (n) out.push(n[1]);
    return out;
}

// G2's detector: the wallet guard's lineOffences, except that a style attribute built from an interpolation passes when
// every declaration has a static property name from the layout list and the interpolation is only in its value.
const LAYOUT = new Set(['width', 'height', 'min-width', 'max-width', 'text-align', 'flex-basis', 'grid-template-columns', 'transform']);
const layoutOnly = (value) => value.split(';').map(d => d.trim()).filter(Boolean).every(d => {
    const i = d.indexOf(':');
    return i > 0 && LAYOUT.has(d.slice(0, i).trim()) && !d.slice(0, i).includes('${');
});
export function inlineColour(line) {
    const offs = lineOffences(line).filter(o => !o.startsWith('.' + CLASS));
    if (!offs.includes('a style attribute built from an interpolation')) return offs;
    const interp = Array.from(line.matchAll(/style\s*=\s*(["'`])([\s\S]*?)\1/g)).map(m => m[2]).filter(v => v.includes('${'));
    if (interp.length && interp.every(layoutOnly)) return offs.filter(o => o !== 'a style attribute built from an interpolation');
    return offs;
}

const bucketOf = (p) => (p === 'script.js' || p === 'index.html' ? p : p.startsWith('lib/') ? 'lib/' : 'other');

// read(path) -> text or null; list() -> every repository path (forward slashes). Returns the report.
export function checkSite({ read, list }, { g2 = G2_CEILING, g3 = G3_CEILING, g4 = G4_SOURCE_CEILING, exempt = EXEMPT, keep = MUTED_KEEP } = {}) {
    const errors = [];
    const g1 = [], g2Lines = [], g3Lines = [], g4Lines = [];
    const used = new Set();
    const files = list().filter(p => SCANNED.test(p) && !EXCLUDE.some(x => x.test(p)));
    const ranges = new Map();   // file -> [{ entry, range }]
    for (const e of exempt) {
        if (!e.why || !String(e.why).trim()) errors.push(`${e.file}${e.fn ? ' ' + e.fn : ''}: exemption without a reason`);
        if (!e.fn) continue;
        const src = read(e.file);
        const r = src == null ? null : functionLines(src, e.fn);
        if (!r) { errors.push(`${e.file}: function ${e.fn} not found for its exemption (renamed? the guard finds it by name)`); continue; }
        if (!ranges.has(e.file)) ranges.set(e.file, []);
        ranges.get(e.file).push({ e, r });
    }
    const exemptFor = (p, n, line, guard) => {
        for (const e of exempt) {
            if (e.file !== p || !(e.guards || []).includes(guard)) continue;
            if (e.fn) { const hit = (ranges.get(p) || []).find(x => x.e === e && n >= x.r[0] && n <= x.r[1]); if (!hit) continue; }
            if (e.match && !e.match.test(line)) continue;
            used.add(e);
            return true;
        }
        return false;
    };
    for (const p of files) {
        const src = read(p);
        if (src == null) continue;
        src.split('\n').forEach((l, i) => {
            const n = i + 1;
            if (isComment(l)) return;
            if (l.includes(CLASS)) g1.push(`${p}:${n}: .${CLASS} no longer exists; pick a tier (.validate-primary, .ui-action, .validate-secondary, .validate-text-btn): ${l.trim().slice(0, 120)}`);
            const offs = inlineColour(l);
            if (offs.length && !exemptFor(p, n, l, 'G2')) g2Lines.push({ p, n, text: `${p}:${n} (${offs[0]})` });
            const hues = sourceHues(l);
            if (hues.length && !exemptFor(p, n, l, 'G3')) g3Lines.push({ p, n, text: `${p}:${n} (${hues[0]})` });
            if (/color\s*:\s*var\(--text-muted\)/.test(l)) g4Lines.push({ p, n });
        });
    }
    const css = read('styles.css');
    const cssG3 = [], cssG4 = [];
    if (css == null) errors.push('styles.css: the file is missing');
    else {
        const kit = kitColours(css);
        css.split('\n').forEach((l, i) => {
            const n = i + 1;
            if (l.includes(CLASS)) g1.push(`styles.css:${n}: .${CLASS} no longer exists; pick a tier: ${l.trim().slice(0, 120)}`);
            if (n <= kit.rootEnd) return;
            const t = l.replace(/\/\*.*?\*\//g, '');
            const h = cssHues(t, kit);
            if (h.length) cssG3.push({ n, text: `styles.css:${n} (${h[0]})` });
        });
        for (const r of cssRules(css)) {
            if (!/var\(--text-muted\)/.test(r.decls.color || '')) continue;
            if (Object.prototype.hasOwnProperty.call(keep, r.selector)) {
                if (!keep[r.selector] || !String(keep[r.selector]).trim()) cssG4.push(`styles.css:${r.line}: ${r.selector}: exemption without a reason`);
                continue;
            }
            cssG4.push(`styles.css:${r.line}: ${r.selector} { color: var(--text-muted) } is text people must read; use --text-secondary (4.5:1 on the surface)`);
        }
        for (const sel of Object.keys(keep)) if (!keep[sel] || !String(keep[sel]).trim()) cssG4.push(`${sel}: exemption without a reason`);
    }
    errors.push(...g1);
    // Every bucket is reported, an empty one as 0 (a clean bucket is a count, not a missing key).
    const count = (lines) => lines.reduce((m, x) => { const b = bucketOf(x.p); m[b] = (m[b] || 0) + 1; return m; }, { 'script.js': 0, 'index.html': 0, 'lib/': 0, other: 0 });
    const g2Count = count(g2Lines), g3Count = count(g3Lines);
    for (const b of Object.keys({ ...g2, ...g2Count })) {
        const c = g2Count[b] || 0, max = g2[b] || 0;
        if (c > max) errors.push(`G2 inline colour: ${c} lines in ${b} write a colour, background or border in markup (a style attribute, setAttribute('style'), style.cssText or .style.<prop>); the ceiling is ${max} and may only go down. Move the colour into a class. Lines: ${g2Lines.filter(x => bucketOf(x.p) === b).map(x => x.text).join(', ')}`);
    }
    for (const b of Object.keys({ ...g3, ...g3Count })) {
        if (b === 'styles.css') continue;
        const c = g3Count[b] || 0, max = g3[b] || 0;
        if (c > max) errors.push(`G3 hue: ${c} lines in ${b} hold a colour value in a string: not a kit colour by name; the ceiling is ${max} and may only go down. Name a token in a class. Lines (value): ${g3Lines.filter(x => bucketOf(x.p) === b).map(x => x.text).join(', ')}`);
    }
    if (cssG3.length > (g3['styles.css'] || 0)) errors.push(`G3 hue: ${cssG3.length} lines in styles.css hold a colour that is not a kit colour (a token value of :root, white or black); the ceiling is ${g3['styles.css'] || 0} and may only go down. Lines (value): ${cssG3.map(x => x.text).join(', ')}`);
    errors.push(...cssG4);
    if (g4Lines.length > g4) errors.push(`G4 muted text: ${g4Lines.length} source lines write color: var(--text-muted), text people must read; the ceiling is ${g4} and may only go down. Lines: ${g4Lines.map(x => `${x.p}:${x.n}`).join(', ')}`);
    for (const e of exempt) if (!used.has(e) && !errors.some(x => x.includes(`function ${e.fn} not found`))) errors.push(`${e.file}${e.fn ? ' ' + e.fn : ''}: the exemption matches nothing (a stale exemption): ${e.why}`);
    return { ok: errors.length === 0, errors, counts: { g1: g1.length, g2: g2Count, g3: { ...g3Count, 'styles.css': cssG3.length }, g4: { css: cssG4.length, sources: g4Lines.length } } };
}

export function report(r) {
    if (r.ok) return `site legacy guard: OK (G2 ${JSON.stringify(r.counts.g2)}, G3 ${JSON.stringify(r.counts.g3)}, G4 sources ${r.counts.g4.sources})`;
    return ['SITE LEGACY GUARD FAILED', ...r.errors.map(e => '  ' + (e.length > 1200 ? e.slice(0, 1200) + ' ...' : e))].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const r = checkSite(repoReader(root));
    const text = report(r);
    if (r.ok) { console.log(text); process.exit(0); }
    console.error(text);
    process.exit(1);
}
