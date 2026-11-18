// Paste and Clear inside every text box: the shared component lib/input-actions.js
// (CEO request, 2026-11-17; spec cto-team/plans/2026-11-17-input-paste-clear.md).
//
// Rules under test:
//   - Clear (bx-x, only while the field has text) and Paste (bx-paste) are real
//     type="button" buttons with exact aria-labels, out of the tab order;
//   - after either action focus is in the field, `input` then `change` fire on it, and
//     nothing is submitted;
//   - paste cleans the clipboard text by data-input-kind, and an amount it cannot read
//     for certain ("1,5") is refused, never guessed;
//   - no Paste button where the browser cannot read the clipboard; a blocked read shows
//     an inline hint, never alert(); a denied permission hides Paste for the session;
//   - textareas get their buttons above the field, and a long draft is confirmed first;
//   - readonly, disabled and opted-out fields get nothing.
// Addresses here are made-up strings: no real account appears in this file.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { readRepo } from './helpers/source.js';
import {
    cleanPaste, inputActionsMode, isTextLike, INPUT_KINDS,
    enhanceInputActions, syncInputActions, startInputActionsObserver
} from '../lib/input-actions.js';

const AMOUNT_MSG = 'That does not look like an amount. Type it in.';
const ADDR = 'esFAKE' + 'x'.repeat(42);   // the right length, not an address of anyone
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

// ── pure functions ──

describe('cleanPaste per kind', () => {
    const ok = (kind, text, opts) => { const r = cleanPaste(kind, text, opts); assert.equal(r.ok, true, JSON.stringify(r)); return r.value; };

    test('address: whitespace, line breaks, zero-width characters and wrapping quotes go', () => {
        assert.equal(ok('address', `  ${ADDR.slice(0, 10)} ${ADDR.slice(10)}\n`), ADDR);
        assert.equal(ok('address', `​${ADDR}﻿\r\n`), ADDR);
        assert.equal(ok('address', `"${ADDR}"`), ADDR);
        assert.equal(ok('address', `'${ADDR}'`), ADDR);
    });
    test('hex: whitespace, line breaks and quotes go, 0x is never added or removed', () => {
        assert.equal(ok('hex', '"0xab cd\nef"'), '0xabcdef');
        assert.equal(ok('hex', 'abcd\r\n12'), 'abcd12');
        assert.equal(ok('hex', ' 0xAB​12 '), '0xAB12');
    });
    test('address-list: commas, spaces and mixed line endings become one address per line', () => {
        assert.equal(ok('address-list', 'esA1, esB2 esC3\r\nesD4\resE5\n\n,esF6', { multiline: true }), 'esA1\nesB2\nesC3\nesD4\nesE5\nesF6');
        assert.equal(ok('address-list', '"esA1"\n​esB2', { multiline: true }), 'esA1\nesB2');
    });
    test('integer: whitespace, thousands commas and a leading # go', () => {
        assert.equal(ok('integer', '12,250,870'), '12250870');
        assert.equal(ok('integer', '#123'), '123');
        assert.equal(ok('integer', ' 12 250 870 \n'), '12250870');
    });
    test('ref: a hash is cleaned as hex, a number as an integer', () => {
        assert.equal(ok('ref', ' 0xab cd\n'), '0xabcd');
        assert.equal(ok('ref', '#12,250,870'), '12250870');
    });
    test('search and code are only trimmed (and a single line never gets a line break)', () => {
        assert.equal(ok('search', '  hello  world  '), 'hello  world');
        assert.equal(ok('code', '  [1, 2]\n'), '[1, 2]');
        assert.equal(ok('code', '[1,\n2]'), '[1, 2]');
    });
    test('text: a single line turns line breaks into spaces and trims; a textarea is untouched', () => {
        assert.equal(ok('text', ' one\ntwo\r\nthree '), 'one two three');
        assert.equal(ok('text', ' one\ntwo  ', { multiline: true }), ' one\ntwo  ');
    });
    test('an empty clipboard and an oversized one are refused', () => {
        assert.deepEqual(cleanPaste('text', ''), { ok: false, message: 'Nothing to paste.' });
        assert.deepEqual(cleanPaste('address', '  \n '), { ok: false, message: 'Nothing to paste.' });
        const big = cleanPaste('text', 'x'.repeat(100001), { multiline: true });
        assert.equal(big.ok, false);
        assert.match(big.message, /too long/);
        assert.equal(cleanPaste('text', 'x'.repeat(100000), { multiline: true }).ok, true);
    });
});

