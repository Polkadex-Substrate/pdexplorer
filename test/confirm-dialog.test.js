// The in-app confirm that replaces window.confirm for the unsent-text prompt:
// an alertdialog, focus trapped, Escape = cancel, answer as a promise.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createConfirmDialog } from '../lib/confirm-dialog.js';
import { El } from './helpers/mini-dom.js';

function fakeDoc() {
    const doc = new El('html');
    doc.body = new El('body'); doc.add(doc.body);
    doc.activeElement = null;
    doc.createElement = (tag) => {
        const e = new El(tag); e.ownerDoc = doc;
        e.appendChild = (c) => { c.ownerDoc = doc; return e.add(c); };
        e.remove = () => { if (e.parent) e.parent.children = e.parent.children.filter(c => c !== e); e.parent = null; };
        return e;
    };
    doc.body.appendChild = (c) => { c.ownerDoc = doc; return doc.body.add(c); };
    doc.contains = (o) => { for (let e = o; e; e = e.parent) if (e === doc) return true; return false; };
    return doc;
}
const open = (doc, msg = 'Close without sending?') => {
    const ask = createConfirmDialog(doc);
    const p = ask(msg);
    const dlg = doc.querySelector('[role="alertdialog"]');
    return { p, dlg, backdrop: dlg && dlg.parent };
};
const btn = (dlg, label) => dlg.querySelectorAll('button').find(b => b.attrs['data-confirm'] === label);

describe('the in-app confirm dialog', () => {
    test('is an accessible alertdialog carrying the message', () => {
        const doc = fakeDoc(); const { dlg } = open(doc, 'Hello there');
        assert.ok(dlg);
        assert.equal(dlg.getAttribute('aria-modal'), 'true');
        assert.ok(dlg.getAttribute('aria-labelledby') && dlg.getAttribute('aria-describedby'));
        const text = (e) => String(e.textContent || '') + e.children.map(text).join('');
        assert.ok(text(dlg).includes('Hello there'));
        assert.ok(!dlg.closest('.modal'), 'not a .modal: the global Esc handler must not treat it as one');
    });
    test('focus starts on the safe choice (keep editing), not on Discard', () => {
        const doc = fakeDoc(); const { dlg } = open(doc);
        assert.equal(doc.activeElement, btn(dlg, 'cancel'));
    });
    test('Discard answers true and removes the dialog; focus returns to the opener', async () => {
        const doc = fakeDoc(); const opener = doc.createElement('button'); doc.body.appendChild(opener); opener.focus();
        const { p, dlg } = open(doc);
        btn(dlg, 'confirm').click();
        assert.equal(await p, true);
        assert.equal(doc.querySelector('[role="alertdialog"]'), null);
        assert.equal(doc.activeElement, opener);
    });
    test('Keep editing answers false', async () => {
        const doc = fakeDoc(); const { p, dlg } = open(doc);
        btn(dlg, 'cancel').click();
        assert.equal(await p, false);
        assert.equal(doc.querySelector('[role="alertdialog"]'), null);
    });
    test('Escape cancels, and does not reach the page-level Escape handler', async () => {
        const doc = fakeDoc(); const { p, dlg } = open(doc);
        const ev = dlg.dispatch('keydown', { key: 'Escape' });
        assert.equal(await p, false);
        assert.equal(ev.defaultPrevented, true);
        assert.equal(ev.stopped, true);
    });
    test('Tab is trapped: forward from the last button wraps to the first, Shift+Tab from the first to the last', () => {
        const doc = fakeDoc(); const { dlg } = open(doc);
        const bs = dlg.querySelectorAll('button'); const first = bs[0]; const last = bs[bs.length - 1];
        last.focus(); let ev = dlg.dispatch('keydown', { key: 'Tab', shiftKey: false });
        assert.equal(ev.defaultPrevented, true); assert.equal(doc.activeElement, first);
        first.focus(); ev = dlg.dispatch('keydown', { key: 'Tab', shiftKey: true });
        assert.equal(ev.defaultPrevented, true); assert.equal(doc.activeElement, last);
    });
    test('a click on the backdrop cancels; a second ask while open shares the one dialog', async () => {
        const doc = fakeDoc(); const ask = createConfirmDialog(doc);
        const a = ask('x'); const b = ask('y');
        assert.equal(doc.querySelectorAll('[role="alertdialog"]').length, 1);
        doc.querySelector('[role="alertdialog"]').parent.click();
        assert.equal(await a, false); assert.equal(await b, false);
    });
});

describe('the confirm stacked over a .modal', () => {
    // A stand-in for script.js wireModalAccessibility: a page-level keydown
    // listener that traps Tab into the open .modal and closes it on Escape.
    function stacked() {
        const doc = fakeDoc();
        const modal = doc.createElement('div'); modal.setAttribute('class', 'modal');
        const field = doc.createElement('input'); modal.appendChild(field);
        doc.body.appendChild(modal);
        field.focus();
        const log = { modalCloses: 0, trapped: 0 };
        doc.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') { log.trapped++; e.preventDefault(); field.focus(); }
            else if (e.key === 'Escape') log.modalCloses++;
        });
        const ask = createConfirmDialog(doc);
        return { doc, modal, field, log, ask };
    }
    test('Tab inside the confirm never reaches the page-level trap and focus stays in the confirm', () => {
        const { doc, field, log, ask } = stacked();
        ask('x');
        const dlg = doc.querySelector('[role="alertdialog"]');
        const bs = dlg.querySelectorAll('button');
        for (const [from, shift, to] of [[bs[1], false, bs[0]], [bs[0], true, bs[1]], [bs[0], false, bs[0]]]) {
            from.focus();
            const ev = dlg.dispatch('keydown', { key: 'Tab', shiftKey: shift });
            assert.equal(ev.stopped, true);
        }
        assert.equal(log.trapped, 0, 'the modal trap must not see the confirm Tab');
        assert.notEqual(doc.activeElement, field);
        assert.ok(dlg.contains(doc.activeElement), 'focus is still inside the confirm');
    });
    test('Escape closes only the confirm; Discard then closes the dialog behind exactly once', async () => {
        const { doc, log, ask } = stacked();
        let discarded = 0;
        const close = async () => { if (await ask('unsent')) discarded++; };
        let p = close();
        let dlg = doc.querySelector('[role="alertdialog"]');
        dlg.dispatch('keydown', { key: 'Tab' });
        dlg.dispatch('keydown', { key: 'Escape' });
        await p;
        assert.equal(doc.querySelector('[role="alertdialog"]'), null);
        assert.equal(log.modalCloses, 0, 'Escape in the confirm does not also close the modal');
        assert.equal(discarded, 0);
        p = close();
        dlg = doc.querySelector('[role="alertdialog"]');
        dlg.dispatch('keydown', { key: 'Tab' });
        dlg.querySelectorAll('button').find(b => b.attrs['data-confirm'] === 'confirm').click();
        await p;
        assert.equal(discarded, 1);
        assert.equal(log.modalCloses, 0);
    });
});
