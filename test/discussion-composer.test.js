// The Markdown toolbar, shortcuts and Write / Preview toggle around the post
// and edit boxes (lib/discussion-composer.js), and the wiring that puts them
// on every board: the thread page, the boards embedded on governance item
// pages, and the edit box.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyFormat, shortcutFor, composerHtml, wireComposer, replaceRange, TOOLS, HELP_HREF } from '../lib/discussion-composer.js';
import { renderMarkdown } from '../lib/discussion-markdown.js';
import { HELP_TOPICS } from '../lib/help-topics.js';
import { readRepo, stripComments } from './helpers/source.js';

// Apply a format to `text` where [ and ] mark the selection (| for a caret),
// and return the result with the new selection marked the same way.
function fmt(marked, kind) {
    let start, end, value;
    if (marked.includes('|')) { start = end = marked.indexOf('|'); value = marked.replace('|', ''); }
    else { start = marked.indexOf('['); end = marked.indexOf(']') - 1; value = marked.replace('[', '').replace(']', ''); }
    const r = applyFormat(value, start, end, kind);
    const out = value.slice(0, r.from) + r.text + value.slice(r.to);
    if (r.selStart === r.selEnd) return out.slice(0, r.selStart) + '|' + out.slice(r.selStart);
    return out.slice(0, r.selStart) + '[' + out.slice(r.selStart, r.selEnd) + ']' + out.slice(r.selEnd);
}

describe('toolbar insertions', () => {
    test('bold wraps the selection, inserts a selected placeholder, and toggles off', () => {
        assert.equal(fmt('a [word] b', 'bold'), 'a **[word]** b');
        assert.equal(fmt('a | b', 'bold'), 'a **[bold text]** b');
        assert.equal(fmt('a **[word]** b', 'bold'), 'a [word] b');
        // A trailing space from a double-click stays outside the markers.
        assert.equal(fmt('a [word ]b', 'bold'), 'a **[word]** b');
    });
    test('italic, including next to bold', () => {
        assert.equal(fmt('[x]', 'italic'), '*[x]*');
        assert.equal(fmt('*[x]*', 'italic'), '[x]');
        assert.equal(fmt('**[x]**', 'italic'), '***[x]***', 'italic inside bold adds, does not strip the bold');
        assert.equal(fmt('***[x]***', 'italic'), '**[x]**');
    });
    test('code: inline for one line, a fenced block for several', () => {
        assert.equal(fmt('run [npm test] now', 'code'), 'run `[npm test]` now');
        assert.equal(fmt('|', 'code'), '`[code]`');
        assert.equal(fmt('see:[a\nb]', 'code'), 'see:\n```\n[a\nb]\n```');
    });
    test('link', () => {
        assert.equal(fmt('|', 'link'), '[[link text]](https://)');
        assert.equal(fmt('[docs]', 'link'), '[docs]([https://])');
        assert.equal(fmt('[https://example.com/x]', 'link'), '[[link text]](https://example.com/x)');
    });
    test('list and quote prefix every selected line and toggle off', () => {
        assert.equal(fmt('[a\nb]', 'list'), '[- a\n- b]');
        assert.equal(fmt('[- a\n- b]', 'list'), '[a\nb]');
        assert.equal(fmt('x\nab|c\ny', 'list'), 'x\n- ab|c\ny');
        assert.equal(fmt('|', 'list'), '- |');
        assert.equal(fmt('[a\n\nb]', 'quote'), '[> a\n\n> b]');
        assert.equal(fmt('> a|', 'quote'), 'a|');
    });
    test('results render as intended', () => {
        const v = 'x';
        for (const t of TOOLS) {
            const r = applyFormat(v, 0, 1, t.kind);
            const html = renderMarkdown(r.text);
            assert.ok(html.length > 0, t.kind);
        }
        assert.equal(renderMarkdown(applyFormat('x', 0, 1, 'bold').text), '<p><strong>x</strong></p>');
        assert.equal(renderMarkdown(applyFormat('x', 0, 1, 'quote').text), '<blockquote><p>x</p></blockquote>');
    });
    test('out-of-range selections are clamped', () => {
        const r = applyFormat('abc', -5, 99, 'bold');
        assert.equal(r.text, '**abc**');
    });
});

describe('keyboard shortcuts', () => {
    test('Ctrl or Cmd + B, I, K', () => {
        assert.equal(shortcutFor({ ctrlKey: true, key: 'b' }), 'bold');
        assert.equal(shortcutFor({ metaKey: true, key: 'I' }), 'italic');
        assert.equal(shortcutFor({ ctrlKey: true, key: 'k' }), 'link');
    });
    test('nothing else is taken over', () => {
        assert.equal(shortcutFor({ key: 'b' }), null);
        assert.equal(shortcutFor({ ctrlKey: true, shiftKey: true, key: 'b' }), null);
        assert.equal(shortcutFor({ ctrlKey: true, altKey: true, key: 'b' }), null);
        assert.equal(shortcutFor({ ctrlKey: true, key: 'v' }), null);
        assert.equal(shortcutFor(null), null);
    });
});

