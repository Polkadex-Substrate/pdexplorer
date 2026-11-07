// One close control for every inner page and dialog (CEO request: "extend the
// close button in all the newly created inner pages, especially the governance
// pages, wallet connect etc.").
//
// Rules under test:
//   - pages "close" to history.back() when this tab's SPA made a previous entry,
//     else to the page's parent route (deep links, new tabs);
//   - dialogs close, Esc included, and focus goes back to what opened them;
//   - unsent text is never discarded silently (confirm first);
//   - a dialog with a transaction in flight hides, nothing is cancelled: the
//     tx-status card keeps tracking.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    govParentRoute, closeControlHtml, resolveClose, closeToParent, decideClose, isDirty, isPending,
    clearDrafts, wireCloseControls, closeDialogElement, onDialogKeydown, createFocusReturn
} from '../lib/close-control.js';
import { renderGovDetailSummary, renderNotFound } from '../lib/gov-detail-view.js';
import { escapeHtml } from '../lib/html-escape.js';
import { stripComments } from './helpers/source.js';
import { El, makeDoc, field } from './helpers/mini-dom.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const INDEX = read('index.html');
const SCRIPT = read('script.js');
const CSS = read('styles.css');
const h = { esc: escapeHtml, num: String, pdex: String, shortAddr: (a) => String(a).slice(0, 6), fmtDate: (ms) => `T${ms}` };
const M1 = '0x' + 'aa'.repeat(32);

describe('the shared markup', () => {
    test('a page control is a real button labelled Close with the existing X icon', () => {
        const html = closeControlHtml({ parent: 'democracy' });
        assert.match(html, /^<button type="button"/);
        assert.ok(html.includes('aria-label="Close"'));
        assert.ok(html.includes('class="close-control'));
        assert.ok(html.includes("bx bx-x"));
        assert.ok(html.includes('data-close-detail="democracy"'));
        assert.ok(!html.includes('<a '), 'not a link to #');
    });
    test('a dialog control carries data-modal-close, which Esc and the guard look for', () => {
        const html = closeControlHtml({ dialog: true });
        assert.ok(html.includes('data-modal-close') && html.includes('aria-label="Close"'));
        assert.ok(!html.includes('data-close-detail'));
    });
    test('the parent route is escaped into the attribute', () => {
        assert.ok(!closeControlHtml({ parent: '"><img>' }).includes('<img>'));
    });
    test('the touch target is 44px for the shared class, .modal-close-btn and every dialog X', () => {
        const rule = (re) => { const m = re.exec(CSS); assert.ok(m, String(re)); return m[0]; };
        assert.match(rule(/\.close-control\s*\{[^}]*\}/), /min-width:\s*44px[^}]*min-height:\s*44px|min-height:\s*44px[^}]*min-width:\s*44px/);
        assert.match(CSS, /\.modal \[data-modal-close\][^{]*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/);
        assert.match(CSS, /\.modal-close-btn[^{]*\{[^}]*min-width:\s*44px/);
    });
});

describe('where a page closes to', () => {
    test('governance item kinds map to their list', () => {
        assert.equal(govParentRoute('referendum'), 'democracy');
        assert.equal(govParentRoute('proposal'), 'democracy');
        assert.equal(govParentRoute('external'), 'democracy');
        assert.equal(govParentRoute('motion', 'council'), 'council');
        assert.equal(govParentRoute('motion', 'technicalCommittee'), 'council');
        assert.equal(govParentRoute('nonsense'), 'home');
        assert.equal(govParentRoute(undefined), 'home');
    });
    test('history.back() when the SPA pushed an entry in this tab, the parent for deep links', () => {
        assert.deepEqual(resolveClose(2, 'council'), { action: 'back', depth: 2 });   // popstate, not the close, takes the entry off
        assert.deepEqual(resolveClose(1, 'council'), { action: 'back', depth: 1 });
        assert.deepEqual(resolveClose(0, 'council'), { action: 'navigate', to: 'council', depth: 0 });
    });
    test('an empty parent falls back to home and the depth never goes negative', () => {
        assert.deepEqual(resolveClose(0, ''), { action: 'navigate', to: 'home', depth: 0 });
        assert.deepEqual(resolveClose(-3, 'x'), { action: 'navigate', to: 'x', depth: 0 });
    });
    test('closeToParent performs the move and returns the new depth', () => {
        const calls = [];
        const deps = { back: () => calls.push('back'), navigate: (p) => calls.push('nav:' + p) };
        assert.equal(closeToParent({ depth: 3, parent: 'democracy', ...deps }), 3);
        assert.equal(closeToParent({ depth: 0, parent: 'democracy', ...deps }), 0);
        assert.deepEqual(calls, ['back', 'nav:democracy']);
    });
});

