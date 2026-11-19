// Paste and Clear on the validator pages (origin/main 9df2ee1 brought in the Validate
// area: the status lookup, the session keys checker, Check my node and the setup wizard).
//
// What is pinned here, on top of test/input-actions.test.js:
//   - data-amount-strict: the bond, extra bond and commission fields take a paste only
//     when it is already a plain number. Nothing is reinterpreted ("1,000" is not quietly
//     made 1000, "150 PDEX" is not quietly made 150), and a value that reads two ways
//     ("1,000", "1.000", "150.500": a decimal mark or a thousands mark) is refused.
//   - a field with the hidden attribute (the setup wizard's payee account, shown only
//     when "another account" is chosen) hides its wrapper too, so the buttons never
//     float next to nothing; un-hiding brings them back.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { cleanPaste, enhanceInputActions, startInputActionsObserver, MESSAGES } from '../lib/input-actions.js';

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

function page(t, { html = '', clipboard = 'clip' } = {}) {
    const window = new Window({ url: 'https://explorer.test/', width: 1280, height: 900,
        settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    t.after(() => window.happyDOM.close());
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    let clip = clipboard;
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { readText: async () => clip } });
    const doc = window.document;
    doc.body.innerHTML = html;
    const events = [];
    for (const type of ['input', 'change']) doc.addEventListener(type, (e) => events.push(`${type}:${e.target.id}`), true);
    return { window, doc, events, $: (s) => doc.querySelector(s), setClipboard: (v) => { clip = v; } };
}
const pasteBtn = (el) => el.closest('.ia-wrap').querySelector('.ia-paste');

describe('cleanPaste strict amounts: accepted only when already plain', () => {
    for (const [input, out] of [['1000', '1000'], [' 1000.5\n', '1000.5'], ['0.125', '0.125'], ['7.5', '7.5'], ['123', '123'], ['1000.000', '1000.000'], ['​42', '42']]) {
        test(`${JSON.stringify(input)} gives ${out}`, () => assert.deepEqual(cleanPaste('amount', input, { strict: true }), { ok: true, value: out }));
    }
    for (const two of ['1,000', '1.000', '150.500', '12,500', '999.999']) {
        test(`${JSON.stringify(two)} reads two ways: refused with the ambiguity message`, () => {
            assert.deepEqual(cleanPaste('amount', two, { strict: true }), { ok: false, message: MESSAGES.amountAmbiguous });
        });
    }
    for (const bad of ['150 PDEX', 'PDEX 10', '1 000', '1_000', '12,250,870', '1,234.56', '1.234,56', '1,5', '5%', '-1', '1e5', '.5', '5.', 'abc']) {
        test(`${JSON.stringify(bad)} would need reinterpreting: refused with the plain-number message`, () => {
            assert.deepEqual(cleanPaste('amount', bad, { strict: true }), { ok: false, message: MESSAGES.amountStrict });
        });
    }
    test('the messages say what to do and differ from the general amount message', () => {
        assert.equal(MESSAGES.amountStrict, 'Paste a plain number, like 150 or 150.5, or type it in.');
        assert.equal(MESSAGES.amountAmbiguous, 'That number could be read as a decimal or as thousands. Type it in.');
    });
    test('without strict the general rules are unchanged', () => {
        assert.deepEqual(cleanPaste('amount', '1,000'), { ok: true, value: '1000' });
        assert.deepEqual(cleanPaste('amount', '150 PDEX'), { ok: true, value: '150' });
    });
});

describe('data-amount-strict in the page', () => {
    test('"1,000" is not pasted into a strict field: untouched, hint shown, no events', async (t) => {
        const p = page(t, { html: '<input id="bond" type="text" data-input-kind="amount" data-amount-strict value="5">', clipboard: '1,000' });
        enhanceInputActions(p.doc.body);
        pasteBtn(p.$('#bond')).click(); await settle();
        assert.equal(p.$('#bond').value, '5');
        assert.deepEqual(p.events, []);
        assert.equal(p.$('#bond').closest('.ia-wrap').querySelector('.ia-hint').textContent, MESSAGES.amountAmbiguous);
    });
    test('"150 PDEX" is refused in a strict field, accepted as 150 in a plain amount field', async (t) => {
        const p = page(t, { html: '<input id="c" data-input-kind="amount" data-amount-strict><input id="s" data-input-kind="amount">', clipboard: '150 PDEX' });
        enhanceInputActions(p.doc.body);
        pasteBtn(p.$('#c')).click(); await settle();
        pasteBtn(p.$('#s')).click(); await settle();
        assert.equal(p.$('#c').value, '');
        assert.equal(p.$('#s').value, '150');
    });
    test('a plain number lands and fires input then change', async (t) => {
        const p = page(t, { html: '<input id="bond" data-input-kind="amount" data-amount-strict>', clipboard: ' 1500.25 ' });
        enhanceInputActions(p.doc.body);
        pasteBtn(p.$('#bond')).click(); await settle();
        assert.equal(p.$('#bond').value, '1500.25');
        assert.deepEqual(p.events, ['input:bond', 'change:bond']);
    });
});

describe('a hidden field hides its buttons', () => {
    test('enhanced while hidden: the wrapper is hidden; un-hidden and enhanced again: shown with Paste', (t) => {
        const p = page(t, { html: '<input id="payee" type="text" data-input-kind="address" hidden>' });
        enhanceInputActions(p.doc.body);
        const f = p.$('#payee');
        const wrap = f.closest('.ia-wrap');
        assert.ok(wrap, 'still enhanced, so it is ready when shown');
        assert.equal(wrap.hidden, true);
        f.removeAttribute('hidden');
        enhanceInputActions(p.doc.body);
        assert.equal(wrap.hidden, false);
        assert.ok(pasteBtn(f) && !pasteBtn(f).hidden);
        f.setAttribute('hidden', '');
        enhanceInputActions(p.doc.body);
        assert.equal(wrap.hidden, true);
    });
    test('the observer follows the hidden attribute without a call', async (t) => {
        const p = page(t, { html: '<input id="payee" type="text" data-input-kind="address" hidden>' });
        startInputActionsObserver(p.doc);
        const f = p.$('#payee');
        assert.equal(f.closest('.ia-wrap').hidden, true);
        f.removeAttribute('hidden'); await tick(40);
        assert.equal(f.closest('.ia-wrap').hidden, false);
        f.setAttribute('hidden', ''); await tick(40);
        assert.equal(f.closest('.ia-wrap').hidden, true);
    });
    test('a hidden field ignores a stale Paste click', async (t) => {
        const p = page(t, { html: '<input id="payee" type="text" data-input-kind="address">', clipboard: 'esX' });
        enhanceInputActions(p.doc.body);
        const f = p.$('#payee');
        const btn = pasteBtn(f);
        f.setAttribute('hidden', '');
        btn.click(); await settle();
        assert.equal(f.value, '');
    });
});

describe('stylesheet', () => {
    test('a hidden wrapper stays hidden over its inline display', async () => {
        const { readRepo } = await import('./helpers/source.js');
        const css = readRepo('styles.css', import.meta.url);
        assert.match(css, /\.ia-wrap\[hidden\] \{ display: none !important; \}/);
    });
});
