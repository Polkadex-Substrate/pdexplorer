// Discussion board: a small, safe Markdown subset for posts.
//
// Posts are user-generated and render on public pages, so this file is an XSS
// boundary. It is our own renderer rather than a library on purpose:
//   - no third-party script may run on the explorer (CLAUDE.md), and a vetted
//     parser plus a sanitiser (marked + DOMPurify) is ~70 KB of someone else's
//     code whose output we would still have to trust; DOMPurify also needs a DOM,
//     so the server-side tests could not run it without adding jsdom;
//   - the subset is small enough to read in one sitting, and every element it can
//     emit is a constant string in this file.
//
// Escape-first design: the input is never copied to the output except through
// escapeHtml (lib/html-escape.js). Markup is only ever one of the constant tags
// below; attribute values are escaped and come from a validated URL. Anything
// that is not recognised, including raw HTML, renders as escaped text.
//
// Linear time: no regex with nested or overlapping quantifiers runs on user
// text; brackets, backticks and emphasis are matched with precomputed indexes
// or a capped stack, so a hostile 4,000-character post cannot stall a tab.
//
// Supported: paragraphs with line breaks, **bold**, *italic*, ~~strike~~,
// `code`, fenced code blocks, # headings (shown as h3-h5), - and 1. lists (one
// nesting level), > quotes (3 levels), --- rules, [links](url), bare http(s)
// URLs, simple | tables. ![images](url) render as a link, never as <img>.

import { escapeHtml as esc } from './html-escape.js';

export const INTERNAL_HOSTS = ['explorer.polkadex.ee'];
const SITE_ORIGIN = 'https://explorer.polkadex.ee';

// Longer than any post (4,000) or edit; beyond it, plain escaped text only.
export const MAX_RENDER_LEN = 20000;
const MAX_QUOTE_DEPTH = 3;
const MAX_DELIMS = 64;          // open emphasis delimiters tracked at once
const MAX_URL_LEN = 2048;
const MAX_TITLE_LEN = 300;
const MAX_PARENS = 8;           // nesting inside a link destination; also bounds "[a](" spam
const MAX_TABLE_COLS = 12;

// Placeholders for code spans (Unicode private use; stripped from the input).
const PH_OPEN = '\uE000';
const PH_CLOSE = '\uE001';

const ASCII_PUNCT = /[!-\/:-@\[-`{-~]/;
const WS = /\s/;
const ALNUM = /[A-Za-z0-9]/;

// URLs: no whitespace, controls, quotes, angle brackets, backslash, backtick,
// private-use placeholders, or bidi / zero-width tricks that disguise a target.
const URL_BAD = /[\x00-\x20\x7f"<>\\`\uE000-\uF8FF\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;

function plain(text) {
    return '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
}

// The one entry point. Returns trusted HTML.
//   opts.internalHosts - hosts whose links open in place through the router.
export function renderMarkdown(src, opts = {}) {
    let text = String(src == null ? '' : src)
        .replace(/\r\n?/g, '\n')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\uE000\uE001]/g, '\uFFFD');
    if (!text.trim()) return '';
    if (text.length > MAX_RENDER_LEN) return plain(text);
    const ctx = { hosts: new Set((opts.internalHosts || INTERNAL_HOSTS).map(h => String(h).toLowerCase())) };
    return renderBlocks(text.split('\n'), ctx, 0);
}

// ---- links ------------------------------------------------------------------

// Decide whether a link target is allowed. Returns null (render as text) or
//   { href, kind: 'internal' | 'external' | 'mail', host }
// Allowed: http(s) URLs, mailto:, and same-site paths starting with one "/".
export function safeUrl(raw, ctx = { hosts: new Set(INTERNAL_HOSTS) }) {
    const u = String(raw == null ? '' : raw);
    if (!u || u.length > MAX_URL_LEN || URL_BAD.test(u)) return null;
    const lower = u.slice(0, 8).toLowerCase();
    if (lower.startsWith('http://') || lower.startsWith('https://')) {
        let p;
        try { p = new URL(u); } catch (_) { return null; }
        if ((p.protocol !== 'http:' && p.protocol !== 'https:') || !p.hostname) return null;
        // user:pass@ is how "https://explorer.polkadex.ee@evil.example" fools a reader.
        if (p.username || p.password) return null;
        const host = p.hostname.toLowerCase();
        if (p.protocol === 'https:' && !p.port && ctx.hosts.has(host)) {
            const path = p.pathname + p.search + p.hash;
            // "//x" or "/\x" would be protocol-relative: a same-site look, an off-site trip.
            if (!/^\/[\/\\]/.test(path)) return { href: path, kind: 'internal', host };
        }
        return { href: p.href, kind: 'external', host };
    }
    if (lower.startsWith('mailto:')) {
        const addr = u.slice(7).split('?')[0];
        if (!/^[^\s@\/:]+@[^\s@\/:]+$/.test(addr)) return null;
        return { href: u, kind: 'mail', host: addr };
    }
    if (u[0] === '/' && u[1] !== '/') {
        let p;
        try { p = new URL(u, SITE_ORIGIN); } catch (_) { return null; }
        if (p.origin !== SITE_ORIGIN) return null;
        const path = p.pathname + p.search + p.hash;
        if (/^\/[\/\\]/.test(path)) return null;
        return { href: path, kind: 'internal', host: 'explorer.polkadex.ee' };
    }
    return null;
}