describe('the discard guard', () => {
    test('clean: closes without asking', () => {
        let asked = 0;
        assert.deepEqual(decideClose({ dirty: false, pending: false, confirmFn: () => { asked++; return false; } }), { close: true, reason: 'clean' });
        assert.equal(asked, 0);
    });
    test('a draft asks first; declining keeps the dialog, accepting closes', () => {
        const msgs = [];
        assert.deepEqual(decideClose({ dirty: true, pending: false, confirmFn: (m) => { msgs.push(m); return false; } }), { close: false, reason: 'kept' });
        assert.deepEqual(decideClose({ dirty: true, pending: false, confirmFn: () => true }), { close: true, reason: 'confirmed' });
        assert.match(msgs[0], /discard/i);
    });
    test('a transaction in flight closes without asking: the text was sent and the card keeps tracking', () => {
        let asked = 0;
        assert.deepEqual(decideClose({ dirty: true, pending: true, confirmFn: () => { asked++; return false; } }), { close: true, reason: 'pending' });
        assert.equal(asked, 0);
    });
    test('isDirty counts only text the user typed and that is still there', () => {
        const typed = field('hello');
        const root = new El('div', {}, [typed, field('prefilled by code'), field('', { type: 'text' })]);
        assert.equal(isDirty(root), false, 'programmatic values are not drafts');
        typed.dispatchTouch = null;
        const doc = makeDoc(root);
        wireCloseControls(doc, { getDepth: () => 0, setDepth() {}, back() {}, navigate() {}, confirmFn: () => true });
        typed.dispatch('input');
        assert.equal(isDirty(root), true);
        typed.value = '   ';
        assert.equal(isDirty(root), false, 'whitespace only is not a draft');
        typed.value = 'again';
        typed.readOnly = true;
        assert.equal(isDirty(root), false, 'read-only fields are not input');
        typed.readOnly = false; typed.type = 'checkbox';
        assert.equal(isDirty(root), false);
    });
    test('isPending sees a busy submit button; clearDrafts forgets edits', () => {
        const btn = new El('button', { 'aria-busy': 'true' });
        assert.equal(isPending(new El('div', {}, [btn])), true);
        assert.equal(isPending(new El('div', {}, [new El('button')])), false);
        const t = field('x'); const root = new El('div', {}, [t]);
        const doc = makeDoc(root);
        wireCloseControls(doc, { getDepth: () => 0, setDepth() {}, back() {}, navigate() {}, confirmFn: () => true });
        t.dispatch('input');
        assert.equal(isDirty(root), true);
        clearDrafts(root);
        assert.equal(isDirty(root), false);
    });
});

