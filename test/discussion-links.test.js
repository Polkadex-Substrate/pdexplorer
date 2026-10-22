// Direct links to discussion posts (lib/discussion-links.js): permalink format,
// URL parsing, clipboard with fallback, inline feedback, scroll + highlight,
// and the missing-post notice. Small DOM fakes; the module takes its globals
// as arguments, so these run the real code.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    postPermalink, readLinkedPostId, renderCopyLinkButton, copyText, wirePermalinks, focusLinkedPost, LINKED_CLASS
} from '../lib/discussion-links.js';
import { renderPostHtml } from '../lib/discussion-edit.js';
import { readRepo, stripComments } from './helpers/source.js';

// ---- minimal DOM fakes ------------------------------------------------------
function el(tag, attrs = {}) {
    const e = {
        tagName: tag, attrs: { ...attrs }, children: [], classes: new Set(), style: {}, textContent: '', value: '',
        listeners: {}, scrolled: null, focused: null, nextElementSibling: null, parent: null,
        getAttribute: (k) => (k in e.attrs ? e.attrs[k] : null),
        setAttribute: (k, v) => { e.attrs[k] = String(v); },
        addEventListener: (t, fn) => { (e.listeners[t] = e.listeners[t] || []).push(fn); },
        classList: { add: (c) => e.classes.add(c), contains: (c) => e.classes.has(c) },
        scrollIntoView: (o) => { e.scrolled = o; },
        focus: (o) => { e.focused = o; },
        select: () => {},
        appendChild: (c) => { e.children.push(c); c.parent = e; return c; },
        removeChild: (c) => { e.children = e.children.filter(x => x !== c); c.parent = null; return c; },
        insertBefore: (c, ref) => { const i = ref ? e.children.indexOf(ref) : -1; if (i < 0) e.children.push(c); else e.children.splice(i, 0, c); c.parent = e; return c; },
        get firstChild() { return e.children[0] || null; },
        async click() { for (const fn of (e.listeners.click || [])) await fn(); }
    };
    return e;
}
// A thread root holding posts with the given ids, each with a Copy link button.
function threadRoot(ids) {
    const list = el('div', { class: 'discussion-posts' });
    const posts = ids.map(id => { const p = el('div', { 'data-post-id': String(id) }); list.appendChild(p); return p; });
    const buttons = ids.map(id => { const b = el('button', { 'data-copy-post': String(id) }); b.nextElementSibling = el('span'); return b; });
    const root = {
        list, posts, buttons,
        querySelector(sel) {
            if (sel === '.discussion-posts') return list;
            if (sel === '.discussion-link-missing') return list.children.find(c => c.className === 'discussion-link-missing') || null;
            const m = /data-post-id="(\d+)"/.exec(sel);
            return m ? posts.find(p => p.attrs['data-post-id'] === m[1]) || null : null;
        },
        querySelectorAll(sel) { return sel === '[data-copy-post]' ? buttons : []; }
    };
    return root;
}
function fakeDocument({ execOk = true, throws = false } = {}) {
    const body = el('body');
    const doc = { body, created: [], execCalls: 0, createElement: (t) => { const e = el(t); doc.created.push(e); return e; } };
    doc.execCommand = (cmd) => { doc.execCalls++; if (throws) throw new Error('nope'); return cmd === 'copy' && execOk; };
    return doc;
}
const nowTimers = () => { const t = { pending: [], setTimeout: (fn) => { t.pending.push(fn); return t.pending.length; }, clearTimeout: () => {} }; return t; };

