// Review findings on Paste and Clear (Fable review of feat/input-paste-clear):
// composer Preview mode, touch padding per button count, table re-render timing,
// hint wrapping, bidi marks, and the execCommand focus rule.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { readRepo } from './helpers/source.js';
import { cleanPaste, enhanceInputActions } from '../lib/input-actions.js';
import { composerHtml, wireComposer } from '../lib/discussion-composer.js';

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
function page(t, html, clipboard = 'clip') {
    const window = new Window({ url: 'https://explorer.test/', width: 1280, height: 900,
        settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    t.after(() => window.happyDOM.close());
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { readText: async () => clipboard } });
    window.document.body.innerHTML = html;
    return { window, doc: window.document, $: s => window.document.querySelector(s), $$: s => Array.from(window.document.querySelectorAll(s)) };
}

describe('finding 1: composer Preview mode', () => {
    const mk = (t) => {
        const p = page(t, composerHtml('<textarea id="d" data-input-kind="text" data-input-actions-mount=".md-toolbar">a short draft</textarea>'));
        enhanceInputActions(p.doc.body);
        const h = wireComposer(p.$('.md-composer'), { document: p.doc, render: s => `<p>${s}</p>` });
        return { p, h };
    };
    test('Paste and Clear are disabled and out of view in Preview, and back in Write', async (t) => {
        const { p, h } = mk(t);
        const group = p.$('.ia-actions-toolbar');
        h.setMode('preview');
        const b = p.$$('.ia-actions-toolbar .ia-btn');
        assert.equal(b.length, 2);
        assert.ok(b.every(x => x.disabled), 'both disabled');
        assert.equal(group.hidden, true);
        p.$('.ia-clear').click(); p.$('.ia-paste').click(); await settle();
        assert.equal(p.$('#d').value, 'a short draft', 'Clear never wipes the draft behind the preview');
        h.setMode('write');
        assert.ok(p.$$('.ia-actions-toolbar .ia-btn').every(x => !x.disabled));
        assert.equal(group.hidden, false);
    });
    test('a hidden field ignores Clear and Paste even if a click arrives', async (t) => {
        const p = page(t, '<textarea id="d" data-input-kind="text">keep me</textarea>');
        enhanceInputActions(p.doc.body);
        p.$('#d').style.display = 'none';
        p.$('.ia-clear').click(); p.$('.ia-paste').click(); await settle();
        assert.equal(p.$('#d').value, 'keep me');
    });
});

describe('findings 2 and 4: stylesheet', () => {
    const css = readRepo('styles.css', import.meta.url);
    const coarse = css.slice(css.indexOf('@media (pointer: coarse)', css.indexOf('--- Paste and Clear')));
    test('on touch the table filter bar pads per button count (two buttons need 72px)', () => {
        assert.match(coarse, /\.table-filter-bar \.ia-wrap > input\[data-ia="both"\] \{ padding-right: 72px !important; \}/);
        assert.match(coarse, /\.table-filter-bar \.ia-wrap > input\[data-ia="(compact|clear)"\][^{]*\{ padding-right: 40px !important; \}/);
        assert.doesNotMatch(coarse, /\.table-filter-bar \.ia-wrap > input\[data-ia\] \{/);
    });
    test('the hint wraps instead of overflowing a narrow screen', () => {
        const m = css.match(/\.ia-hint \{[^}]*\}/);
        assert.ok(m);
        assert.doesNotMatch(m[0], /nowrap/);
        assert.match(m[0], /white-space: normal/);
        assert.match(m[0], /right: 0/);
    });
});

describe('finding 3: table re-render', () => {
    const script = readRepo('script.js', import.meta.url);
    test('render() adds the buttons in the same tick, before focus is restored', () => {
        assert.match(script, /import \{[^}]*enhanceInputActions[^}]*\} from '\.\/lib\/input-actions\.js'/);
        const i = script.indexOf('enhanceInputActions(container);');
        const j = script.indexOf('restoreFocus(focusSnap);');
        assert.ok(i > 0 && j > i, 'enhanceInputActions(container) runs before restoreFocus(focusSnap)');
    });
    test('enhancing a freshly rendered container is synchronous and keeps the focused input', (t) => {
        const p = page(t, '<div id="c"><input class="table-global-search" data-input-kind="search" value="ab"></div>');
        const c = p.$('#c');
        const f = p.$('.table-global-search');
        f.focus(); f.setSelectionRange(1, 1);
        enhanceInputActions(c);
        assert.equal(c.querySelectorAll('.ia-btn').length, 2, 'buttons exist without waiting a frame');
        assert.equal(p.doc.activeElement, f);
        assert.equal(f.selectionStart, 1);
    });
});

describe('finding 5: refuse, not cut, outside free-text areas', () => {
    test('an identity or single-line field refuses; a text area may be cut', () => {
        for (const k of ['address', 'hex', 'amount', 'ref', 'code', 'search', 'text', 'integer']) {
            assert.equal(cleanPaste(k, '1'.repeat(40), { maxLength: 10 }).ok, false, k);
        }
        const r = cleanPaste('text', 'x'.repeat(40), { maxLength: 10, multiline: true });
        assert.equal(r.ok, true);
        assert.equal(r.value.length, 10);
        assert.equal(r.note, 'Pasted text was cut to 10 characters.');
    });
});

describe('finding 6: execCommand only on the focused field', () => {
    test('an unfocused field is set directly and execCommand is not called', async (t) => {
        const p = page(t, '<input id="f" data-input-kind="address" value="old"><input id="g">', 'new');
        enhanceInputActions(p.doc.body);
        let calls = 0;
        p.doc.execCommand = () => { calls++; return true; };
        const f = p.$('#f');
        f.focus = () => {};            // focusing is refused here, so the field is not active
        p.$('#g').focus();
        const seen = [];
        f.addEventListener('input', () => seen.push(f.value));
        p.$('#f').closest('.ia-wrap').querySelector('.ia-paste').click(); await settle();
        assert.equal(calls, 0);
        assert.equal(f.value, 'new');
        assert.equal(seen.length, 1, 'input still fires once');
    });
});

describe('finding 7: bidirectional control marks', () => {
    const bidi = '‎‏‪‫‬‭‮⁦⁧⁨⁩';
    test('stripped from address, hex, amount and ref pastes', () => {
        assert.equal(cleanPaste('address', `${bidi}esABC${bidi}DEF`).value, 'esABCDEF');
        assert.equal(cleanPaste('hex', `0x${bidi}ab12`).value, '0xab12');
        assert.equal(cleanPaste('amount', `${bidi}12.5${bidi}`).value, '12.5');
        assert.equal(cleanPaste('ref', `0x${bidi}ab12`).value, '0xab12');
        assert.equal(cleanPaste('address-list', `es1${bidi}\nes2`, { multiline: true }).value, 'es1\nes2');
    });
    test('a paste of only marks counts as empty', () => {
        assert.equal(cleanPaste('address', bidi).ok, false);
    });
});