function world({ depth = 0, confirmAnswer = true } = {}) {
    const log = { back: 0, nav: [], asked: [], depth };
    const ctl = new El('button', { 'aria-label': 'Close', 'data-close-detail': 'discussions' });
    const area = field('draft text', { id: 'discuss-post-input' });
    const page = new El('div', { class: 'page-section' }, [ctl, area]);
    const dlgClose = new El('button', { 'aria-label': 'Close', 'data-modal-close': '' });
    const dlgField = field('', { id: 'send-amount', tag: 'input' });
    const dlgSubmit = new El('button', { class: 'modal-submit-btn' });
    const dlg = new El('div', { class: 'modal', id: 'send-modal' }, [new El('div', {}, [dlgClose, dlgField, dlgSubmit])]);
    dlg.style.display = 'flex';
    const doc = makeDoc(page, dlg);
    let hid = 0;
    dlgClose.addEventListener('click', () => { hid++; dlg.style.display = 'none'; });
    wireCloseControls(doc, {
        getDepth: () => log.depth, setDepth: (d) => { log.depth = d; },
        back: () => { log.back++; }, navigate: (p) => log.nav.push(p),
        confirmFn: (m) => { log.asked.push(m); return confirmAnswer; }
    });
    const popstate = () => { log.depth = Math.max(0, log.depth - 1); };
    return { popstate, log, ctl, area, page, dlg, dlgClose, dlgField, dlgSubmit, doc, hidden: () => hid };
}