describe('cleanPaste: amounts are money, so nothing is guessed', () => {
    const cases = [['1,000', '1000'], ['1,234.56', '1234.56'], ['1.234,56', '1234.56'], ['1 000,5 PDEX', '1000.5'],
        ['12,250,870', '12250870'], ['0.5', '0.5'], ['PDEX 10', '10'], ['1 000.25', '1000.25'], ['1 000', '1000'],
        ['1_000', '1000'], ['  42 pdex ', '42']];
    for (const [input, out] of cases) {
        test(`${JSON.stringify(input)} gives ${out}`, () => assert.deepEqual(cleanPaste('amount', input), { ok: true, value: out }));
    }
    for (const bad of ['1,5', '-1', '1e5', 'abc', '0,500', '1.234.567', '1 5', '1,00', '.5', '5.', '1,2.3']) {
        test(`${JSON.stringify(bad)} is refused with the amount message`, () => {
            assert.deepEqual(cleanPaste('amount', bad), { ok: false, message: AMOUNT_MSG });
        });
    }
});

describe('cleanPaste: maxlength', () => {
    test('text is cut to fit and the note carries the number', () => {
        const r = cleanPaste('text', 'x'.repeat(40), { maxLength: 32, multiline: true });
        assert.equal(r.ok, true);
        assert.equal(r.value, 'x'.repeat(32));
        assert.equal(r.note, 'Pasted text was cut to 32 characters.');
    });
    test('text inserted into existing text is cut to the room left', () => {
        const r = cleanPaste('text', 'abcdef', { maxLength: 10, room: 4, multiline: true });
        assert.equal(r.value, 'abcd');
        assert.match(r.note, /10 characters/);
    });
    test('a single-line text field refuses an over-long paste, it is never cut', () => {
        const r = cleanPaste('text', 'x'.repeat(40), { maxLength: 32 });
        assert.equal(r.ok, false);
        assert.match(r.message, /32 characters/);
        assert.equal(cleanPaste('text', 'abcdef', { maxLength: 10, room: 4 }).ok, false);
        assert.equal(cleanPaste('search', 'x'.repeat(40), { maxLength: 32 }).ok, false);
        assert.equal(cleanPaste(undefined, 'x'.repeat(40), { maxLength: 32 }).ok, false);
    });
    test('an address over the limit is refused, not cut', () => {
        const r = cleanPaste('address', ADDR, { maxLength: 20 });
        assert.equal(r.ok, false);
        assert.match(r.message, /20 characters/);
    });
    test('within the limit there is no note', () => {
        assert.deepEqual(cleanPaste('text', 'short', { maxLength: 32 }), { ok: true, value: 'short' });
    });
});

describe('inputActionsMode', () => {
    const a = (extra = {}) => ({ tag: 'INPUT', type: 'text', disabled: false, readOnly: false, optOut: null, actions: null, ...extra });
    test('both by default, compact under 200 px, clear only under 96 px', () => {
        assert.equal(inputActionsMode(a(), 400, true), 'both');
        assert.equal(inputActionsMode(a(), 0, true), 'both', 'unmeasured: decided again when it has a width');
        assert.equal(inputActionsMode(a(), 199, true), 'compact');
        assert.equal(inputActionsMode(a(), 200, true), 'both');
        assert.equal(inputActionsMode(a(), 95, true), 'clear');
    });
    test('clear only when the clipboard cannot be read, or the markup asks for it', () => {
        assert.equal(inputActionsMode(a(), 400, false), 'clear');
        assert.equal(inputActionsMode(a({ actions: 'clear' }), 400, true), 'clear');
        assert.equal(inputActionsMode(a({ actions: 'compact' }), 400, true), 'compact');
    });
    test('none for disabled, readonly, opted-out and non-text fields', () => {
        assert.equal(inputActionsMode(a({ disabled: true }), 400, true), 'none');
        assert.equal(inputActionsMode(a({ readOnly: true }), 400, true), 'none');
        assert.equal(inputActionsMode(a({ optOut: 'numeric stepper' }), 400, true), 'none');
        assert.equal(inputActionsMode(a({ type: 'checkbox' }), 400, true), 'none');
        assert.equal(inputActionsMode(a({ type: 'range' }), 400, true), 'none');
        assert.equal(inputActionsMode(a({ tag: 'TEXTAREA', type: 'textarea' }), 400, true), 'both');
    });
    test('the kinds are the spec list', () => {
        assert.deepEqual([...INPUT_KINDS], ['address', 'address-list', 'amount', 'integer', 'ref', 'hex', 'search', 'code', 'text']);
        assert.equal(isTextLike('INPUT', 'number'), true);
    });
});

// ── the DOM component ──

