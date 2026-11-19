// The input audit behind test/input-actions-audit.test.js (spec: cto-team/plans/
// 2026-11-17-input-paste-clear.md, section 4.4).
//
// Every text-like <input> and <textarea> in index.html, script.js and lib/*.js must say
// what Paste and Clear do to it (data-input-kind="<known kind>") or why it has neither
// (data-no-input-actions="<reason>"), or be readonly. Every createElement('input' |
// 'textarea') site must set data-no-input-actions within the next lines or carry an
// "input-actions: exempt (reason)" marker.
//
// Source is read through stripComments one line at a time, so a comment line becomes an
// empty line and the reported line numbers stay the file's own.

import { stripComments } from './source.js';

// The contract from the spec (section 3.6). lib/input-actions.js exports the same list;
// the audit test asserts the two agree.
export const AUDIT_KINDS = ['address', 'address-list', 'amount', 'integer', 'ref', 'hex', 'search', 'code', 'text'];

// Input types that are not text boxes (spec 3.9). Anything else, including a type the
// audit cannot read (a template expression), counts as text-like: fail closed.
const NOT_TEXT = new Set(['checkbox', 'radio', 'range', 'hidden', 'file', 'color', 'date', 'datetime-local',
    'month', 'week', 'time', 'submit', 'button', 'image', 'reset', 'password']);

export const FIX_SENTENCE = 'Add data-input-kind=... or data-no-input-actions="reason"';

// The index of the '>' that closes a tag starting before `from`. Quotes and ${ ... }
// template expressions are skipped, so a '>' inside an attribute value or an arrow
// function does not end the tag early.
function tagEnd(src, from) {
    let quote = '', depth = 0;
    for (let i = from; i < src.length; i++) {
        const c = src[i];
        if (depth > 0) {
            if (c === '{') depth++;
            else if (c === '}') depth--;
            continue;
        }
        if (c === '$' && src[i + 1] === '{') { depth = 1; i++; continue; }
        if (quote) { if (c === quote) quote = ''; continue; }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === '>') return i;
    }
    return src.length - 1;
}

// One attribute's value: null when absent, '' when present without a value.
export function attrOf(tag, name) {
    const re = new RegExp('\\s' + name.replace(/[-]/g, '\\-') + '(?:\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+)))?(?=[\\s>/]|$)', 'i');
    const m = re.exec(tag);
    if (!m) return null;
    return m[1] ?? m[2] ?? m[3] ?? '';
}

const lineAt = (src, index) => src.slice(0, index).split('\n').length;
const short = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 80);

function classify(tag, tagName) {
    const type = String(attrOf(tag, 'type') ?? '').toLowerCase();
    const textLike = tagName === 'textarea' || type.includes('${') || !NOT_TEXT.has(type);
    if (!textLike) return { status: 'not-text' };
    if (attrOf(tag, 'readonly') !== null) return { status: 'readonly' };
    const opt = attrOf(tag, 'data-no-input-actions');
    if (opt !== null) return opt.trim() ? { status: 'opt-out', reason: opt.trim() } : { status: 'bad', why: 'empty data-no-input-actions reason' };
    const kind = attrOf(tag, 'data-input-kind');
    if (kind === null) return { status: 'bad', why: 'no data-input-kind' };
    if (!AUDIT_KINDS.includes(kind)) return { status: 'bad', why: `unknown data-input-kind "${kind}"` };
    return { status: 'kind', kind, actions: attrOf(tag, 'data-input-actions') };
}

// Audit one file's source. Returns { tags, sites, offenders }; offenders are readable
// one-line messages naming file:line.
export function auditSource(src, file) {
    const original = String(src || '');
    const lines = original.split('\n');
    const code = lines.map(l => stripComments(l)).join('\n');
    const tags = [], sites = [], offenders = [];

    const open = /<(input|textarea)\b/gi;
    let m;
    while ((m = open.exec(code))) {
        const end = tagEnd(code, m.index + m[0].length);
        const tag = code.slice(m.index, end + 1);
        const line = lineAt(code, m.index);
        const c = classify(tag, m[1].toLowerCase());
        const entry = { file, line, tagName: m[1].toLowerCase(), tag, id: attrOf(tag, 'id'), ...c };
        tags.push(entry);
        if (c.status === 'bad') offenders.push(`${file}:${line} ${short(tag)} (${c.why}). ${FIX_SENTENCE}`);
    }

    const create = /createElement\(\s*['"`](input|textarea)['"`]\s*\)/g;
    while ((m = create.exec(code))) {
        const line = lineAt(code, m.index);
        const after = code.split('\n').slice(line - 1, line + 5).join('\n');
        const raw = lines.slice(Math.max(0, line - 2), line).join('\n');   // the line before and the line itself
        const optOut = /data-no-input-actions['"`]\s*,\s*['"`]\s*[^'"`\s][^'"`]*['"`]/.test(after);
        const exempt = /input-actions:\s*exempt\s*\(\s*[^)\s][^)]*\)/.test(raw);
        sites.push({ file, line, ok: optOut || exempt });
        if (!optOut && !exempt) offenders.push(`${file}:${line} ${short(lines[line - 1])} (createElement without an opt-out). Set data-no-input-actions="reason" on it or add an "input-actions: exempt (reason)" comment`);
    }
    return { tags, sites, offenders };
}
