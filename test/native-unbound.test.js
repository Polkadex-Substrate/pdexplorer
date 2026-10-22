// Browser natives (fetch, timers, clipboard) throw "Illegal invocation" when
// called with a `this` that is not their owner (window / the Clipboard). Node's
// own fetch and plain test stubs do not care, which is how the discussion Save
// button shipped broken: script.js passed `fetchFn: fetch` and the module called
// `deps.fetchFn(...)`, so `this` was the options object. These tests use stubs
// that mimic the native check, and drive the code the way script.js wires it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wireEditing } from '../lib/discussion-edit.js';
import { wirePermalinks } from '../lib/discussion-links.js';
import { createDemocracyView } from '../lib/democracy-view.js';

const scriptSrc = readFileSync(new URL('../script.js', import.meta.url), 'utf8');

// A "window-bound" native: throws unless called bare (this is undefined in an
// ES module, or the global object) - exactly what Chrome does for fetch.
function nativeLike(name, impl) {
    return function (...args) {
        if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute '" + name + "' on 'Window': Illegal invocation");
        return impl(...args);
    };
}

// Minimal DOM, just enough for the editor.
function el(tag) {
    const e = {
        tag, children: [], style: {}, listeners: {}, attrs: {}, className: '', value: '', textContent: '', disabled: false, _inner: '', _q: {},
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
        getAttribute(k) { return this.attrs[k]; },
        appendChild(c) { this.children.push(c); this._form = c; return c; },
        remove() {}, focus() {},
        querySelector(sel) { return this._q[sel] || null; },
        async click() { for (const fn of this.listeners.click || []) await fn(); }
    };
    Object.defineProperty(e, 'innerHTML', { get() { return this._inner; }, set(v) {
        this._inner = v;
        if (this.className === 'discussion-edit-form') {
            this._q = { textarea: el('textarea'), '.discussion-edit-count': el('span'), '.discussion-edit-save': el('button'),
                '.discussion-edit-cancel': el('button'), '.discussion-edit-error': el('div') };
        }
    } });
    return e;
}
function editorWorld() {
    const body = el('div'); body.innerHTML = 'old';
    const wrap = el('div');
    wrap._q = { '.discussion-post-body': body };
    const origQ = wrap.querySelector.bind(wrap);
    wrap.querySelector = (sel) => (sel === '.discussion-edit-form' ? null : origQ(sel));
    const btn = el('button'); btn.attrs['data-edit-post'] = '7';
    const root = { querySelectorAll: () => [btn], querySelector: (sel) => (sel.includes('data-post-id="7"') ? wrap : null) };
    globalThis.document = { createElement: (t) => el(t) };
    return { root, btn, wrap };
}

// The exact fetchFn expression script.js passes, evaluated against a given fetch.
function scriptFetchFn(fetchImpl) {
    const m = /wireEditing\(root, \{[^}]*?fetchFn: (.+?), getSession/.exec(scriptSrc);
    assert.ok(m, 'wireEditing call not found in script.js');
    return new Function('fetch', 'return (' + m[1] + ');')(fetchImpl);
}

async function runSave(fetchFn) {
    const { root, btn, wrap } = editorWorld();
    const calls = []; let updated = null;
    wireEditing(root, {
        esc: String, fetchFn, getSession: () => ({ token: 'tok' }), clearSession() {}, threadId: 't1',
        posts: [{ id: 7, content: 'old text' }], onUpdated: (d) => { updated = d; }
    });
    await btn.click();
    const form = wrap._form;
    form._q.textarea.value = 'edited text';
    await form._q['.discussion-edit-save'].click();
    return { form, updated };
}

describe('discussion Save with a native-like fetch', () => {
    const mkFetch = (calls) => nativeLike('fetch', (url, init) => { calls.push([url, init]); return Promise.resolve({ ok: true, status: 200, json: async () => ({ thread: { id: 't1' }, posts: [] }) }); });

    test('wired exactly as script.js wires it, Save reaches fetch and succeeds', async () => {
        const calls = [];
        const { form, updated } = await runSave(scriptFetchFn(mkFetch(calls)));
        assert.equal(form._q['.discussion-edit-error'].textContent, '', 'no error shown');
        assert.equal(calls.length, 1);
        assert.equal(calls[0][1].method, 'PATCH');
        assert.ok(updated, 'onUpdated called');
    });
    test('the module alone is safe even if the caller passes the bare native', async () => {
        const calls = [];
        const { form, updated } = await runSave(mkFetch(calls));
        assert.equal(form._q['.discussion-edit-error'].textContent, '');
        assert.equal(calls.length, 1);
        assert.ok(updated);
    });
    test('the stub really does reject a method-style call (the stub itself is honest)', () => {
        const f = nativeLike('fetch', () => 1);
        assert.throws(() => ({ f }).f(), /Illegal invocation/);
        assert.equal(f(), 1);
    });
});

describe('copy link with a native-like clipboard', () => {
    test('writeText is called on the clipboard object and the link is copied', async () => {
        let copied = null;
        const clipboard = { writeText(s) { if (this !== clipboard) throw new TypeError('Illegal invocation'); copied = s; return Promise.resolve(); } };
        const fb = { textContent: '', style: {} };
        const btn = { listeners: [], getAttribute: () => '5', nextElementSibling: fb, addEventListener(_, fn) { this.listeners.push(fn); } };
        const root = { querySelectorAll: () => [btn] };
        // Timers as the page supplies them: none, so the module's own defaults are used.
        wirePermalinks(root, { threadId: 't', origin: 'https://e.test', env: { navigator: { clipboard } } });
        await btn.listeners[0]();
        assert.equal(copied, 'https://e.test/discussions/t?post=5');
        assert.equal(fb.textContent, 'Link copied');
    });
});

describe('Democracy view default timers with native-like globals', () => {
    test('start and stop do not call the timers as methods of a plain object', () => {
        const real = { si: globalThis.setInterval, ci: globalThis.clearInterval, st: globalThis.setTimeout, ct: globalThis.clearTimeout };
        const ids = new Set();
        globalThis.setInterval = nativeLike('setInterval', () => { ids.add(1); return 1; });
        globalThis.clearInterval = nativeLike('clearInterval', () => { ids.delete(1); });
        globalThis.setTimeout = nativeLike('setTimeout', () => 2);
        globalThis.clearTimeout = nativeLike('clearTimeout', () => {});
        try {
            const view = createDemocracyView({ getApi: () => null, account: () => 'e', toAddress: (a) => a, getRest: () => ({}), tab: () => 'referenda',
                extra: () => '', root: () => null, renderFull() {}, refresh() {}, helpers: {}, visible: () => true });
            view.start();
            assert.equal(view.active(), true);
            view.stop();
            assert.equal(ids.size, 0);
        } finally {
            globalThis.setInterval = real.si; globalThis.clearInterval = real.ci; globalThis.setTimeout = real.st; globalThis.clearTimeout = real.ct;
        }
    });
});