function linkHtml(target, innerHtml, extraClass = '') {
    const cls = 'md-link' + (extraClass ? ' ' + extraClass : '');
    if (target.kind === 'internal') {
        return `<a href="${esc(target.href)}" class="${cls}">${innerHtml}</a>`;
    }
    if (target.kind === 'mail') {
        return `<a href="${esc(target.href)}" class="${cls} md-ext" rel="nofollow noopener noreferrer ugc" title="${esc('Email ' + target.host)}">${innerHtml}</a>`;
    }
    return `<a href="${esc(target.href)}" class="${cls} md-ext" target="_blank" rel="nofollow noopener noreferrer ugc" title="${esc('Opens ' + target.host + ' in a new tab')}">${innerHtml}</a>`;
}

// ---- blocks -----------------------------------------------------------------

function isBlank(line) { return !line.trim(); }

function leadingIndent(line) {
    let n = 0, i = 0;
    for (; i < line.length; i++) {
        if (line[i] === ' ') n++;
        else if (line[i] === '\t') n += 4;
        else break;
    }
    return { width: n, chars: i };
}

function fenceOpen(line) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!m) return null;
    // A backtick fence's info string may not contain a backtick (CommonMark).
    if (m[1][0] === '`' && line.indexOf('`', m[0].length) !== -1) return null;
    return { ch: m[1][0], len: m[1].length };
}

function isFenceClose(line, f) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    return !!m && m[1][0] === f.ch && m[1].length >= f.len && !line.slice(m[0].length).trim();
}

function heading(line) {
    const m = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(line);
    if (!m) return null;
    let body = line.slice(m[0].length).trim();
    // Optional closing run of #s, when separated by a space (or the whole body).
    let e = body.length;
    while (e > 0 && body[e - 1] === '#') e--;
    if (e === 0) body = '';
    else if (e < body.length && (body[e - 1] === ' ' || body[e - 1] === '\t')) body = body.slice(0, e).trim();
    return { level: m[1].length, body };
}

function isHr(line) {
    if (leadingIndent(line).width > 3) return false;
    const t = line.replace(/[ \t]/g, '');
    return /^(?:-{3,}|\*{3,}|_{3,})$/.test(t);
}

function isQuote(line) { return /^ {0,3}>/.test(line); }

const LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+/;
function listItem(line) {
    const m = LIST_RE.exec(line);
    if (!m) return null;
    const ordered = !/[-*+]/.test(m[2]);
    return {
        level: leadingIndent(m[1]).width >= 2 ? 1 : 0,
        ordered,
        num: ordered ? parseInt(m[2], 10) : 0,
        text: line.slice(m[0].length)
    };
}

// Table rows: split on | that is not backslash-escaped; outer pipes optional.
function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && s[i + 1] === '|') { cur += '\\|'; i++; continue; }
        if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
        cur += s[i];
    }
    cells.push(cur.trim());
    return cells;
}

function tableAt(lines, i) {
    if (i + 1 >= lines.length || lines[i].indexOf('|') === -1) return null;
    const delim = lines[i + 1];
    if (!/^[ \t|:-]+$/.test(delim) || delim.indexOf('-') === -1 || delim.indexOf('|') === -1) return null;
    const head = splitRow(lines[i]);
    const spec = splitRow(delim);
    if (head.length > MAX_TABLE_COLS || head.length !== spec.length) return null;
    const align = [];
    for (const c of spec) {
        if (!/^:?-+:?$/.test(c)) return null;
        const l = c[0] === ':', r = c[c.length - 1] === ':';
        align.push(l && r ? 'center' : r ? 'right' : l ? 'left' : '');
    }
    return { head, align };
}

