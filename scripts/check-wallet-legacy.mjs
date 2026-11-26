#!/usr/bin/env node
// Guard: the wallet page and every sub-view it opens draw no legacy controls
// (spec cto-team/plans/2026-11-25-multisig-and-advanced-cards.md, section 6.1 T9).
//
//   node scripts/check-wallet-legacy.mjs          exit 0, or exit 1 with one line per offence
//
// "Legacy" is .staking-download-btn (a grey download button) used for anything, or a colour, background or border
// written in markup (style="...", setAttribute('style', ...), el.style.color = ...). The wallet-page sources are
// checked in full: the files in WALLET_FILES, and the script.js functions in WALLET_FUNCTIONS, found by name (never
// by line number). Everywhere else .staking-download-btn no longer exists: the repository holds at most CEILING (0) uses
// outside the wallet page. The ceiling scan reads every .js, .mjs, .cjs and .html file in the repository except the
// EXCLUDE list (an exclusion list, not an allowlist: a new file is scanned without anyone adding it).
//
// Run by npm test through test/wallet-legacy-guard.test.js, which also breaks each rule once on a fixture.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WALLET_FILES = Object.freeze([
    'lib/multisig-view.js', 'lib/wallet-sections.js', 'lib/wallet-advanced-view.js',
    'lib/nomination-status-view.js', 'lib/recipient-network.js', 'lib/payout-refresh.js', 'lib/stake-refresh.js'
]);
export const WALLET_FUNCTIONS = Object.freeze([
    'renderApiError', 'fetchWalletDashboard', 'repaintWalletPriceCard', 'renderWalletDashboard', 'mountWalletRewardsTable',
    'mountWalletTxTable', 'renderWalletAprCard', 'openIdentityModal', 'renderWalletAdvancedSection', 'renderProxyList',
    'renderAddProxyForm', 'renderMultisigCalculator', 'renderMultisigPending'
]);
// Sprint 11 site sweep (spec 2026-11-26, section 1.2): every use is gone and the class with it; the ceiling is 0.
export const CEILING = 0;
// Paths (relative to the repository, forward slashes) the ceiling scan never reads.
export const EXCLUDE = Object.freeze([/^node_modules\//, /^\.git\//, /^test\//, /^tools\//, /^scripts\//, /^docs\//, /^dist\//, /^public\//, /^\.vite\//]);
const SCANNED = /\.(m?js|cjs|html)$/;
const CLASS = 'staking-download-btn';
const FIX = 'Pick the tier (.ui-action, .validate-secondary, .validate-text-btn) and move the colour into a class in styles.css.';

const isComment = (line) => { const t = line.trim(); return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('<!--'); };
const COLOUR = /(^|[;\s"'`])(color|background(-color|-image)?|border(?!-radius)(-[a-z]+)*)\s*:/i;

// One line's offences: the class, a style attribute or setAttribute('style') with a colour, background or border (or
// built from an interpolation, whose value the guard cannot see), or a style property of that kind set from script.
export function lineOffences(line) {
    if (isComment(line)) return [];
    const out = [];
    if (line.includes(CLASS)) out.push(`.${CLASS}`);
    for (const m of line.matchAll(/style\s*=\s*(["'`])([\s\S]*?)\1/g)) {
        if (m[2].includes('${')) out.push('a style attribute built from an interpolation');
        else if (COLOUR.test(';' + m[2])) out.push('a colour, background or border in a style attribute');
    }
    for (const m of line.matchAll(/setAttribute\(\s*['"]style['"]\s*,\s*(["'`])([\s\S]*?)\1/g)) if (COLOUR.test(';' + m[2])) out.push('a colour, background or border set with setAttribute(\'style\')');
    if (/\.style\.(color|background\w*|border\w*)\s*=(?!=)/.test(line)) out.push('a colour, background or border set on .style from script');
    if (/\.style\.cssText\s*=/.test(line) && COLOUR.test(';' + line.slice(line.indexOf('cssText')))) out.push('a colour, background or border set with style.cssText');
    return out;
}

// The [start, end] line numbers (1-based) of a function declaration found by name; null when it is not there.
export function functionLines(src, name) {
    const at = src.search(new RegExp(`(^|\\n)(async\\s+)?function\\s+${name}\\s*\\(`));
    if (at < 0) return null;
    const start = src.indexOf('function', at);
    let i = src.indexOf('(', start), depth = 0;
    for (; i < src.length; i++) { if (src[i] === '(') depth++; else if (src[i] === ')' && --depth === 0) break; }
    for (i = src.indexOf('{', i), depth = 0; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
    }
    const lineAt = (p) => src.slice(0, p).split('\n').length;
    return [lineAt(start), lineAt(i)];
}

// read(path) -> text or null; list() -> every repository path (forward slashes). Returns the report.
export function checkLegacy({ read, list, ceiling = CEILING }) {
    const offenders = [];
    const strict = new Map();   // path -> Set of line numbers checked in full
    for (const f of WALLET_FILES) {
        const src = read(f);
        if (src == null) { offenders.push(`${f}: the file is missing (the guard would pass on nothing)`); continue; }
        strict.set(f, null);
        src.split('\n').forEach((l, n) => { for (const o of lineOffences(l)) offenders.push(`${f}:${n + 1}: ${o}: ${l.trim().slice(0, 140)}`); });
    }
    const script = read('script.js');
    const ranges = [];
    if (script == null) offenders.push('script.js: the file is missing');
    else {
        const lines = script.split('\n');
        for (const name of WALLET_FUNCTIONS) {
            const r = functionLines(script, name);
            if (!r) { offenders.push(`script.js: function ${name} not found (renamed? the guard finds the wallet renderers by name)`); continue; }
            ranges.push(r);
            for (let n = r[0]; n <= r[1]; n++) for (const o of lineOffences(lines[n - 1])) offenders.push(`script.js:${n} (${name}): ${o}: ${lines[n - 1].trim().slice(0, 140)}`);
        }
    }
    const inRange = (n) => ranges.some(([a, b]) => n >= a && n <= b);
    const outside = [];
    for (const p of list()) {
        if (!SCANNED.test(p) || EXCLUDE.some(x => x.test(p)) || strict.has(p)) continue;
        const src = read(p);
        if (src == null) continue;
        src.split('\n').forEach((l, n) => {
            if (isComment(l) || (p === 'script.js' && inRange(n + 1))) return;
            const c = l.split(CLASS).length - 1;
            for (let k = 0; k < c; k++) outside.push(`${p}:${n + 1}`);
        });
    }
    const errors = offenders.slice();
    if (outside.length > ceiling) errors.push(`.${CLASS} no longer exists; pick a tier (.validate-primary, .ui-action, .validate-secondary, .validate-text-btn). It is used ${outside.length} times outside the wallet page; the ceiling is ${ceiling}. Uses: ${outside.join(', ')}`);
    return { ok: errors.length === 0, errors, offenders, outside, ranges };
}

export function repoReader(root) {
    const read = (p) => { try { return readFileSync(join(root, p), 'utf8'); } catch (e) { return null; } };
    const list = () => {
        const out = [];
        const walk = (dir) => {
            for (const name of readdirSync(dir)) {
                const full = join(dir, name);
                const rel = relative(root, full).split('\\').join('/');
                let st;
                try { st = statSync(full); } catch (e) { continue; }
                if (st.isDirectory()) { if (!EXCLUDE.some(x => x.test(rel + '/'))) walk(full); } else out.push(rel);
            }
        };
        walk(root);
        return out;
    };
    return { read, list };
}

export function report(r) {
    if (r.ok) return `wallet legacy guard: OK (wallet-page sources clean; ${r.outside.length} of ${CEILING} uses of .${CLASS} elsewhere)`;
    return ['WALLET LEGACY GUARD FAILED', ...r.errors.map(e => '  ' + e), FIX].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const r = checkLegacy(repoReader(root));
    const text = report(r);
    if (r.ok) { console.log(text); process.exit(0); }
    console.error(text);
    process.exit(1);
}
