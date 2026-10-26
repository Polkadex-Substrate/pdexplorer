// Discussion board: the Markdown toolbar and Write / Preview toggle shared by
// the new-post box and the edit box.
//
// Lives here, not in script.js, because script.js is capped at 15,000 lines.
// applyFormat() is pure (text and selection in, replacement out) so the tests
// drive it directly; wireComposer() only moves that result into a textarea.
// The preview renders through renderMarkdown, the same function the posts use,
// so what you preview is what gets shown.

import { renderMarkdown } from './discussion-markdown.js';

export const HELP_HREF = '/help/discussion-formatting';

// kind, label (also the tooltip), boxicon, shortcut key
export const TOOLS = [
    { kind: 'bold', label: 'Bold (Ctrl+B)', icon: 'bx-bold', key: 'b' },
    { kind: 'italic', label: 'Italic (Ctrl+I)', icon: 'bx-italic', key: 'i' },
    { kind: 'link', label: 'Link (Ctrl+K)', icon: 'bx-link', key: 'k' },
    { kind: 'list', label: 'Bulleted list', icon: 'bx-list-ul' },
    { kind: 'quote', label: 'Quote', icon: 'bxs-quote-alt-left' },
    { kind: 'code', label: 'Code', icon: 'bx-code-alt' }
];

// Everything here is constant markup; textareaHtml is the caller's own
// (trusted) textarea element string.
export function composerHtml(textareaHtml) {
    const tools = TOOLS.map(t => `<button type="button" class="md-tool" data-md-format="${t.kind}" aria-label="${t.label}" title="${t.label}"><i class='bx ${t.icon}' aria-hidden="true"></i></button>`).join('');
    return `<div class="md-composer">
        <div class="md-composer-bar">
            <div class="md-tabs" role="tablist" aria-label="Editor mode">
                <button type="button" class="md-tab active" role="tab" data-md-mode="write" aria-selected="true">Write</button>
                <button type="button" class="md-tab" role="tab" data-md-mode="preview" aria-selected="false">Preview</button>
            </div>
            <div class="md-toolbar" role="toolbar" aria-label="Formatting">${tools}</div>
        </div>
        ${textareaHtml}
        <div class="md-preview discussion-post-body md-body" role="tabpanel" aria-label="Preview" hidden></div>
        <div class="md-help"><i class='bx bxl-markdown' aria-hidden="true"></i> <a href="${HELP_HREF}" target="_blank" rel="noopener">Markdown supported</a></div>
    </div>`;
}

