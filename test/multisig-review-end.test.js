// The multisig review reports how it ended, once (lib/multisig-view.js onEnd).
//
// Fable review round 2, MEDIUM: for a multisig wallet, submitSignedTx hands the
// call to this review. Closing the review, or signing an approval that only
// records itself (the call runs after more signers), fired neither a stage nor
// an error, so a caller holding its buttons (the balance breakdown panel) was
// never told to release them. onEnd(outcome, { stage, text }):
//   'closed'    the review was closed, or replaced, with nothing in flight; or
//               the signer transaction ended without success after a close
//   'approved'  an approval was recorded; the call waits for other signers
//   'executed'  the call was executed (onSuccess runs too)
//
// No happy-dom (not always installed): a small stand-in for the elements the
// review touches, and a MutationObserver that sees style.display changes.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMultisigUI } from '../lib/multisig-view.js';
import { normalizeMultisig } from '../lib/multisig.js';
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
function world({ threshold = 2, accounts = [{ address: A, name: 'Alice', source: 'talisman' }] } = {}) {
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
        submit: async (o) => { submits.push(o); }, refresh() {}, fetchJson: async () => ({})
    });
    const open = (extra = {}) => ui.review({ multisig, callHex: CALL, onSuccess: () => successes.push(1), onEnd: (outcome, model) => ends.push({ outcome, model }), ...extra });
    const sign = () => parts['#multisig-review-sign'].fire('click');
    const close = async () => { modal.style.display = 'none'; await new Promise(r => setTimeout(r, 0)); };
    return { open, sign, close, modal, submits, ends, successes, last: () => submits[submits.length - 1], parts: () => parts };
}

describe('the multisig review reports how it ended', () => {
    beforeEach(() => { saved = { document: globalThis.document, MutationObserver: globalThis.MutationObserver }; });
    afterEach(() => { globalThis.document = saved.document; globalThis.MutationObserver = saved.MutationObserver; });

    test('closed before signing: closed, once', async () => {
        const w = world();
        await w.open();
        assert.equal(w.parts()['#multisig-review-sign'].disabled, false, 'the review loaded and can be signed');
        assert.deepEqual(w.ends, []);
        await w.close();
        assert.deepEqual(w.ends.map(e => e.outcome), ['closed']);
        await w.close();
        assert.equal(w.ends.length, 1);
    });
    test('an approval recorded (threshold 2, first signer): approved with the waiting text, not closed, no onSuccess', async () => {
        const w = world();
        await w.open();
        await w.sign();
        assert.equal(w.submits.length, 1);
        w.last().onStage('inBlock', {});
        await w.last().onSuccess();
        await new Promise(r => setTimeout(r, 0));
        assert.deepEqual(w.ends.map(e => e.outcome), ['approved']);
        assert.match(w.ends[0].model.text, /Approval submitted; waiting for the other signers/);
        assert.equal(w.modal.style.display, 'none');
        assert.equal(w.successes.length, 0, 'the underlying call has not run');
    });
    test('executed (threshold 1): executed, and the caller\'s onSuccess runs', async () => {
        const w = world({ threshold: 1 });
        await w.open();
        await w.sign();
        await w.last().onSuccess();
        await new Promise(r => setTimeout(r, 0));
        assert.deepEqual(w.ends.map(e => e.outcome), ['executed']);
        assert.equal(w.successes.length, 1);
    });
    test('closed while the signer transaction is in flight: nothing until it ends; a failure then ends it', async () => {
        const w = world();
        await w.open();
        await w.sign();
        await w.close();
        assert.deepEqual(w.ends, [], 'still in flight');
        w.last().onStage('failed', { stage: 'failed', text: 'Nope.' });
        assert.deepEqual(w.ends.map(e => e.outcome), ['closed']);
    });
    test('closed while in flight, then the approval lands: approved', async () => {
        const w = world();
        await w.open();
        await w.sign();
        await w.close();
        await w.last().onSuccess();
        assert.deepEqual(w.ends.map(e => e.outcome), ['approved']);
    });
    test('a failure with the review still open does not end it; closing afterwards does', async () => {
        const w = world();
        await w.open();
        await w.sign();
        w.last().onStage('failed', { stage: 'failed', text: 'Nope.' });
        assert.deepEqual(w.ends, []);
        await w.close();
        assert.deepEqual(w.ends.map(e => e.outcome), ['closed']);
    });
    test('a new review replacing an idle one ends the old one', async () => {
        const w = world();
        const first = [];
        await w.open({ onEnd: (o) => first.push(o) });
        await w.open();
        assert.deepEqual(first, ['closed']);
        assert.deepEqual(w.ends, []);
    });
    test('a review that cannot start (no shared signer) still ends when closed', async () => {
        const w = world({ accounts: [] });
        await w.open();
        await w.close();
        assert.deepEqual(w.ends.map(e => e.outcome), ['closed']);
    });
    test('the stages are still forwarded to onStage', async () => {
        const w = world();
        const stages = [];
        await w.open({ onStage: (s) => stages.push(s) });
        await w.sign();
        w.last().onStage('inBlock', {});
        assert.deepEqual(stages, ['inBlock']);
    });
});