function renderTable(lines, i, t, ctx, out) {
    const cell = (tag, txt, k) => `<${tag}${t.align[k] ? ` style="text-align:${t.align[k]}"` : ''}>${renderInline(txt.replace(/\\\|/g, '|'), ctx)}</${tag}>`;
    let html = '<div class="md-table-wrap"><table><thead><tr>' + t.head.map((c, k) => cell('th', c, k)).join('') + '</tr></thead><tbody>';
    i += 2;
    while (i < lines.length && !isBlank(lines[i]) && lines[i].indexOf('|') !== -1) {
        const row = splitRow(lines[i]);
        html += '<tr>' + t.head.map((_, k) => cell('td', row[k] || '', k)).join('') + '</tr>';
        i++;
    }
    out.push(html + '</tbody></table></div>');
    return i;
}

function startsBlock(line) {
    return !!(fenceOpen(line) || heading(line) || isHr(line) || isQuote(line));
}

function renderList(lines, i, ctx, out) {
    const first = listItem(lines[i]);
    const top = { ordered: first.ordered, start: first.num, items: [] };
    let cur = null, sub = null;
    while (i < lines.length) {
        const line = lines[i];
        if (isBlank(line)) {
            // A blank line ends the list unless the next text is another item of it.
            let j = i + 1;
            while (j < lines.length && isBlank(lines[j])) j++;
            const nx = j < lines.length ? listItem(lines[j]) : null;
            if (nx && ((nx.level === 1 && cur) || (nx.level === 0 && nx.ordered === top.ordered))) { i = j; continue; }
            break;
        }
        if (startsBlock(line)) break;
        const it = listItem(line);
        if (it) {
            if (it.level === 0 || !cur) {
                if (it.ordered !== top.ordered) break;   // the other list type starts a new list
                cur = { text: [it.text], sub: null };
                top.items.push(cur);
                sub = null;
            } else {
                if (!cur.sub) cur.sub = { ordered: it.ordered, start: it.num, items: [] };
                sub = { text: [it.text] };
                cur.sub.items.push(sub);
            }
        } else {
            (sub || cur).text.push(line.trim());   // continuation line
        }
        i++;
    }
    const open = l => l.ordered ? (l.start !== 1 ? `<ol start="${Number(l.start)}">` : '<ol>') : '<ul>';
    const close = l => l.ordered ? '</ol>' : '</ul>';
    let html = open(top);
    for (const item of top.items) {
        html += '<li>' + renderInline(item.text.join('\n'), ctx);
        if (item.sub) {
            html += open(item.sub) + item.sub.items.map(s => '<li>' + renderInline(s.text.join('\n'), ctx) + '</li>').join('') + close(item.sub);
        }
        html += '</li>';
    }
    out.push(html + close(top));
    return i;
}

function renderBlocks(lines, ctx, depth) {
    const out = [];
    let para = [];
    const flush = () => {
        if (para.length) { out.push('<p>' + renderInline(para.join('\n'), ctx) + '</p>'); para = []; }
    };
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (isBlank(line)) { flush(); i++; continue; }
        const f = fenceOpen(line);
        if (f) {
            flush();
            const body = [];
            i++;
            while (i < lines.length && !isFenceClose(lines[i], f)) body.push(lines[i++]);
            i++;   // the closing fence (or past the end: an unclosed fence runs to the end)
            out.push('<pre class="md-code"><code>' + esc(body.join('\n')) + '</code></pre>');
            continue;
        }
        const h = heading(line);
        if (h) {
            flush();
            // No giant headings in a comment: # is h3, ## is h4, the rest h5.
            const tag = h.level === 1 ? 'h3' : h.level === 2 ? 'h4' : 'h5';
            out.push(`<${tag} class="md-h">${renderInline(h.body, ctx)}</${tag}>`);
            i++;
            continue;
        }
        if (isHr(line)) { flush(); out.push('<hr>'); i++; continue; }
        if (isQuote(line) && depth < MAX_QUOTE_DEPTH) {
            flush();
            const inner = [];
            while (i < lines.length && isQuote(lines[i])) inner.push(lines[i++].replace(/^ {0,3}> ?/, ''));
            out.push('<blockquote>' + renderBlocks(inner, ctx, depth + 1) + '</blockquote>');
            continue;
        }
        if (listItem(line)) { flush(); i = renderList(lines, i, ctx, out); continue; }
        const t = tableAt(lines, i);
        if (t) { flush(); i = renderTable(lines, i, t, ctx, out); continue; }
        para.push(line);
        i++;
    }
    flush();
    return out.join('');
}