// Ctrl/Cmd + B, I, K -> 'bold' | 'italic' | 'link'; anything else -> null.
export function shortcutFor(e) {
    if (!e || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null;
    const key = String(e.key || '').toLowerCase();
    const t = TOOLS.find(x => x.key === key);
    return t ? t.kind : null;
}

function wrap(value, start, end, marker, placeholder) {
    const m = marker.length;
    const sel = value.slice(start, end);
    // Already wrapped (markers just outside the selection): unwrap. Counting the
    // run tells italic from bold: "*x*" and "***x***" hold an italic, "**x**" does not.
    const ch = marker[0];
    let cb = 0, ca = 0;
    while (start - cb > 0 && value[start - cb - 1] === ch) cb++;
    while (end + ca < value.length && value[end + ca] === ch) ca++;
    const wrapped = marker === '*' ? (cb % 2 === 1 && ca % 2 === 1) : (cb >= m && ca >= m);
    if (wrapped) {
        return { from: start - m, to: end + m, text: sel, selStart: start - m, selEnd: end - m };
    }
    if (!sel) {
        return { from: start, to: end, text: marker + placeholder + marker, selStart: start + m, selEnd: start + m + placeholder.length };
    }
    // A double-click often selects a trailing space; keep it outside the markers.
    const lead = sel.length - sel.trimStart().length;
    const trail = sel.length - sel.trimEnd().length;
    const core = sel.trim() || sel;
    const pre = core === sel ? '' : sel.slice(0, lead), post = core === sel ? '' : sel.slice(sel.length - trail);
    const text = pre + marker + core + marker + post;
    const s = start + pre.length + m;
    return { from: start, to: end, text, selStart: s, selEnd: s + core.length };
}

function prefixLines(value, start, end, prefix) {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const stop = end > start && value[end - 1] === '\n' ? end - 1 : end;
    let lineEnd = value.indexOf('\n', Math.max(stop, lineStart));
    if (lineEnd === -1) lineEnd = value.length;
    const block = value.slice(lineStart, lineEnd);
    const lines = block.split('\n');
    const filled = lines.filter(l => l.trim());
    const bare = prefix.trimEnd();
    const all = filled.length > 0 && filled.every(l => l.startsWith(prefix) || l === bare);
    const out = all
        ? lines.map(l => (l.startsWith(prefix) ? l.slice(prefix.length) : l === bare ? '' : l))
        : lines.map(l => (l.trim() ? prefix + l : (lines.length === 1 ? prefix : l)));
    const text = out.join('\n');
    if (start === end) {
        const caret = Math.max(lineStart, start + (text.length - block.length));
        return { from: lineStart, to: lineEnd, text, selStart: caret, selEnd: caret };
    }
    return { from: lineStart, to: lineEnd, text, selStart: lineStart, selEnd: lineStart + text.length };
}

// The edit a toolbar button or shortcut makes: replace value[from, to) with
// `text`, then select [selStart, selEnd). Pure.
export function applyFormat(value, start, end, kind) {
    value = String(value || '');
    start = Math.max(0, Math.min(start | 0, value.length));
    end = Math.max(start, Math.min(end | 0, value.length));
    const sel = value.slice(start, end);
    switch (kind) {
        case 'bold': return wrap(value, start, end, '**', 'bold text');
        case 'italic': return wrap(value, start, end, '*', 'italic text');
        case 'code': {
            if (sel.indexOf('\n') === -1) return wrap(value, start, end, '`', 'code');
            const before = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
            const after = end < value.length && value[end] !== '\n' ? '\n' : '';
            const body = sel.replace(/\n$/, '');
            const text = before + '```\n' + body + '\n```' + after;
            const s = start + before.length + 4;
            return { from: start, to: end, text, selStart: s, selEnd: s + body.length };
        }
        case 'link': {
            if (/^https?:\/\/\S+$/i.test(sel.trim())) {
                const text = '[link text](' + sel.trim() + ')';
                return { from: start, to: end, text, selStart: start + 1, selEnd: start + 10 };
            }
            const label = sel || 'link text';
            const text = '[' + label + '](https://)';
            if (!sel) return { from: start, to: end, text, selStart: start + 1, selEnd: start + 1 + label.length };
            const u = start + label.length + 3;
            return { from: start, to: end, text, selStart: u, selEnd: u + 'https://'.length };
        }
        case 'list': return prefixLines(value, start, end, '- ');
        case 'quote': return prefixLines(value, start, end, '> ');
        default: return { from: start, to: end, text: sel, selStart: start, selEnd: end };
    }
}

// Put an applyFormat result into the textarea. execCommand('insertText')
// keeps the browser's undo history; where it is missing or refuses, set the
// value directly and announce the change so counters update.
export function replaceRange(ta, r, doc) {
    const expected = ta.value.slice(0, r.from) + r.text + ta.value.slice(r.to);
    let ok = false;
    try {
        ta.setSelectionRange(r.from, r.to);
        ok = !!(doc && typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, r.text));
    } catch (_) { ok = false; }
    if (!ok || ta.value !== expected) {
        ta.value = expected;
        if (typeof ta.dispatchEvent === 'function' && typeof Event === 'function') ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    ta.setSelectionRange(r.selStart, r.selEnd);
}

// Wire one .md-composer box. opts: { render, document }. Returns a small
// handle ({ apply, setMode }) for tests and callers.
export function wireComposer(box, opts = {}) {
    if (!box) return null;
    const ta = box.querySelector('textarea');
    const preview = box.querySelector('.md-preview');
    if (!ta || !preview) return null;
    const render = opts.render || renderMarkdown;
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    const tools = Array.from(box.querySelectorAll('[data-md-format]'));
    const tabs = Array.from(box.querySelectorAll('[data-md-mode]'));
    let mode = 'write';

    const apply = (kind) => {
        if (mode !== 'write') return;
        const r = applyFormat(ta.value, ta.selectionStart, ta.selectionEnd, kind);
        ta.focus();
        replaceRange(ta, r, doc);
    };
    const setMode = (m) => {
        mode = m === 'preview' ? 'preview' : 'write';
        tabs.forEach(t => {
            const on = t.getAttribute('data-md-mode') === mode;
            t.setAttribute('aria-selected', on ? 'true' : 'false');
            t.classList.toggle('active', on);
        });
        tools.forEach(b => { b.disabled = mode !== 'write'; });
        if (mode === 'preview') {
            preview.innerHTML = ta.value.trim() ? render(ta.value) : '<p class="md-empty">Nothing to preview.</p>';
            preview.hidden = false;
            ta.style.display = 'none';
        } else {
            preview.hidden = true;
            preview.innerHTML = '';
            ta.style.display = '';
            ta.focus();
        }
    };

    tools.forEach(b => {
        // mousedown would move focus to the button and lose the selection.
        b.addEventListener('mousedown', e => e.preventDefault());
        b.addEventListener('click', () => apply(b.getAttribute('data-md-format')));
    });
    tabs.forEach(t => t.addEventListener('click', () => setMode(t.getAttribute('data-md-mode'))));
    ta.addEventListener('keydown', e => {
        const kind = shortcutFor(e);
        if (kind) { e.preventDefault(); apply(kind); }
    });
    // A link in the preview must not navigate away from an unsaved draft.
    // External links open in a new tab and are left alone.
    preview.addEventListener('click', e => {
        const a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (a && a.getAttribute('target') !== '_blank') e.preventDefault();
    });
    return { apply, setMode, get mode() { return mode; } };
}