describe('markup', () => {
    const html = composerHtml('<textarea id="t"></textarea>');
    test('every tool is a labelled type=button', () => {
        for (const t of TOOLS) {
            assert.ok(html.includes(`<button type="button" class="md-tool" data-md-format="${t.kind}" aria-label="${t.label}"`), t.kind);
        }
        assert.match(html, /role="toolbar" aria-label="Formatting"/);
        assert.match(html, /role="tablist"/);
        assert.match(html, /data-md-mode="write" aria-selected="true"/);
        assert.match(html, /data-md-mode="preview" aria-selected="false"/);
        assert.ok(html.includes('<textarea id="t"></textarea>'));
    });
    test('the help link opens a help article that exists, in a new tab (the draft stays)', () => {
        assert.match(html, new RegExp(`<a href="${HELP_HREF}" target="_blank" rel="noopener">Markdown supported</a>`));
        const slug = HELP_HREF.replace('/help/', '');
        const topic = HELP_TOPICS.find(t => t.slug === slug);
        assert.ok(topic, 'help article missing');
        assert.match(topic.body, /Markdown/);
        assert.match(readRepo('server.js', import.meta.url), new RegExp(`path: '${HELP_HREF}'`), 'sitemap entry');
    });
});

// ---- a small fake DOM ------------------------------------------------------

function el(attrs = {}) {
    const listeners = {};
    const classes = new Set();
    return {
        attrs, listeners, disabled: false, hidden: false, style: {}, innerHTML: '',
        classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: c => classes.has(c) },
        getAttribute: k => (k in attrs ? attrs[k] : null),
        setAttribute: (k, v) => { attrs[k] = String(v); },
        addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
        fire(type, extra = {}) {
            const e = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
            (listeners[type] || []).forEach(fn => fn(e));
            return e;
        }
    };
}
function textarea(value = '') {
    const ta = el();
    Object.assign(ta, {
        value, selectionStart: 0, selectionEnd: 0, focused: 0, inputs: 0,
        setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
        focus() { this.focused++; },
        dispatchEvent(e) { if (e.type === 'input') this.inputs++; return true; }
    });
    return ta;
}
function box(value) {
    const ta = textarea(value);
    const preview = el();
    preview.hidden = true;
    const tools = TOOLS.map(t => el({ 'data-md-format': t.kind }));
    const tabs = ['write', 'preview'].map(m => el({ 'data-md-mode': m }));
    const root = {
        querySelector: s => (s === 'textarea' ? ta : s === '.md-preview' ? preview : null),
        querySelectorAll: s => (s === '[data-md-format]' ? tools : s === '[data-md-mode]' ? tabs : [])
    };
    const tool = k => tools[TOOLS.findIndex(t => t.kind === k)];
    return { root, ta, preview, tools, tabs, tool };
}