describe('wired behaviour', () => {
    test('clicking a page control goes back when there is a previous SPA entry', () => {
        const w = world({ depth: 2 });
        const ev = w.ctl.click();
        assert.equal(w.log.back, 1); assert.deepEqual(w.log.nav, []); assert.equal(w.log.depth, 2, 'popstate owns the decrement');
        assert.equal(ev.defaultPrevented, true);
    });
    test('a deep link (no previous entry) goes to the parent route', () => {
        const w = world({ depth: 0 });
        w.ctl.click();
        assert.deepEqual(w.log.nav, ['discussions']); assert.equal(w.log.back, 0);
    });
    test('an unsent post asks first: declining stays on the page, accepting leaves', () => {
        const kept = world({ confirmAnswer: false });
        kept.area.dispatch('input');
        kept.ctl.click();
        assert.equal(kept.log.asked.length, 1);
        assert.deepEqual(kept.log.nav, []); assert.equal(kept.log.back, 0);
        const left = world({ confirmAnswer: true });
        left.area.dispatch('input');
        left.ctl.click();
        assert.deepEqual(left.log.nav, ['discussions']);
    });
    test('two pages deep: repeated X presses keep going back, one entry per press, then the parent', () => {
        const w = world({ depth: 2 });
        w.ctl.click(); w.popstate();
        assert.equal(w.log.back, 1); assert.equal(w.log.depth, 1);
        w.ctl.click(); w.popstate();
        assert.equal(w.log.back, 2); assert.equal(w.log.depth, 0);
        w.ctl.click();
        assert.equal(w.log.back, 2); assert.deepEqual(w.log.nav, ['discussions']);
    });
    test('a second press before popstate arrives does not use up an entry that was never there', () => {
        const w = world({ depth: 1 });
        w.ctl.click(); w.ctl.click();
        assert.equal(w.log.depth, 1, 'close alone never changes the count');
    });
    test('a busy button elsewhere on a FULL page does not bypass the draft prompt', () => {
        const w = world({ confirmAnswer: false });
        w.page.add(new El('button', { 'aria-busy': 'true' }));
        w.area.dispatch('input');
        w.ctl.click();
        assert.equal(w.log.asked.length, 1);
        assert.deepEqual(w.log.nav, []);
    });
    test('a search box is not a draft: no unsent-text prompt', () => {
        const w = world();
        const s = field('abc', { tag: 'input', type: 'search' });
        w.page.add(s); s.dispatch('input');
        w.area.value = '';
        w.ctl.click();
        assert.equal(w.log.asked.length, 0);
        assert.deepEqual(w.log.nav, ['discussions']);
    });
    test('an in-app confirm (a promise) holds the close until answered; yes closes, no keeps the draft', async () => {
        for (const [answer, closes] of [[true, true], [false, false]]) {
            let resolve; const log = { nav: [], back: 0 };
            const ctl = new El('button', { 'data-close-detail': 'home' });
            const area = field('x');
            const page = new El('div', { class: 'page-section' }, [ctl, area]);
            const doc = makeDoc(page);
            wireCloseControls(doc, { getDepth: () => 0, setDepth() {}, back() { log.back++; }, navigate: (p) => log.nav.push(p), confirmFn: () => new Promise(r => { resolve = r; }) });
            area.dispatch('input');
            const ev = ctl.click();
            assert.equal(ev.defaultPrevented, true); assert.deepEqual(log.nav, []);
            resolve(answer); await new Promise(r => setImmediate(r));
            assert.deepEqual(log.nav, closes ? ['home'] : []);
            assert.equal(isDirty(page), !closes, 'declining keeps the draft');
        }
    });
    test('an async confirm on a dialog: yes re-runs the close, no leaves it open', async () => {
        for (const [answer, hid] of [[true, 1], [false, 0]]) {
            let resolve; let hidden = 0;
            const x = new El('button', { 'data-modal-close': '' }); const f = field('1', { tag: 'input' });
            const dlg = new El('div', { class: 'modal' }, [x, f]);
            const doc = makeDoc(dlg);
            x.addEventListener('click', () => { hidden++; });
            wireCloseControls(doc, { getDepth: () => 0, setDepth() {}, back() {}, navigate() {}, confirmFn: () => new Promise(r => { resolve = r; }) });
            f.dispatch('input'); x.click();
            assert.equal(hidden, 0, 'held while asking');
            resolve(answer); await new Promise(r => setImmediate(r));
            assert.equal(hidden, hid);
        }
    });
    test('text that was never typed by the user does not trigger a prompt', () => {
        const w = world();
        w.ctl.click();
        assert.equal(w.log.asked.length, 0);
        assert.deepEqual(w.log.nav, ['discussions']);
    });
    test('a dialog X closes a clean dialog', () => {
        const w = world();
        w.dlgClose.click();
        assert.equal(w.hidden(), 1); assert.equal(w.log.asked.length, 0);
    });
    test('a dialog with a typed draft: declining keeps it open and the dialog handler never runs', () => {
        const w = world({ confirmAnswer: false });
        w.dlgField.value = '12.5'; w.dlgField.dispatch('input');
        w.dlgClose.click();
        assert.equal(w.hidden(), 0); assert.equal(w.dlg.style.display, 'flex');
        assert.equal(w.log.asked.length, 1);
    });
    test('accepting the prompt closes the dialog and forgets the draft for next time', () => {
        const w = world({ confirmAnswer: true });
        w.dlgField.value = '12.5'; w.dlgField.dispatch('input');
        w.dlgClose.click();
        assert.equal(w.hidden(), 1);
        assert.equal(isDirty(w.dlg), false);
    });
    test('a pending signature: the dialog hides with no prompt (the tx-status card keeps tracking)', () => {
        const w = world({ confirmAnswer: false });
        w.dlgField.value = '12.5'; w.dlgField.dispatch('input');
        w.dlgSubmit.setAttribute('aria-busy', 'true');
        w.dlgClose.click();
        assert.equal(w.hidden(), 1); assert.equal(w.log.asked.length, 0);
    });
    test('the backdrop is guarded the same way', () => {
        const w = world({ confirmAnswer: false });
        let backdropClosed = 0;
        w.dlg.addEventListener('click', (e) => { if (e.target === w.dlg) backdropClosed++; });
        w.dlgField.value = 'x'; w.dlgField.dispatch('input');
        w.dlg.click();
        assert.equal(backdropClosed, 0); assert.equal(w.log.asked.length, 1);
    });
    test('a click on something else inside the dialog is left alone', () => {
        const w = world({ confirmAnswer: false });
        w.dlgField.value = 'x'; w.dlgField.dispatch('input');
        w.dlgField.click();
        assert.equal(w.log.asked.length, 0);
    });
});