describe('permalink format', () => {
    test('is the thread route plus ?post=<id>', () => {
        assert.equal(postPermalink('https://explorer.polkadex.ee', 'proposal-12', 34), 'https://explorer.polkadex.ee/discussions/proposal-12?post=34');
        assert.equal(postPermalink('https://x.test/', 'motion-0xab', '7'), 'https://x.test/discussions/motion-0xab?post=7');
    });
    test('thread ids are URL-encoded; bad post ids give no link', () => {
        assert.equal(postPermalink('', 'a b/c', 1), '/discussions/a%20b%2Fc?post=1');
        for (const bad of [0, -1, 1.5, 'x', null, undefined]) assert.equal(postPermalink('o', 't', bad), '');
        assert.equal(postPermalink('o', '', 1), '');
    });
    test('readLinkedPostId: ?post= first, #post- fallback, junk ignored', () => {
        assert.equal(readLinkedPostId('?post=34', ''), 34);
        assert.equal(readLinkedPostId('?x=1&post=5', '#post-9'), 5);
        assert.equal(readLinkedPostId('', '#post-9'), 9);
        for (const [s, h] of [['', ''], ['?post=', ''], ['?post=abc', ''], ['?post=-3', ''], ['?post=0', ''], ['?post=1e3', ''], ['', '#post-x'], ['', '#comments'], ['?post=1234567890123456', '']]) {
            assert.equal(readLinkedPostId(s, h), null, `${s} ${h}`);
        }
    });
});

describe('rendering', () => {
    test('every post carries id="post-<id>" and a Copy link button with a live region', () => {
        const html = renderPostHtml({ id: 41, author: 'eA', authorName: 'A', content: 'hi', createdAt: 1 },
            { esc: s => String(s), shortAddr: a => a, fmtDate: String, editable: false, actions: renderCopyLinkButton });
        assert.match(html, /id="post-41" data-post-id="41"/);
        assert.match(html, /data-copy-post="41"/);
        assert.match(html, /Copy link/);
        assert.match(html, /role="status" aria-live="polite"/);
        assert.equal(renderCopyLinkButton({ id: 'x"><script>' }), '', 'a non-numeric id renders nothing');
    });
    test('without actions the post renders exactly as before plus the id', () => {
        const html = renderPostHtml({ id: 2, author: 'eA', content: 'x', createdAt: 1 }, { esc: String, shortAddr: a => a, fmtDate: String });
        assert.doesNotMatch(html, /data-copy-post/);
    });
});

describe('copy to clipboard', () => {
    test('uses navigator.clipboard when it works', async () => {
        let got = null;
        const doc = fakeDocument();
        assert.equal(await copyText('L', { navigator: { clipboard: { writeText: async (t) => { got = t; } } }, document: doc }), true);
        assert.equal(got, 'L');
        assert.equal(doc.execCalls, 0);
    });
    test('falls back to a hidden textarea when the clipboard API refuses or is missing', async () => {
        const doc = fakeDocument();
        assert.equal(await copyText('L', { navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } } }, document: doc }), true);
        assert.equal(doc.execCalls, 1);
        assert.equal(doc.created[0].value, 'L');
        assert.equal(doc.body.children.length, 0, 'the textarea is removed again');
        assert.equal(await copyText('L', { navigator: {}, document: fakeDocument() }), true);
    });
    test('reports failure when nothing can copy', async () => {
        assert.equal(await copyText('L', { navigator: {}, document: fakeDocument({ execOk: false }) }), false);
        const d = fakeDocument({ throws: true });
        assert.equal(await copyText('L', { navigator: {}, document: d }), false);
        assert.equal(d.body.children.length, 0);
        assert.equal(await copyText('L', {}), false);
    });
});