describe('wireComposer', () => {
    test('a toolbar click formats the selection and keeps focus in the textarea', () => {
        const b = box('hello world');
        const h = wireComposer(b.root, { document: {} });
        b.ta.setSelectionRange(6, 11);
        const md = b.tool('bold').fire('mousedown');
        assert.equal(md.defaultPrevented, true, 'mousedown must not steal focus or the selection');
        b.tool('bold').fire('click');
        assert.equal(b.ta.value, 'hello **world**');
        assert.deepEqual([b.ta.selectionStart, b.ta.selectionEnd], [8, 13]);
        assert.ok(b.ta.focused >= 1);
        assert.equal(b.ta.inputs, 1, 'the character counter hears about the change');
        assert.equal(h.mode, 'write');
    });
    test('execCommand insertText is used when it works (keeps undo history)', () => {
        const b = box('ab');
        const calls = [];
        const doc = { execCommand(cmd, ui, text) {
            calls.push([cmd, text]);
            b.ta.value = b.ta.value.slice(0, b.ta.selectionStart) + text + b.ta.value.slice(b.ta.selectionEnd);
            return true;
        } };
        wireComposer(b.root, { document: doc });
        b.ta.setSelectionRange(0, 2);
        b.tool('italic').fire('click');
        assert.deepEqual(calls, [['insertText', '*ab*']]);
        assert.equal(b.ta.value, '*ab*');
        assert.equal(b.ta.inputs, 0, 'the browser fires input itself on this path');
    });
    test('a refused or partial execCommand falls back to setting the value', () => {
        const ta = textarea('ab');
        replaceRange(ta, { from: 0, to: 2, text: '**ab**', selStart: 2, selEnd: 4 }, { execCommand: () => { ta.value = '**a'; return true; } });
        assert.equal(ta.value, '**ab**');
        assert.deepEqual([ta.selectionStart, ta.selectionEnd], [2, 4]);
    });
    test('Ctrl+B / Cmd+K in the textarea', () => {
        const b = box('x');
        wireComposer(b.root, { document: {} });
        b.ta.setSelectionRange(0, 1);
        const e = b.ta.fire('keydown', { ctrlKey: true, key: 'b' });
        assert.equal(e.defaultPrevented, true);
        assert.equal(b.ta.value, '**x**');
        b.ta.setSelectionRange(7, 7);
        b.ta.fire('keydown', { metaKey: true, key: 'k' });
        assert.equal(b.ta.value, '**x**[link text](https://)');
        const plain = b.ta.fire('keydown', { key: 'b' });
        assert.equal(plain.defaultPrevented, false);
    });
    test('Preview renders with the same renderer the posts use', () => {
        const src = '# T\n**b** [l](https://a.com) <script>x</script> [i](/blocks)';
        const b = box(src);
        const h = wireComposer(b.root, { document: {} });
        b.tabs[1].fire('click');
        assert.equal(h.mode, 'preview');
        assert.equal(b.preview.innerHTML, renderMarkdown(src));
        assert.equal(b.preview.hidden, false);
        assert.equal(b.ta.style.display, 'none');
        assert.ok(b.tools.every(t => t.disabled), 'tools are off while previewing');
        assert.equal(b.tabs[1].getAttribute('aria-selected'), 'true');
        assert.equal(b.tabs[0].getAttribute('aria-selected'), 'false');
        // Formatting does nothing in preview.
        b.tool('bold').fire('click');
        assert.equal(b.ta.value, src);
        b.tabs[0].fire('click');
        assert.equal(h.mode, 'write');
        assert.equal(b.preview.hidden, true);
        assert.equal(b.ta.style.display, '');
        assert.ok(b.tools.every(t => !t.disabled));
        assert.ok(b.ta.focused >= 1, 'back in Write, focus returns to the textarea');
    });
    test('an empty draft previews as a note, not a blank box', () => {
        const b = box('   ');
        wireComposer(b.root, { document: {} });
        b.tabs[1].fire('click');
        assert.match(b.preview.innerHTML, /Nothing to preview/);
    });
    test('an internal link in the preview does not navigate away from the draft', () => {
        const b = box('x');
        wireComposer(b.root, { document: {} });
        const link = target => ({ getAttribute: k => (k === 'target' ? target : null) });
        const inside = (a) => b.preview.fire('click', { target: { closest: () => a } });
        assert.equal(inside(link(null)).defaultPrevented, true);
        assert.equal(inside(link('_blank')).defaultPrevented, false, 'external links open in a new tab as usual');
        assert.equal(inside(null).defaultPrevented, false);
    });
    test('a missing box or textarea is a no-op', () => {
        assert.equal(wireComposer(null), null);
        assert.equal(wireComposer({ querySelector: () => null, querySelectorAll: () => [] }), null);
    });
});

describe('every board gets the renderer and the composer', () => {
    const script = stripComments(readRepo('script.js', import.meta.url));
    const editLib = stripComments(readRepo('lib/discussion-edit.js', import.meta.url));
    test('posts render through renderMarkdown (thread pages and embedded boards share renderPostHtml)', () => {
        assert.match(editLib, /renderMarkdown\(p\.content, o\.md\)/);
        assert.ok(!/esc\(p\.content\)/.test(editLib), 'the old escape-and-<br> path is gone');
        assert.match(script, /loadThread: \(id, el, o\) => fetchDiscussionThread\(id, o\.focus, el, \{ embedded: true \}\)/);
    });
    test('the new-post box and the edit box both carry the composer', () => {
        assert.match(script, /composerHtml\('<textarea id="discuss-post-input"/);
        assert.match(script, /wireComposer\(root\.querySelector\('\.discussion-composer \.md-composer'\)\)/);
        assert.match(editLib, /form\.innerHTML = composerHtml\(/);
        assert.match(editLib, /wireComposer\(form\.querySelector\('\.md-composer'\), \{ render: src => renderMarkdown\(src, deps\.md\) \}\)/);
    });
    test('the raw text is what gets stored: no rendering on the way in', () => {
        const server = stripComments(readRepo('server.js', import.meta.url));
        assert.ok(!/discussion-markdown/.test(server));
        assert.ok(!/renderMarkdown/.test(editLib.slice(editLib.indexOf('export function applyEdit'), editLib.indexOf('export function renderPostHtml'))));
    });
    test('script.js stays under its line ceiling', () => {
        assert.ok(readRepo('script.js', import.meta.url).split('\n').length < 15000);
    });
});