describe('Escape', () => {
    test('Esc clicks the dialog\'s own close control, so its teardown runs', () => {
        const w = world();
        const ev = { key: 'Escape', preventDefault() { this.p = true; } };
        onDialogKeydown(ev, w.dlg);
        assert.equal(w.dlgClose.clicks, 1); assert.equal(ev.p, true); assert.equal(w.hidden(), 1);
    });
    test('Esc with a draft goes through the same confirm; declined keeps the dialog', () => {
        const w = world({ confirmAnswer: false });
        w.dlgField.value = 'x'; w.dlgField.dispatch('input');
        onDialogKeydown({ key: 'Escape', preventDefault() {} }, w.dlg);
        assert.equal(w.log.asked.length, 1); assert.equal(w.hidden(), 0);
    });
    test('other keys, and Esc with no dialog open, do nothing', () => {
        const w = world();
        const ev = { key: 'a', preventDefault() { this.p = true; } };
        onDialogKeydown(ev, w.dlg);
        onDialogKeydown({ key: 'Escape', preventDefault() { this.p = true; } }, null);
        assert.equal(w.dlgClose.clicks, 0); assert.equal(ev.p, undefined);
    });
    test('a dialog with no close control is hidden directly as the last resort', () => {
        const dlg = new El('div', { class: 'modal' }); dlg.style.display = 'flex';
        closeDialogElement(dlg);
        assert.equal(dlg.style.display, 'none');
    });
});

describe('focus return', () => {
    test('focus goes back to the control that opened the dialog, once', () => {
        const opener = new El('button'); const doc = makeDoc(opener);
        const fr = createFocusReturn(doc);
        fr.remember(opener);
        assert.equal(fr.restore(), true);
        assert.equal(opener.focused, true);
        assert.equal(fr.restore(), false, 'nothing left to restore');
    });
    test('an opener that was re-rendered away is skipped without throwing', () => {
        const opener = new El('button'); const doc = makeDoc(new El('div'));
        const fr = createFocusReturn(doc);
        fr.remember(opener);
        assert.equal(fr.restore(), false); assert.equal(opener.focused, false);
    });
    test('remember ignores a missing element', () => {
        const fr = createFocusReturn(makeDoc());
        fr.remember(null);
        assert.equal(fr.restore(), false);
    });
});