describe('Copy link button', () => {
    test('copies the permalink and shows "Link copied" inline, then clears it', async () => {
        const root = threadRoot([5, 6]);
        let copied = null;
        const t = nowTimers();
        wirePermalinks(root, { threadId: 'proposal-3', origin: 'https://e.test', env: { navigator: { clipboard: { writeText: async (s) => { copied = s; } } } }, ...t });
        await root.buttons[1].click();
        assert.equal(copied, 'https://e.test/discussions/proposal-3?post=6');
        assert.equal(root.buttons[1].nextElementSibling.textContent, 'Link copied');
        assert.equal(root.buttons[0].nextElementSibling.textContent, '', 'only the clicked post shows feedback');
        t.pending.forEach(fn => fn());
        assert.equal(root.buttons[1].nextElementSibling.textContent, '');
    });
    test('when copying fails the link is shown for manual copy (no alert)', async () => {
        const root = threadRoot([5]);
        wirePermalinks(root, { threadId: 't', origin: 'https://e.test', env: { navigator: {}, document: fakeDocument({ execOk: false }) }, ...nowTimers() });
        await root.buttons[0].click();
        assert.equal(root.buttons[0].nextElementSibling.textContent, 'Copy this link: https://e.test/discussions/t?post=5');
    });
    test('the module never calls alert()', () => {
        assert.doesNotMatch(stripComments(readRepo('lib/discussion-links.js', import.meta.url)), /\balert\s*\(/);
    });
});

describe('opening a permalink', () => {
    test('scrolls to, focuses and highlights the linked post', () => {
        const root = threadRoot([1, 2, 3]);
        assert.equal(focusLinkedPost(root, 2, { document: fakeDocument() }), 'found');
        const p = root.posts[1];
        assert.ok(p.classes.has(LINKED_CLASS));
        assert.deepEqual(p.scrolled, { behavior: 'auto', block: 'center' });
        assert.deepEqual(p.focused, { preventScroll: true });
        assert.equal(p.attrs.tabindex, '-1');
        assert.ok(!root.posts[0].classes.has(LINKED_CLASS));
    });
    test('a deleted or wrong post id shows one notice at the top of the thread', () => {
        const root = threadRoot([1, 2]);
        const doc = fakeDocument();
        assert.equal(focusLinkedPost(root, 99, { document: doc }), 'missing');
        assert.equal(focusLinkedPost(root, 99, { document: doc }), 'missing');
        const notes = root.list.children.filter(c => c.className === 'discussion-link-missing');
        assert.equal(notes.length, 1);
        assert.equal(root.list.children[0], notes[0]);
        assert.match(notes[0].textContent, /#99/);
        assert.equal(notes[0].attrs.role, 'status');
    });
    test('no link in the URL is a no-op', () => {
        const root = threadRoot([1]);
        assert.equal(focusLinkedPost(root, null, { document: fakeDocument() }), 'none');
        assert.equal(root.list.children.length, 1);
    });
});

describe('script.js wiring', () => {
    const script = stripComments(readRepo('script.js', import.meta.url));
    test('imports the module and renders the button on every post', () => {
        assert.match(script, /import \{[^}]*focusLinkedPost[^}]*\} from '\.\/lib\/discussion-links\.js'/);
        assert.match(script, /actions: renderCopyLinkButton/);
        assert.match(script, /wirePermalinks\(root, \{ threadId: thread\.id/);
    });
    test('focus runs after the async thread fetch has rendered, on arrival only', () => {
        const fn = script.slice(script.indexOf('async function fetchDiscussionThread'), script.indexOf('function renderThread('));
        const renderAt = fn.indexOf('renderThread(data.thread');
        const focusAt = fn.indexOf('focusLinkedPost(');
        assert.ok(renderAt > 0 && focusAt > renderAt, 'focus must come after the posts are in the DOM');
        assert.match(fn, /if \(focusLink\) focusLinkedPost\(root, readLinkedPostId\(window\.location\.search, window\.location\.hash\)/);
        assert.match(script, /if \(threadId\) fetchDiscussionThread\(threadId, true\)/);
        // Re-renders after sign-in must not jump back to the linked post.
        assert.match(script, /if \(ok\) fetchDiscussionThread\(thread\.id\);/);
    });
    test('routeTo strips the query, so /discussions/<id>?post=N still routes to the thread', () => {
        assert.match(script, /const qIdx = target\.indexOf\('\?'\);\s*\n\s*if \(qIdx >= 0\) target = target\.substring\(0, qIdx\);/);
    });
    test('styles exist for the highlight and the missing notice', () => {
        const css = readRepo('styles.css', import.meta.url);
        assert.match(css, /\.discussion-post-linked\s*\{/);
        assert.match(css, /\.discussion-link-missing\s*\{/);
        assert.match(css, /prefers-reduced-motion: reduce\) \{ \.discussion-post-linked/);
    });
});