// ---- inline -----------------------------------------------------------------

// Code spans first, swapped for placeholders so links and emphasis can wrap
// them. Each backtick run is paired with the NEXT run of the same length,
// found through a right-to-left index: linear, however many backticks.
function extractCode(s, codes) {
    const runs = [];
    for (let i = 0; i < s.length;) {
        if (s[i] !== '`') { i++; continue; }
        let j = i;
        while (j < s.length && s[j] === '`') j++;
        // \` is a literal backtick: the run starts one later.
        const start = (i > 0 && s[i - 1] === '\\') ? i + 1 : i;
        if (j > start) runs.push([start, j - start]);
        i = j;
    }
    const next = new Array(runs.length).fill(-1);
    const seen = new Map();
    for (let k = runs.length - 1; k >= 0; k--) {
        const len = runs[k][1];
        if (seen.has(len)) next[k] = seen.get(len);
        seen.set(len, k);
    }
    let out = '', pos = 0, k = 0;
    while (k < runs.length) {
        const m = next[k];
        if (m === -1) { k++; continue; }
        const [start, len] = runs[k];
        out += s.slice(pos, start);
        let code = s.slice(start + len, runs[m][0]).replace(/\n/g, ' ');
        if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim()) code = code.slice(1, -1);
        out += PH_OPEN + codes.length + PH_CLOSE;
        codes.push('<code>' + esc(code) + '</code>');
        pos = runs[m][0] + runs[m][1];
        k = m + 1;
    }
    return out + s.slice(pos);
}

function renderInline(s, ctx) {
    const codes = [];
    const html = renderSpans(extractCode(s, codes), ctx, false);
    return html
        .replace(/\uE000(\d+)\uE001/g, (_, n) => codes[Number(n)] || '')
        .replace(/[\uE000\uE001]/g, '');
}

// [text](dest "optional title") starting at s[i] === '['. Link text may not
// contain brackets (no nesting); dest and title are length-capped and the
// destination's paren depth too, so the work per '[' is small and bounded. Returns { end, text, dest } or null.
function parseLink(s, i, idx) {
    const close = idx.nextClose[i + 1];
    if (close === -1 || (idx.nextOpen[i + 1] !== -1 && idx.nextOpen[i + 1] < close)) return null;
    if (s[close + 1] !== '(') return null;
    let p = close + 2;
    while (s[p] === ' ' || s[p] === '\t') p++;
    const destStart = p;
    let depth = 0;
    for (; p < s.length && p - destStart <= MAX_URL_LEN; p++) {
        const c = s[p];
        if (WS.test(c)) break;
        if (c === '(') { if (++depth > MAX_PARENS) return null; }
        else if (c === ')') { if (depth === 0) break; depth--; }
    }
    if (p - destStart > MAX_URL_LEN) return null;
    const dest = s.slice(destStart, p);
    while (s[p] === ' ' || s[p] === '\t') p++;
    const q = s[p];
    if (q === '"' || q === "'") {
        const t = s.indexOf(q, p + 1);
        if (t === -1 || t - p > MAX_TITLE_LEN) return null;
        p = t + 1;   // the title is accepted and dropped: hover shows the real destination
        while (s[p] === ' ' || s[p] === '\t') p++;
    }
    if (s[p] !== ')') return null;
    return { end: p + 1, text: s.slice(i + 1, close), dest };
}

function autolink(s, i) {
    const head = s.slice(i, i + 8).toLowerCase();
    if (!head.startsWith('https://') && !head.startsWith('http://')) return null;
    let j = i;
    while (j < s.length && j - i < MAX_URL_LEN && !URL_BAD.test(s[j])) j++;
    // Trailing punctuation belongs to the sentence, and an unbalanced ")" to
    // the parenthesis around the link.
    let url = s.slice(i, j);
    let opens = 0, closes = 0;
    for (const c of url) { if (c === '(') opens++; else if (c === ')') closes++; }
    for (;;) {
        const last = url[url.length - 1];
        if ('.,:;!?\'*_~]'.includes(last)) { url = url.slice(0, -1); continue; }
        if (last === ')' && closes > opens) { url = url.slice(0, -1); closes--; continue; }
        break;
    }
    return { url, end: i + url.length };
}

