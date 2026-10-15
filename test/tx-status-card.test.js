// The status card's DOM behaviour (lib/tx-status-card.js), on a tiny fake DOM:
// one card per submission updated in place, success closes itself 8 s after
// Finalized unless hovered, failures never close themselves, at most three
// cards with the oldest finished one dropped first, Close and Esc work.

import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

class El {
    constructor(tag) { this.tag = tag; this.children = []; this.parentNode = null; this.attrs = {}; this.dataset = {}; this.listeners = {}; this._html = ''; this.className = ''; }
    set innerHTML(v) { this._html = String(v); }
    get innerHTML() { return this._html; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    fire(t, e = {}) { for (const fn of this.listeners[t] || []) fn(e); }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; }
}
function installDom() {
    const byId = {};
    const body = new El('body');
    const doc = {
        body,
        createElement: (t) => new El(t),
        getElementById: (id) => byId[id] || null
    };
    const origAppend = body.appendChild.bind(body);
    body.appendChild = (c) => { if (c.id) byId[c.id] = c; return origAppend(c); };
    globalThis.document = doc;
    return { doc, zone: () => byId['tx-status-zone'] };
}

const { showTxStatus, dismissTxStatus } = await import('../lib/tx-status-card.js');
const okEvents = [{ event: { section: 'system', method: 'ExtrinsicSuccess', data: [] } }];
// Event target whose closest() matches one selector, like a click on a child.
const targetFor = (sel) => ({ closest: (s) => (s === sel ? {} : null) });

describe('status card DOM', () => {
    let dom;
    beforeEach(() => {
        dom = installDom();
        mock.timers.enable({ apis: ['setTimeout'] });
        console.debug = () => {};
    });
    afterEach(() => mock.timers.reset());

    test('one card per submission, updated in place through the stages', () => {
        const a = { id: 'c1', key: 'balances.transfer', params: { amount: '5', to: 'eAbcdefghijklmnop' } };
        showTxStatus(a, 'signing');
        showTxStatus(a, { type: 'Broadcast' });
        showTxStatus(a, { type: 'InBlock' }, okEvents, null, { blockNumber: 42 });
        const z = dom.zone();
        assert.equal(z.children.length, 1);
        assert.match(z.children[0].innerHTML, /In block #42/);
        assert.match(z.children[0].innerHTML, /PDEX sent/);
        assert.equal(z.getAttribute('aria-live'), 'polite');
        dismissTxStatus('c1');
    });

    test('success closes itself 8 s after Finalized, not while hovered', () => {
        const a = { id: 'c2', key: 'council.vote', params: { aye: true, idx: 3 } };
        showTxStatus(a, { type: 'Finalized' }, okEvents, null, { blockNumber: 7, txHash: '0x' + 'ab'.repeat(32) });
        const slot = dom.zone().children[0];
        assert.match(slot.innerHTML, /View transaction/);
        slot.fire('mouseenter');
        mock.timers.tick(20000);
        assert.equal(dom.zone().children.length, 1, 'closed while hovered');
        slot.fire('mouseleave');
        mock.timers.tick(7999);
        assert.equal(dom.zone().children.length, 1);
        mock.timers.tick(1);
        assert.equal(dom.zone().children.length, 0);
    });

    test('failures and notices never close themselves', () => {
        showTxStatus({ id: 'c3', key: 'council.vote' }, 'failed', null, new Error('1010: Invalid Transaction: Inability to pay some fees'));
        showTxStatus({ id: 'n1' }, 'notice', null, 'Wallet data is not loaded yet.');
        mock.timers.tick(600000);
        assert.equal(dom.zone().children.length, 2);
        assert.match(dom.zone().children[0].innerHTML, /network fee/);
        assert.match(dom.zone().children[0].innerHTML, /Support code/);
        dismissTxStatus('c3'); dismissTxStatus('n1');
    });

    test('Close button and Esc remove the card', () => {
        showTxStatus({ id: 'c4' }, 'notice', null, 'x');
        showTxStatus({ id: 'c5' }, 'notice', null, 'y');
        const z = dom.zone();
        z.children[0].fire('click', { target: targetFor('.tx-card-close') });
        assert.equal(z.children.length, 1);
        z.fire('keydown', { key: 'Escape', target: { closest: () => ({ getAttribute: () => 'c5' }) } });
        assert.equal(z.children.length, 0);
    });

    test('at most three cards; the oldest finished one goes first', () => {
        showTxStatus({ id: 'p1', key: 'council.vote' }, 'signing');
        showTxStatus({ id: 'f1' }, 'failed', null, 'first failure');
        showTxStatus({ id: 'p2', key: 'council.vote' }, 'signing');
        showTxStatus({ id: 'p3', key: 'council.vote' }, 'signing');
        const html = dom.zone().children.map(c => c.innerHTML).join('\n');
        assert.equal(dom.zone().children.length, 3);
        assert.ok(!/first failure/.test(html), 'the finished card should have been dropped, not an in-flight one');
        assert.equal((html.match(/Waiting for your wallet/g) || []).length, 3, 'an in-flight card was dropped');
        ['p1', 'p2', 'p3'].forEach(dismissTxStatus);
    });
});
