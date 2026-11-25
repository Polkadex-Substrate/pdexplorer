// Phone-width checks (cto-team/plans/2026-11-25-phone-width-fixes.md, section 5): the real stylesheet read as a
// cascade at a given viewport width, and the preview scenes the tool builds, parsed back into happy-dom.
// No dependencies beyond css-rules.js and happy-dom.

import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { parseRules } from './css-rules.js';

export const STYLES = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
export const RULES = parseRules(STYLES).map((r, order) => ({ ...r, order, media: (r.media || '').replace(/\s*\{\s*$/, '').replace(/\s+/g, ' ').trim() }));

// Does a media prelude apply at this viewport width? Only width queries are understood; any other query does not apply.
export function mediaApplies(media, width) {
    if (!media) return true;
    if (!/^@media\b/.test(media)) return false;
    const q = media.replace(/^@media\s*/, '').replace(/\bscreen\s+and\s+/g, '');
    if (/,/.test(q)) return false;
    const parts = q.split(/\s+and\s+/);
    for (const p of parts) {
        const m = /^\((max|min)-width:\s*([\d.]+)px\)$/.exec(p.trim());
        if (!m) return false;
        if (m[1] === 'max' && !(width <= Number(m[2]))) return false;
        if (m[1] === 'min' && !(width >= Number(m[2]))) return false;
    }
    return true;
}

// The declarations of every rule that names this exact selector and applies at this width, later rules winning.
export function declsAt(selector, width) {
    const out = {};
    for (const r of RULES) if (mediaApplies(r.media, width) && r.selectors.includes(selector)) Object.assign(out, r.decls);
    return out;
}
// The same for one exact media prelude ('' for the rules outside any media block).
export function declsIn(selector, media) {
    const out = {};
    for (const r of RULES) if (r.media === media && r.selectors.includes(selector)) Object.assign(out, r.decls);
    return out;
}

const specificity = (sel) => {
    const s = sel.replace(/\[[^\]]*\]/g, ' [a] ').replace(/:not\(([^)]*)\)/g, ' $1 ');
    const ids = (s.match(/#[\w-]+/g) || []).length;
    const cls = (s.match(/\.[\w-]+|\[a\]|:(?!:)[\w-]+/g) || []).length;
    const types = (s.replace(/[#.:][\w-]+|\[a\]/g, ' ').match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
    return ids * 10000 + cls * 100 + types;
};
const inlineDecls = (el) => {
    const out = {};
    for (const d of (el.getAttribute('style') || '').split(';')) { const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim(); }
    return out;
};
const byProp = new Map();
const rulesFor = (prop) => {
    if (!byProp.has(prop)) byProp.set(prop, RULES.filter(r => prop in r.decls));
    return byProp.get(prop);
};
const safeMatch = (el, sel) => { try { return !sel.includes('::') && el.matches(sel); } catch (e) { return false; } };

// The declared value of one property on one element at a width: the stylesheet cascade (media, specificity, order,
// !important), then the inline style. Not inherited. null when nothing declares it.
export function declared(el, prop, width) {
    let best = null;
    for (const r of rulesFor(prop)) {
        if (!mediaApplies(r.media, width)) continue;
        for (const sel of r.selectors) {
            if (!safeMatch(el, sel)) continue;
            const v = r.decls[prop];
            const imp = /!important\s*$/.test(v);
            const key = [imp ? 1 : 0, specificity(sel), r.order];
            if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && (key[1] > best.key[1] || (key[1] === best.key[1] && key[2] >= best.key[2])))) best = { key, v: v.replace(/\s*!important\s*$/, '') };
        }
    }
    const inl = inlineDecls(el)[prop];
    if (inl != null && (!best || best.key[0] === 0)) return inl;
    return best ? best.v : null;
}
// An inherited property: the nearest ancestor (or the element) that declares it.
export function inherited(el, prop, width) {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const v = declared(e, prop, width); if (v != null && v !== 'inherit') return v; }
    return null;
}
export const px = (v) => { const m = /^(-?[\d.]+)(px|rem|em)$/.exec(String(v || '').trim()); return m ? Number(m[1]) * (m[2] === 'px' ? 1 : 16) : null; };

// A box the page does not draw: [hidden], or display: none at this width on it or an ancestor.
export function undrawn(el, width) {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
        if (e.hasAttribute('hidden') && declared(e, 'display', width) == null) return true;
        if (declared(e, 'display', width) === 'none') return true;
    }
    return false;
}

// ── the preview scenes, as the tool writes them ──
// The tool is run once per process into a private temp dir (under TMPDIR) and each *-375.html is parsed back.
let built = null;
export function scenesAt375() {
    if (built) return built;
    const dir = mkdtempSync(join(tmpdir(), 'phone-width-'));
    try {
        const tool = fileURLToPath(new URL('../../tools/preview-scenes.mjs', import.meta.url));
        execFileSync(process.execPath, ['--experimental-sqlite', tool, '--out', dir], { stdio: 'pipe', timeout: 240000, maxBuffer: 1 << 26 });
        const out = [];
        for (const f of readdirSync(dir).filter(n => /-375\.html$/.test(n)).sort()) {
            const html = readFileSync(join(dir, f), 'utf8');
            const m = /srcdoc="([^"]*)"/.exec(html);
            if (!m) continue;
            const inner = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
            const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(inner);
            const win = new Window({ url: 'https://explorer.test/', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
            win.document.body.innerHTML = body ? body[1] : '';
            out.push({ id: f.replace(/-375\.html$/, ''), doc: win.document, win });
        }
        built = out;
    } finally { rmSync(dir, { recursive: true, force: true }); }
    return built;
}
export const walletScene = (id) => /^(account|r1|sections)-/.test(id);