describe('every inner page and dialog has the control', () => {
    test('all dialogs in index.html have a close control reachable by Esc and labelled for screen readers', () => {
        const parts = INDEX.split(/(?=<div id="[\w-]+" class="modal)/).slice(1);
        assert.ok(parts.length >= 13, 'found the dialogs: ' + parts.length);
        for (const p of parts) {
            const id = /^<div id="([\w-]+)"/.exec(p)[1];
            const body = p;   // the split already ends each part at the next dialog
            const btn = /<button[^>]*(?:data-modal-close|class="modal-close-btn"|aria-label="Close[^"]*")[^>]*>/.exec(body);
            assert.ok(btn, id + ' has a close button');
            assert.match(btn[0], /aria-label="(Close[^"]*|Skip tour)"/, id + ' close button is labelled');
            assert.match(btn[0], /data-modal-close|aria-label="Close/, id + ' is found by Esc');
        }
    });
    test('governance item pages: every kind has the control, closing to its list', () => {
        const base = { id: '2', title: 't', status: 'Ongoing', call: null, timeline: [], thread: null, sources: {} };
        const ref = renderGovDetailSummary({ ...base, kind: 'referendum', index: 2, tally: { known: false } }, h);
        const prop = renderGovDetailSummary({ ...base, kind: 'proposal', index: 3 }, h);
        const ext = renderGovDetailSummary({ ...base, kind: 'external', id: M1 }, h);
        const mot = renderGovDetailSummary({ ...base, kind: 'motion', collective: 'council', id: M1, hash: M1, index: 7, status: 'proposed', ayes: 0, nays: 0, threshold: 2, seats: 3, ayeVoters: [], nayVoters: [], members: [], related: [] }, h);
        const tc = renderGovDetailSummary({ ...base, kind: 'motion', collective: 'technicalCommittee', id: M1, hash: M1, index: 1, status: 'proposed', ayes: 0, nays: 0, threshold: 2, seats: 3, ayeVoters: [], nayVoters: [], members: [], related: [] }, h);
        for (const [name, html, parent] of [['referendum', ref, 'democracy'], ['proposal', prop, 'democracy'], ['external', ext, 'democracy'], ['motion', mot, 'council'], ['tc-motion', tc, 'council']]) {
            assert.ok(html.includes('aria-label="Close"'), name);
            assert.ok(html.includes(`data-close-detail="${parent}"`), name + ' closes to ' + parent);
        }
    });
    test('the not-found card closes too, to the list it would have belonged to', () => {
        const a = renderNotFound({ kind: 'motion' }, 'gone', h);
        const b = renderNotFound({ kind: 'referendum' }, 'gone', h);
        const c = renderNotFound(null, 'gone', h);
        assert.ok(a.includes('data-close-detail="council"') && b.includes('data-close-detail="democracy"') && c.includes('data-close-detail="home"'));
        assert.ok(a.includes('aria-label="Close"'));
    });
    const code = stripComments(SCRIPT);
    const fn = (name) => { const i = code.indexOf('function ' + name); assert.ok(i > 0, name); return code.slice(i, code.indexOf('\nfunction ', i + 10) > 0 ? code.indexOf('\nfunction ', i + 10) : undefined); };
    test('a discussion thread page closes to Discussions (the embedded board on item pages does not)', () => {
        const body = fn('renderThread(');
        assert.match(body, /closeControlHtml\(\{ parent: 'discussions' \}\)/);
        assert.match(body, /opts\.embedded \? '' : closeControlHtml/);
    });
    test('the wallet picker / connect panel closes to the previous page, else Home', () => {
        assert.match(fn('renderWalletConnectPanel('), /closeControlHtml\(\{ parent: 'home' \}\)/);
    });
    test('help articles close to the help centre; the landing and email preferences to Home', () => {
        assert.match(fn('renderHelpArticle('), /closeControlHtml\(\{ parent: 'help' \}\)/);
        assert.match(fn('renderHelpLanding('), /closeControlHtml\(\{ parent: 'home' \}\)/);
        assert.match(fn('emailPrefsCard('), /closeControlHtml\(\{ parent: 'home' \}\)/);
    });
    test('a reopened Send or Payout dialog never re-enables a Sign button that is mid-signature', () => {
        assert.match(fn('updateSendSignGate('), /btn\.disabled\s*=\s*sendFeeEstimateFailed\s*\|\|\s*btn\.getAttribute\('aria-busy'\)\s*===\s*'true'/);
        const open = fn('openPayoutModal(');
        assert.match(open, /submitBtn\.disabled\s*=\s*submitBtn\.getAttribute\('aria-busy'\)\s*===\s*'true'/);
        assert.ok(!/submitBtn\.disabled\s*=\s*false;/.test(open), 'no unconditional re-enable');
    });
    test('script.js asks through the in-app dialog, not window.confirm, and popstate owns the depth', () => {
        assert.ok(!/window\.confirm/.test(code));
        assert.match(code, /createConfirmDialog\(document\)/);
        assert.match(code, /spaNavDepth = Math\.max\(0, spaNavDepth - 1\)/);
    });
    test('script.js routes everything through the shared module and stays under its ceiling', () => {
        assert.match(SCRIPT, /from '\.\/lib\/close-control\.js'/);
        assert.match(code, /wireCloseControls\(document,/);
        assert.match(code, /onDialogKeydown\(/);
        assert.match(code, /createFocusReturn\(/);
        assert.ok(!/function closeModalElement/.test(code), 'one Esc implementation, in lib/');
        assert.ok(SCRIPT.split('\n').length <= 15000, 'script.js lines: ' + SCRIPT.split('\n').length);
    });
});