// Flanking rules, simplified from CommonMark: can a run of `ch` open or close?
function flank(ch, before, after) {
    const bWs = WS.test(before), aWs = WS.test(after);
    const bP = ASCII_PUNCT.test(before), aP = ASCII_PUNCT.test(after);
    const left = !aWs && (!aP || bWs || bP);
    const right = !bWs && (!bP || aWs || aP);
    if (ch === '_') return { open: left && (!right || bP), close: right && (!left || aP) };
    return { open: left, close: right };
}

function renderSpans(s, ctx, inLink) {
    // Next ']' and '[' at or after each position, for O(1) bracket matching.
    const n = s.length;
    const idx = { nextClose: new Int32Array(n + 2).fill(-1), nextOpen: new Int32Array(n + 2).fill(-1) };
    for (let k = n - 1; k >= 0; k--) {
        idx.nextClose[k] = s[k] === ']' ? k : idx.nextClose[k + 1];
        idx.nextOpen[k] = s[k] === '[' ? k : idx.nextOpen[k + 1];
    }
    const tokens = [];
    let buf = '';
    const pushText = () => { if (buf) { tokens.push({ t: 'text', v: buf }); buf = ''; } };
    let i = 0;
    while (i < n) {
        const c = s[i];
        if (c === '\\' && i + 1 < n && ASCII_PUNCT.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
        if (c === '\n') { pushText(); tokens.push({ t: 'html', v: '<br>' }); i++; continue; }
        if (!inLink && (c === '[' || (c === '!' && s[i + 1] === '['))) {
            const image = c === '!';
            const r = parseLink(s, image ? i + 1 : i, idx);
            const target = r && safeUrl(r.dest, ctx);
            if (target) {
                pushText();
                const shown = r.text.trim();
                const inner = image
                    ? '<i class="bx bx-image" aria-hidden="true"></i> ' + (shown ? renderSpans(shown, ctx, true) : esc('image'))
                    : (shown ? renderSpans(r.text, ctx, true) : esc(r.dest));
                tokens.push({ t: 'html', v: linkHtml(target, inner, image ? 'md-img-link' : '') });
                i = r.end;
                continue;
            }
        }
        if (!inLink && (c === 'h' || c === 'H') && (i === 0 || !ALNUM.test(s[i - 1]))) {
            const a = autolink(s, i);
            const target = a && safeUrl(a.url, ctx);
            if (target) {
                pushText();
                tokens.push({ t: 'html', v: linkHtml(target, esc(a.url)) });
                i = a.end;
                continue;
            }
        }
        if (c === '*' || c === '_' || c === '~') {
            let j = i;
            while (j < n && s[j] === c) j++;
            const len = j - i;
            if (c === '~' && len !== 2) { buf += s.slice(i, j); i = j; continue; }
            const f = flank(c, i > 0 ? s[i - 1] : ' ', j < n ? s[j] : ' ');
            pushText();
            tokens.push({ t: 'delim', ch: c, n: len, open: f.open, close: f.close, opens: [], closes: [] });
            i = j;
            continue;
        }
        buf += c;
        i++;
    }
    pushText();
    matchEmphasis(tokens);
    let html = '';
    for (const tk of tokens) {
        if (tk.t === 'text') html += esc(tk.v);
        else if (tk.t === 'html') html += tk.v;
        else html += tk.closes.join('') + esc(tk.ch.repeat(tk.n)) + tk.opens.join('');
    }
    return html;
}

// Pair emphasis delimiters. The stack of possible openers is capped, and a
// match discards every opener above it (they render as literal characters),
// so tags always nest properly and the work stays linear.
function matchEmphasis(tokens) {
    const stack = [];
    for (let k = 0; k < tokens.length; k++) {
        const d = tokens[k];
        if (d.t !== 'delim') continue;
        if (d.close) {
            while (d.n > 0) {
                let at = -1;
                for (let q = stack.length - 1; q >= 0; q--) {
                    const o = tokens[stack[q]];
                    if (o.ch === d.ch && o.n > 0) { at = q; break; }
                }
                if (at === -1) break;
                const o = tokens[stack[at]];
                let use, tag;
                if (d.ch === '~') { use = 2; tag = 'del'; }
                else { use = o.n >= 2 && d.n >= 2 ? 2 : 1; tag = use === 2 ? 'strong' : 'em'; }
                o.n -= use;
                d.n -= use;
                o.opens.unshift('<' + tag + '>');
                d.closes.push('</' + tag + '>');
                stack.length = o.n > 0 ? at + 1 : at;
            }
        }
        if (d.n > 0 && d.open && stack.length < MAX_DELIMS) stack.push(k);
    }
}