// A browser page. clipboard: a string to read, an Error to reject with, or null for no API.
function page(t, { html = '', clipboard = 'clip', secure = true, permission, coarse = false, platform } = {}) {
    const window = new Window({ url: 'https://explorer.test/', width: 1280, height: 900,
        settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    t.after(() => window.happyDOM.close());
    Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true });
    const reads = { n: 0 };
    let clip = clipboard;
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true,
        value: clip === null ? undefined : { readText: async () => { reads.n++; if (clip instanceof Error) throw clip; return clip; } } });
    if (permission !== undefined) Object.defineProperty(window.navigator, 'permissions', { configurable: true, value: { query: async () => ({ state: permission }) } });
    if (platform) Object.defineProperty(window.navigator, 'platform', { configurable: true, value: platform });
    if (coarse) window.matchMedia = (q) => ({ matches: /coarse/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
    const alerts = [];
    window.alert = (m) => alerts.push(m);
    const doc = window.document;
    doc.body.innerHTML = html;
    const events = [];
    for (const type of ['input', 'change', 'submit', 'keydown', 'keyup']) doc.addEventListener(type, (e) => events.push(`${type}:${e.target.id || e.target.tagName}`), true);
    return { window, doc, reads, alerts, events, $: (s) => doc.querySelector(s), $$: (s) => Array.from(doc.querySelectorAll(s)),
        setClipboard: (v) => { clip = v; } };
}
const blocked = () => Object.assign(new Error('Read permission denied.'), { name: 'NotAllowedError' });
const btns = (el) => { const w = el.closest('.ia-wrap'); return w ? Array.from(w.querySelectorAll('.ia-btn')) : []; };
const pasteBtn = (el) => btns(el).find(b => b.classList.contains('ia-paste'));
const clearBtn = (el) => btns(el).find(b => b.classList.contains('ia-clear'));
const visible = (b) => !!b && !b.hidden;
function typeInto(p, el, v) { el.value = v; el.dispatchEvent(new p.window.Event('input', { bubbles: true })); }

describe('markup and accessibility', () => {
    test('two real buttons, type=button, out of the tab order, exact labels, Boxicons, icons hidden from screen readers', (t) => {
        const p = page(t, { html: '<input type="text" id="f" data-input-kind="address">' });
        enhanceInputActions(p.doc.body);
        const f = p.$('#f');
        const b = btns(f);
        assert.equal(b.length, 2);
        const [clear, paste] = b;
        assert.ok(clear.classList.contains('ia-clear'), 'Clear sits to the left of Paste');
        assert.ok(paste.classList.contains('ia-paste'));
        for (const x of b) {
            assert.equal(x.tagName, 'BUTTON');
            assert.equal(x.getAttribute('type'), 'button');
            assert.equal(x.getAttribute('tabindex'), '-1');
            assert.equal(x.getAttribute('title'), x.getAttribute('aria-label'));
            const i = x.querySelector('i');
            assert.equal(i.getAttribute('aria-hidden'), 'true');
            assert.equal(x.textContent.trim(), '', 'the name comes from aria-label, not text');
        }
        assert.equal(paste.getAttribute('aria-label'), 'Paste from clipboard');
        assert.equal(clear.getAttribute('aria-label'), 'Clear');
        assert.ok(paste.querySelector('i').classList.contains('bx-paste'));
        assert.ok(clear.querySelector('i').classList.contains('bx-x'));
        assert.equal(f.getAttribute('data-ia'), 'both');
    });

    test('a label-wrapped field is named by its label text, never "Clear" or "Paste"', (t) => {
        const p = page(t, { html: '<label class="cs-field"><span>At block <em>optional</em></span> <input id="f" type="text" data-input-kind="ref"></label>'
            + '<label>Named <input id="g" type="text" aria-label="Own name" data-input-kind="text"></label>' });
        enhanceInputActions(p.doc.body);
        assert.equal(p.$('#f').getAttribute('aria-label'), 'At block optional');
        assert.equal(p.$('#g').getAttribute('aria-label'), 'Own name', 'an existing name is kept');
        assert.equal(btns(p.$('#f')).length, 2);
    });

    test('one shared polite live region announces the result', async (t) => {
        const p = page(t, { html: '<input id="a" data-input-kind="search"><input id="b" data-input-kind="search">', clipboard: 'blocks' });
        enhanceInputActions(p.doc.body);
        pasteBtn(p.$('#a')).click(); await settle();
        pasteBtn(p.$('#b')).click(); await settle();
        const live = p.$$('[aria-live="polite"].ia-live');
        assert.equal(live.length, 1);
        assert.equal(live[0].textContent, 'Pasted');
        clearBtn(p.$('#b')).click(); await settle();
        assert.equal(live[0].textContent, 'Cleared');
    });

    test('pressing a button does not take focus from the field (mousedown and pointerdown are cancelled)', (t) => {
        const p = page(t, { html: '<input id="f" data-input-kind="text">' });
        enhanceInputActions(p.doc.body);
        for (const type of ['mousedown', 'pointerdown']) {
            const ev = new p.window.Event(type, { bubbles: true, cancelable: true });
            pasteBtn(p.$('#f')).dispatchEvent(ev);
            assert.equal(ev.defaultPrevented, true, type);
        }
    });
});

describe('Clear', () => {
    test('hidden while empty, shown once there is text, hidden again after clearing; focus stays in the field', async (t) => {
        const p = page(t, { html: '<input id="f" data-input-kind="search">' });
        enhanceInputActions(p.doc.body);
        const f = p.$('#f');
        assert.equal(visible(clearBtn(f)), false);
        assert.equal(visible(pasteBtn(f)), true);
        typeInto(p, f, 'abc');
        assert.equal(visible(clearBtn(f)), true);
        p.events.length = 0;
        clearBtn(f).click(); await settle();
        assert.equal(f.value, '');
        assert.equal(visible(clearBtn(f)), false);
        assert.equal(p.doc.activeElement, f);
        assert.deepEqual(p.events, ['input:f', 'change:f']);
    });

    test('a value set by code (a Max button) is noticed on focus, pointerover, a click anywhere, or syncInputActions', async (t) => {
        const p = page(t, { html: '<input id="f" type="number" data-input-kind="amount"><button id="max" type="button">Max</button>' });
        enhanceInputActions(p.doc.body);
        startInputActionsObserver(p.doc);
        const f = p.$('#f');
        f.value = '12';
        syncInputActions(f);
        assert.equal(visible(clearBtn(f)), true);
        f.value = '';
        f.closest('.ia-wrap').dispatchEvent(new p.window.Event('pointerover', { bubbles: true }));
        assert.equal(visible(clearBtn(f)), false);
        p.$('#max').addEventListener('click', () => { f.value = '99'; });
        p.$('#max').click(); await tick(40);
        assert.equal(visible(clearBtn(f)), true);
    });

    test('a textarea draft over 200 characters is confirmed first; "Keep writing" keeps it', async (t) => {
        const p = page(t, { html: '<textarea id="d" data-input-kind="text"></textarea>' });
        enhanceInputActions(p.doc.body);
        const d = p.$('#d');
        typeInto(p, d, 'w'.repeat(201));
        clearBtn(d).click(); await settle();
        const dialog = p.$('.confirm-dialog');
        assert.ok(dialog, 'the in-app confirm opened');
        assert.equal(dialog.querySelector('h2').textContent, 'Clear this draft?');
        assert.equal(p.$('[data-confirm="confirm"]').textContent, 'Clear');
        assert.equal(p.$('[data-confirm="cancel"]').textContent, 'Keep writing');
        p.$('[data-confirm="cancel"]').click(); await settle();
        assert.equal(d.value.length, 201);
        clearBtn(d).click(); await settle();
        p.$('[data-confirm="confirm"]').click(); await settle();
        assert.equal(d.value, '');
        assert.equal(p.doc.activeElement, d);
    });

    test('a short textarea, and a long address list, clear at once', async (t) => {
        const p = page(t, { html: '<textarea id="d" data-input-kind="text"></textarea><textarea id="s" data-input-kind="address-list"></textarea>' });
        enhanceInputActions(p.doc.body);
        typeInto(p, p.$('#d'), 'w'.repeat(200));
        clearBtn(p.$('#d')).click(); await settle();
        assert.equal(p.$('#d').value, '');
        typeInto(p, p.$('#s'), 'esA\n'.repeat(80));
        clearBtn(p.$('#s')).click(); await settle();
        assert.equal(p.$('#s').value, '');
        assert.equal(p.$('.confirm-dialog'), null);
    });
});

describe('Paste', () => {
    test('sets the cleaned value, fires input then change (bubbling), focuses the field, submits nothing', async (t) => {
        const p = page(t, { html: '<form id="form"><input id="f" type="text" data-input-kind="address"><button type="submit">Go</button></form>', clipboard: ` ${ADDR}\n` });
        let submitted = 0;
        p.$('#form').addEventListener('submit', (e) => { submitted++; e.preventDefault(); });
        const seen = [];
        p.$('#form').addEventListener('input', (e) => seen.push(['input', e.bubbles, e.inputType]));
        p.$('#form').addEventListener('change', (e) => seen.push(['change', e.bubbles]));
        enhanceInputActions(p.doc.body);
        const f = p.$('#f');
        pasteBtn(f).click(); await settle();
        assert.equal(f.value, ADDR);
        assert.deepEqual(seen, [['input', true, 'insertFromPaste'], ['change', true]]);
        assert.deepEqual(p.events, ['input:f', 'change:f'], 'no keydown, no submit');
        assert.equal(submitted, 0);
        assert.equal(p.doc.activeElement, f);
        assert.equal(f.selectionStart, ADDR.length, 'caret at the end of the pasted text');
        assert.equal(visible(clearBtn(f)), true);
    });

    test('replaces a wrong address in one tap', async (t) => {
        const p = page(t, { html: `<input id="f" data-input-kind="address" value="esWRONG">`, clipboard: ADDR });
        enhanceInputActions(p.doc.body);
        pasteBtn(p.$('#f')).click(); await settle();
        assert.equal(p.$('#f').value, ADDR);
    });

    test('an amount it cannot read for certain is not pasted: field untouched, hint shown, no events', async (t) => {
        const p = page(t, { html: '<input id="f" type="number" data-input-kind="amount" value="3">', clipboard: '1,5' });
        enhanceInputActions(p.doc.body);
        const f = p.$('#f');
        pasteBtn(f).click(); await settle();
        assert.equal(f.value, '3');
        assert.deepEqual(p.events, []);
        assert.equal(f.closest('.ia-wrap').querySelector('.ia-hint').textContent, AMOUNT_MSG);
        assert.equal(p.$('.ia-live').textContent, AMOUNT_MSG);
        assert.equal(p.doc.activeElement, f);
    });

    test('an amount with thousands separators lands as a plain number', async (t) => {
        const p = page(t, { html: '<input id="f" type="number" data-input-kind="amount">', clipboard: '1,234.56 PDEX' });
        enhanceInputActions(p.doc.body);
        pasteBtn(p.$('#f')).click(); await settle();
        assert.equal(p.$('#f').value, '1234.56');
    });

    test('text is inserted at the caret, replacing the selection', async (t) => {
        const p = page(t, { html: '<input id="f" type="text" data-input-kind="text" value="hello world">', clipboard: 'there' });
        enhanceInputActions(p.doc.body);
        const f = p.$('#f');
        f.focus(); f.setSelectionRange(6, 11);
        pasteBtn(f).click(); await settle();
        assert.equal(f.value, 'hello there');
        assert.equal(f.selectionStart, 11);
    });

    test('a long paste into a 32-character text area is cut, and the hint says so', async (t) => {
        const p = page(t, { html: '<textarea id="f" maxlength="32" data-input-kind="text"></textarea>', clipboard: 'y'.repeat(40) });
        enhanceInputActions(p.doc.body);
        const f = p.$('#f');
        pasteBtn(f).click(); await settle();
        assert.equal(f.value, 'y'.repeat(32));
        assert.equal(f.closest('.ia-wrap').querySelector('.ia-hint').textContent, 'Pasted text was cut to 32 characters.');
    });

    test('an address list appends on a new line when the field already has addresses', async (t) => {
        const p = page(t, { html: '<textarea id="s" data-input-kind="address-list">esA1</textarea>', clipboard: 'esB2, esC3' });
        enhanceInputActions(p.doc.body);
        pasteBtn(p.$('#s')).click(); await settle();
        assert.equal(p.$('#s').value, 'esA1\nesB2\nesC3');
    });

    test('an address list that already ends in a line break gets no blank line between', async (t) => {
        const p = page(t, { html: '<textarea id="s" data-input-kind="address-list">esA1\n</textarea>', clipboard: 'esB2' });
        enhanceInputActions(p.doc.body);
        pasteBtn(p.$('#s')).click(); await settle();
        assert.equal(p.$('#s').value, 'esA1\nesB2');
    });

    test('text pasted into the middle of a near-full text area is cut to the room left, caret after the piece', async (t) => {
        const p = page(t, { html: '<textarea id="f" maxlength="10" data-input-kind="text">abcdefgh</textarea>', clipboard: 'XYZ123' });
        enhanceInputActions(p.doc.body);
        const f = p.$('#f');
        f.focus(); f.setSelectionRange(3, 3);
        pasteBtn(f).click(); await settle();
        assert.equal(f.value, 'abcXYdefgh');
        assert.equal(f.selectionStart, 5);
        assert.match(f.closest('.ia-wrap').querySelector('.ia-hint').textContent, /cut to 10 characters/);
    });

    test('a text field already full refuses a paste with the limit named', async (t) => {
        const p = page(t, { html: '<input id="f" type="text" maxlength="4" data-input-kind="text" value="abcd">', clipboard: 'zz' });
        enhanceInputActions(p.doc.body);
        const f = p.$('#f');
        f.focus(); f.setSelectionRange(4, 4);
        pasteBtn(f).click(); await settle();
        assert.equal(f.value, 'abcd');
        assert.match(f.closest('.ia-wrap').querySelector('.ia-hint').textContent, /longer than this field allows \(4 characters\)/);
    });

    test('an empty clipboard says so and leaves the field alone', async (t) => {
        const p = page(t, { html: '<input id="f" data-input-kind="search" value="keep">', clipboard: '' });
        enhanceInputActions(p.doc.body);
        pasteBtn(p.$('#f')).click(); await settle();
        assert.equal(p.$('#f').value, 'keep');
        assert.equal(p.$('.ia-hint').textContent, 'Nothing to paste.');
    });

    test('the clipboard is read only when Paste is pressed', async (t) => {
        const p = page(t, { html: '<input id="f" data-input-kind="search">' });
        enhanceInputActions(p.doc.body);
        const f = p.$('#f');
        f.focus(); f.closest('.ia-wrap').dispatchEvent(new p.window.Event('pointerover', { bubbles: true }));
        await settle();
        assert.equal(p.reads.n, 0);
        pasteBtn(f).click(); await settle();
        assert.equal(p.reads.n, 1);
    });

    test('a field replaced by its own input handler (data tables): focus lands on the replacement, which has buttons too', async (t) => {
        const p = page(t, { html: '<div id="table"><div class="table-filter-bar"><input type="text" class="table-col-filter" data-col="who" data-input-kind="search"></div></div>', clipboard: 'alice' });
        const table = p.$('#table');
        table.addEventListener('input', (e) => {
            const v = e.target.value;
            table.innerHTML = `<div class="table-filter-bar"><input type="text" class="table-col-filter" data-col="who" data-input-kind="search" value="${v}"></div>`;
        });
        enhanceInputActions(p.doc.body);
        pasteBtn(p.$('.table-col-filter')).click(); await settle();
        const now = p.$('.table-col-filter');
        assert.equal(now.value, 'alice');
        assert.equal(p.doc.activeElement, now);
        assert.equal(btns(now).length, 2);
    });
});

describe('clipboard blocked or missing', () => {
    test('a rejected read leaves the value, shows the Ctrl+V hint inline, never calls alert(), focuses the field', async (t) => {
        const p = page(t, { html: '<input id="f" data-input-kind="address" value="esKEEP">', clipboard: blocked(), platform: 'Win32' });
        enhanceInputActions(p.doc.body);
        const f = p.$('#f');
        pasteBtn(f).click(); await settle();
        assert.equal(f.value, 'esKEEP');
        assert.deepEqual(p.alerts, []);
        assert.equal(f.closest('.ia-wrap').querySelector('.ia-hint').textContent, 'Clipboard is blocked. Press Ctrl+V to paste.');
        assert.equal(p.doc.activeElement, f);
        assert.equal(visible(pasteBtn(f)), true, 'the permission was not reported denied: keep the button');
    });

    test('the hint says Cmd+V on a Mac, and press-and-hold on a touch screen', async (t) => {
        const mac = page(t, { html: '<input id="f" data-input-kind="text">', clipboard: blocked(), platform: 'MacIntel' });
        enhanceInputActions(mac.doc.body);
        pasteBtn(mac.$('#f')).click(); await settle();
        assert.equal(mac.$('.ia-hint').textContent, 'Clipboard is blocked. Press Cmd+V to paste.');
        const phone = page(t, { html: '<input id="f" data-input-kind="text">', clipboard: blocked(), coarse: true });
        enhanceInputActions(phone.doc.body);
        pasteBtn(phone.$('#f')).click(); await settle();
        assert.equal(phone.$('.ia-hint').textContent, 'Clipboard is blocked. Press and hold the field, then tap Paste.');
    });

    test('the hint goes away after 6 seconds', async (t) => {
        const p = page(t, { html: '<input id="f" data-input-kind="text">', clipboard: blocked() });
        enhanceInputActions(p.doc.body);
        pasteBtn(p.$('#f')).click(); await settle();
        assert.ok(p.$('.ia-hint'));
        await tick(6100);
        assert.equal(p.$('.ia-hint'), null);
    });

    test('permission reported denied: every Paste button goes for the session, Clear stays', async (t) => {
        const p = page(t, { html: '<input id="a" data-input-kind="text"><input id="b" data-input-kind="address">', clipboard: blocked(), permission: 'denied' });
        enhanceInputActions(p.doc.body);
        pasteBtn(p.$('#a')).click(); await settle();
        assert.equal(pasteBtn(p.$('#a')), undefined);
        assert.equal(pasteBtn(p.$('#b')), undefined);
        assert.ok(clearBtn(p.$('#b')));
        assert.equal(p.$('#b').getAttribute('data-ia'), 'clear', 'the reserved padding drops to one slot');
        p.doc.body.insertAdjacentHTML('beforeend', '<input id="c" data-input-kind="text">');
        enhanceInputActions(p.doc.body);
        assert.equal(pasteBtn(p.$('#c')), undefined, 'and stays gone for fields added later');
    });

    test('no clipboard API, or not a secure context: no Paste button at all, Clear still works', (t) => {
        for (const opts of [{ clipboard: null }, { secure: false }]) {
            const p = page(t, { html: '<input id="f" data-input-kind="address">', ...opts });
            enhanceInputActions(p.doc.body);
            const f = p.$('#f');
            assert.equal(pasteBtn(f), undefined, JSON.stringify(opts));
            assert.ok(clearBtn(f));
            assert.equal(f.getAttribute('data-ia'), 'clear');
        }
    });
});

describe('which fields get what', () => {
    test('readonly, disabled, opted-out and non-text fields get nothing', (t) => {
        const p = page(t, { html: '<input id="ro" readonly value="x"><input id="dis" disabled data-input-kind="text">'
            + '<input id="out" type="number" data-no-input-actions="numeric stepper"><input id="cb" type="checkbox">'
            + '<input id="rg" type="range"><input id="hid" type="hidden"><textarea id="rota" readonly></textarea>' });
        enhanceInputActions(p.doc.body);
        assert.equal(p.$$('.ia-wrap').length, 0);
        assert.equal(p.$$('.ia-btn').length, 0);
    });

    test('disabled toggled on then off: buttons removed, then restored (the observer watches)', async (t) => {
        const p = page(t, { html: '<input id="f" data-input-kind="amount">' });
        startInputActionsObserver(p.doc);
        const f = p.$('#f');
        assert.equal(btns(f).length, 2);
        f.setAttribute('disabled', '');
        await tick(40);
        assert.equal(btns(f).length, 0);
        assert.equal(f.getAttribute('data-ia'), 'none');
        f.removeAttribute('disabled');
        await tick(40);
        assert.equal(btns(f).length, 2);
    });

    test('a readonly field that becomes editable is enhanced then', async (t) => {
        const p = page(t, { html: '<input id="f" readonly data-input-kind="text">' });
        startInputActionsObserver(p.doc);
        assert.equal(btns(p.$('#f')).length, 0);
        p.$('#f').removeAttribute('readonly');
        await tick(40);
        assert.equal(btns(p.$('#f')).length, 2);
    });

    test('fields rendered later get buttons (MutationObserver); a temporary copy buffer does not', async (t) => {
        const p = page(t, { html: '<div id="host"></div>' });
        startInputActionsObserver(p.doc);
        p.$('#host').innerHTML = '<label>Name <input name="name" data-input-kind="text"></label>';
        const ta = p.doc.createElement('textarea');
        ta.setAttribute('data-no-input-actions', 'temporary copy buffer');
        p.doc.body.appendChild(ta);
        await tick(40);
        assert.equal(btns(p.$('[name="name"]')).length, 2);
        assert.equal(ta.closest('.ia-wrap'), null);
    });

    test('compact: one slot, Paste while empty and Clear while filled', (t) => {
        const p = page(t, { html: '<input id="f" data-input-kind="search" data-input-actions="compact">' });
        enhanceInputActions(p.doc.body);
        const f = p.$('#f');
        assert.equal(f.getAttribute('data-ia'), 'compact');
        assert.deepEqual([visible(clearBtn(f)), visible(pasteBtn(f))], [false, true]);
        typeInto(p, f, 'x');
        assert.deepEqual([visible(clearBtn(f)), visible(pasteBtn(f))], [true, false]);
    });

    test('a field narrower than 200 px is compact, narrower than 96 px is clear only', (t) => {
        const p = page(t, { html: '<input id="n" data-input-kind="search"><input id="m" data-input-kind="search">' });
        p.$('#n').getBoundingClientRect = () => ({ width: 150, height: 30, top: 0, left: 0, right: 150, bottom: 30 });
        p.$('#m').getBoundingClientRect = () => ({ width: 80, height: 30, top: 0, left: 0, right: 80, bottom: 30 });
        enhanceInputActions(p.doc.body);
        assert.equal(p.$('#n').getAttribute('data-ia'), 'compact');
        assert.equal(p.$('#m').getAttribute('data-ia'), 'clear');
    });

    test('the clear-only filter (data-input-actions="clear") has no Paste', (t) => {
        const p = page(t, { html: '<input id="f" type="number" data-f="minSelfStake" data-input-kind="amount" data-input-actions="clear">' });
        enhanceInputActions(p.doc.body);
        assert.equal(pasteBtn(p.$('#f')), undefined);
        assert.ok(clearBtn(p.$('#f')));
    });

    test('a textarea gets its buttons in a row above the field', (t) => {
        const p = page(t, { html: '<textarea id="d" data-input-kind="hex"></textarea>' });
        enhanceInputActions(p.doc.body);
        const d = p.$('#d');
        const wrap = d.closest('.ia-wrap');
        const row = wrap.querySelector('.ia-actions');
        assert.ok(row.classList.contains('ia-actions-top'));
        assert.equal(row.nextElementSibling, d, 'the row comes before the textarea');
    });

    test('the discussion composer: buttons mount at the end of the Markdown toolbar as md-tool buttons', (t) => {
        const p = page(t, { html: '<div class="md-composer"><div class="md-composer-bar"><div class="md-toolbar"><button type="button" class="md-tool" data-md-format="bold"></button></div></div>'
            + '<textarea id="d" data-input-kind="text" data-input-actions-mount=".md-toolbar"></textarea></div>' });
        enhanceInputActions(p.doc.body);
        const bar = p.$('.md-toolbar');
        const group = bar.lastElementChild;
        assert.ok(group.classList.contains('ia-actions-toolbar'));
        const b = Array.from(group.querySelectorAll('button'));
        assert.equal(b.length, 2);
        assert.ok(b.every(x => x.classList.contains('md-tool') && !x.hasAttribute('data-md-format')));
    });

    test('enhancing twice is a no-op; enhancing a focused field keeps focus and caret', (t) => {
        const p = page(t, { html: '<input id="f" data-input-kind="text" value="abcdef">' });
        const f = p.$('#f');
        f.focus(); f.setSelectionRange(2, 4);
        enhanceInputActions(p.doc.body);
        enhanceInputActions(p.doc.body);
        assert.equal(p.$$('.ia-wrap').length, 1);
        assert.equal(btns(f).length, 2);
        assert.equal(p.doc.activeElement, f);
        assert.deepEqual([f.selectionStart, f.selectionEnd], [2, 4]);
    });

    test('no layout shift: inline width and margins move to the wrapper, the field fills it', (t) => {
        const p = page(t, { html: '<div><input id="f" data-input-kind="text" style="width: 100%; margin-bottom: 12px; padding: 12px;"></div>'
            + '<div style="display:grid;grid-template-columns:1fr 100px"><input id="g" data-input-kind="address" style="padding:8px"></div>'
            + '<div style="display:flex"><input id="h" data-input-kind="text" style="flex:1;min-width:220px"></div>' });
        enhanceInputActions(p.doc.body);
        const f = p.$('#f'), wf = f.closest('.ia-wrap');
        assert.equal(wf.style.width, '100%');
        assert.equal(wf.style.marginBottom, '12px');
        assert.equal(f.style.width, '100%');
        assert.equal(f.style.marginBottom, '0px');
        assert.equal(p.$('#g').style.width, '100%', 'a grid cell is filled');
        const wh = p.$('#h').closest('.ia-wrap');
        assert.equal(wh.style.flexGrow, '1');
        assert.equal(wh.style.minWidth, '220px');
        assert.equal(p.$('#h').style.width, '100%');
    });
});

describe('styles (styles.css, the .ia- block)', () => {
    const CSS = readRepo('styles.css', import.meta.url);
    const start = CSS.indexOf('/* --- Paste and Clear inside text boxes');
    const block = start >= 0 ? CSS.slice(start, CSS.indexOf('/* --- end Paste and Clear', start)) : '';
    test('the block exists', () => assert.ok(block.length > 200, 'no .ia- block in styles.css'));
    test('28 px buttons, 16 px icons, 4 px gap, 6 px inset, secondary text colour at rest', () => {
        assert.match(block, /\.ia-actions \.ia-btn \{[^}]*width: 28px;[^}]*height: 28px;/);
        assert.match(block, /\.ia-actions \.ia-btn \{[^}]*color: var\(--text-secondary\);/);
        assert.match(block, /\.ia-actions \.ia-btn i \{[^}]*font-size: 16px;/);
        assert.match(block, /\.ia-actions \{[^}]*gap: 4px;/);
        assert.match(block, /\.ia-actions \{[^}]*right: 6px;/);
    });
    test('padding is reserved from the first paint: 72 / 40 px, and 88 / 48 px on touch', () => {
        assert.match(block, /input\[data-ia="both"\] \{ padding-right: 72px !important; \}/);
        assert.match(block, /input\[data-ia="compact"\], \.ia-wrap > input\[data-ia="clear"\] \{ padding-right: 40px !important; \}/);
        const coarse = block.slice(block.indexOf('@media (pointer: coarse)'));
        assert.match(coarse, /padding-right: 88px !important/);
        assert.match(coarse, /padding-right: 48px !important/);
    });
    test('touch: 36 px wide and a 44 px tall hit area that does not grow the field', () => {
        const coarse = block.slice(block.indexOf('@media (pointer: coarse)'));
        assert.match(coarse, /\.ia-actions \.ia-btn \{ width: 36px; \}/);
        assert.match(coarse, /\.ia-actions \.ia-btn::after \{[^}]*inset: -8px 0;/);
    });
    test('tokens only: no hex colours, no brand fill, no green; hover and focus as specified', () => {
        assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/);
        assert.doesNotMatch(block, /background(-color)?:\s*var\(--brand-primary\)/);
        assert.doesNotMatch(block, /green|--success|--positive|0, ?200, ?83|76, ?175, ?80/i);
        assert.match(block, /:hover[\s\S]*?color: var\(--text-primary\);[^}]*background: rgba\(255, 255, 255, 0\.06\);/);
        assert.match(block, /:focus-visible \{[^}]*var\(--brand-primary-glow\)/);
        assert.match(block, /transition: color var\(--transition-fast\), background-color var\(--transition-fast\);/);
    });
    test('no second X in search fields, no spinner under the buttons, steppers keep theirs', () => {
        assert.match(block, /::-webkit-search-cancel-button/);
        assert.match(block, /input\[type="number"\]:not\(\[data-ia="none"\]\)::-webkit-inner-spin-button/);
        assert.match(block, /appearance: textfield;/);
    });
    test('hidden buttons stay hidden whatever the surrounding button rules say', () => {
        assert.match(block, /\.ia-actions \.ia-btn\[hidden\][^{]*\{ display: none !important; \}/);
    });
});
