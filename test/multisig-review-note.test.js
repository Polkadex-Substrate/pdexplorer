// The multisig review shows the validator-rules note as text, escaped (Sprint 5 check, NIT).
//
// lib/multisig-view.js puts the note from callNote into <p class="multisig-note" role="note">
// with esc(). This renders the review's details HTML in a real DOM (happy-dom) and checks the
// note arrives as one text node with the exact words, and that markup in a note never becomes
// elements. The stand-in for the modal is the one test/multisig-review-end.test.js uses.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createMultisigUI } from '../lib/multisig-view.js';
import { normalizeMultisig } from '../lib/multisig.js';
import { VALIDATOR_CHECK_NOTE } from '../lib/validator-delegate-chain.js';
import { A, B, C } from './helpers/wallet-world.js';

const CALL = '0x0400';

function el(id) {
    return {
        id, disabled: false, textContent: '', value: '0', style: {}, listeners: {}, innerHTML: '',
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        focus() {}, select() {}, querySelector() { return null; },
        fire(type) { return Promise.all((this.listeners[type] || []).map(fn => fn())); }
    };
}

let saved;
function world({ threshold = 2, accounts = [{ address: A, name: 'Alice', source: 'talisman' }], callNote } = {}) {
    const observers = [];
    const modal = el('multisig-review-modal');
    let display = 'none';
    Object.defineProperty(modal, 'style', { value: {
        get display() { return display; },
        set display(v) { display = v; for (const o of observers) if (o.on) queueMicrotask(() => o.cb([{ attributeName: 'style' }])); }
    } });
    const content = el('multisig-review-content');
    let parts = {};
    Object.defineProperty(content, 'innerHTML', {
        get() { return ''; },
        set(html) {
            const call = html.includes('<textarea') ? el('call') : null;
            if (call) call.value = (/<textarea[^>]*>([^<]*)<\/textarea>/.exec(html) || [])[1] || '';
            parts = { select: el('signer'), textarea: call, '#multisig-review-details': el('details'), '[role="alert"]': el('error'),
                '#multisig-review-sign': el('sign'), '#multisig-review-load': el('load') };
        }
    });
    content.querySelector = (sel) => parts[sel] || null;
    globalThis.document = {
        getElementById: (id) => (id === modal.id ? modal : id === content.id ? content : null),
        querySelectorAll: () => [modal]
    };
    globalThis.MutationObserver = class {
        constructor(cb) { this.cb = cb; this.on = false; observers.push(this); }
        observe() { this.on = true; }
        disconnect() { this.on = false; }
    };
    const multisig = normalizeMultisig({ signers: [A, B, C], threshold, name: 'Team wallet' });
    const tx = { method: { toHex: () => '0xabcd' }, paymentInfo: async () => ({ partialFee: { toString: () => '15000000000' } }) };
    const api = {
        genesisHash: { toHex: () => '0x' + '00'.repeat(32) },
        runtimeVersion: { specVersion: { toString: () => '392' } },
        registry: { createType: (_t, hex) => ({ toHex: () => hex, toU8a: () => new Uint8Array([4, 0]), section: 'balances', method: 'transferKeepAlive', toHuman: () => ({}) }) },
        query: { multisig: { multisigs: async () => ({ isNone: true }) } },
        consts: { multisig: { maxSignatories: 100, depositBase: '1', depositFactor: '1' } }
    };
    api.tx = Object.assign(() => ({ paymentInfo: async () => ({ weight: { refTime: 1000, proofSize: 100 } }) }),
        { multisig: { asMulti: () => tx, asMultiThreshold1: () => tx, approveAsMulti: () => tx } });
    const submits = [], ends = [], successes = [];
    const ui = createMultisigUI({
        store: { find: () => multisig }, storage: { getItem: () => null, setItem() {} }, api: () => api,
        accounts: async () => accounts, selected: () => multisig.address, select() {},
        submit: async (o) => { submits.push(o); }, refresh() {}, fetchJson: async () => ({}), callNote
    });
    const open = (extra = {}) => ui.review({ multisig, callHex: CALL, onSuccess: () => successes.push(1), onEnd: (outcome, model) => ends.push({ outcome, model }), ...extra });
    const sign = () => parts['#multisig-review-sign'].fire('click');
    const close = async () => { modal.style.display = 'none'; await new Promise(r => setTimeout(r, 0)); };
    return { open, parts: () => parts };
}


describe('the multisig review note', () => {
    beforeEach(() => { saved = { document: globalThis.document, MutationObserver: globalThis.MutationObserver }; });
    afterEach(() => { globalThis.document = saved.document; globalThis.MutationObserver = saved.MutationObserver; });

    const dom = (html) => { const w = new Window(); w.document.body.innerHTML = html; return w.document; };

    test('"Could not check validator rules; the chain will decide." is rendered as the note, as text', async () => {
        const w = world({ callNote: async () => VALIDATOR_CHECK_NOTE });
        await w.open();
        const doc = dom(w.parts()['#multisig-review-details'].innerHTML);
        const notes = doc.querySelectorAll('p.multisig-note');
        assert.equal(notes.length, 1);
        assert.equal(notes[0].getAttribute('role'), 'note');
        assert.equal(notes[0].textContent, 'Could not check validator rules; the chain will decide.');
        assert.equal(notes[0].children.length, 0, 'plain text, no child elements');
    });

    test('markup in a note is escaped: it shows as text and creates no element', async () => {
        const evil = '<img src=x onerror=alert(1)><script>alert(2)</script> & "quoted"';
        const w = world({ callNote: async () => evil });
        await w.open();
        const html = w.parts()['#multisig-review-details'].innerHTML;
        const doc = dom(html);
        const note = doc.querySelector('p.multisig-note');
        assert.equal(note.textContent, evil);
        assert.equal(note.children.length, 0);
        assert.equal(doc.querySelectorAll('script').length, 0);
        assert.equal(doc.querySelectorAll('img').length, 0);
    });

    test('no note, no paragraph; a throwing check shows none and the review still loads', async () => {
        for (const callNote of [async () => '', async () => { throw new Error('rpc'); }, null]) {
            const w = world({ callNote });
            await w.open();
            assert.equal(dom(w.parts()['#multisig-review-details'].innerHTML).querySelectorAll('p.multisig-note').length, 0);
            assert.equal(w.parts()['#multisig-review-sign'].disabled, false);
        }
    });
});
