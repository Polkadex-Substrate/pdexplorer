// The signing tracker (lib/tx-submit.js) end to end, against a fake api,
// button and transaction, with the real card model. test/tx-lifecycle.test.js
// checks the decisions; this checks they are carried out: who is called,
// what the card says, whether the button is usable, whether watching stops.
//
// Run: npm test

import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { trackSignedTx } from '../lib/tx-submit.js';
import { buildTxModel, PRE_INBLOCK_CAP_MS, FINALITY_CAP_MS } from '../lib/tx-status.js';
import { motionDataId, patchMotionCards } from '../lib/motion-patch.js';

const HASH = '0x' + 'ab'.repeat(32);
const BLOCKS = { '0xb1': 42, '0xb2': 43 };
const ok = [{ event: { section: 'system', method: 'ExtrinsicSuccess', data: [] } }];
const bad = [{ event: { section: 'system', method: 'ExtrinsicFailed', data: [{ isBadOrigin: true, type: 'BadOrigin' }] } }];
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };

function harness() {
    const listeners = {};
    const api = {
        registry: {},
        on: (e, f) => { (listeners[e] = listeners[e] || []).push(f); },
        off: (e, f) => { listeners[e] = (listeners[e] || []).filter(x => x !== f); },
        rpc: { chain: { getHeader: (h) => Promise.resolve({ number: { toNumber: () => (h === undefined ? 99 : BLOCKS[h]) } }) } }
    };
    const shown = [];
    const show = (a, st, ev, err, ex) => { const m = buildTxModel(a, st, ev, err, ex); shown.push(m); return m; };
    const button = { disabled: false, attrs: {}, innerHTML: 'Vote', textContent: '',
        setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
    const calls = { onError: [], onSuccess: 0, stages: [], unsub: 0 };
    let cb = null;
    const tx = { signAndSend: (addr, opts, f) => { cb = f; return Promise.resolve(() => { calls.unsub++; }); } };
    const run = trackSignedTx({
        api, button, show, idleText: 'Vote',
        action: { id: 'a1', key: 'council.vote', params: { aye: true, idx: 1, body: 'council' } },
        onError: (t) => calls.onError.push(t), onSuccess: () => { calls.onSuccess++; }, onStage: (s) => calls.stages.push(s)
    });
    const emit = async (status, events) => { cb({ status, events, txHash: { toHex: () => HASH } }); await flush(); };
    const last = () => shown[shown.length - 1];
    const drop = async () => { (listeners.disconnected || []).slice().forEach(f => f()); await flush(); };
    return { run, tx, emit, shown, last, button, calls, drop, listeners };
}
const READY = { type: 'Ready' };
const IN1 = { type: 'InBlock', asInBlock: '0xb1' };
const IN2 = { type: 'InBlock', asInBlock: '0xb2' };
const FIN1 = { type: 'Finalized', asFinalized: '0xb1' };

describe('the tracker carries out the lifecycle', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => mock.timers.reset());

    test('clean path: busy while sent, enabled at In block, onSuccess once, stops at Finalized', async () => {
        const h = harness();
        h.run.start();
        await h.run.send(h.tx, 'addr', {});
        await h.emit(READY);
        assert.equal(h.button.disabled, true);
        await h.emit(IN1, ok);
        assert.equal(h.button.disabled, false);
        assert.equal(h.last().stageText, 'In block #42');
        await h.emit(FIN1, ok);
        assert.equal(h.last().stage, 'finalized');
        assert.equal(h.calls.onSuccess, 1);
        assert.equal(h.calls.unsub, 1);
        assert.deepEqual(h.calls.onError, []);
        const n = h.shown.length;
        await h.drop();
        assert.equal(h.shown.length, n, 'a drop after Finalized changed the card');
    });

    test('M1: link dropped after a clean In block is unconfirmed, with no onError', async () => {
        const h = harness();
        h.run.start();
        await h.run.send(h.tx, 'addr', {});
        await h.emit(READY);
        await h.emit(IN1, ok);
        await h.drop();
        assert.deepEqual(h.calls.onError, [], 'onError ran after onSuccess');
        assert.equal(h.calls.onSuccess, 1);
        assert.equal(h.last().stage, 'unconfirmed');
        assert.equal(h.last().tone, 'neutral');
        assert.equal(h.last().stageText, 'Included in block #42, finality not yet confirmed');
        assert.ok(h.last().links.some(l => l.href === `/tx/42/${HASH}`));
        assert.equal(h.calls.stages[h.calls.stages.length - 1], 'unconfirmed');
        assert.equal(h.calls.unsub, 1);
        mock.timers.tick(FINALITY_CAP_MS);
        assert.equal(h.last().stage, 'unconfirmed', 'the finality cap fired after the end');
    });

    test('a drop before inclusion is still a failure with the readable connection text', async () => {
        const h = harness();
        h.run.start();
        await h.run.send(h.tx, 'addr', {});
        await h.emit(READY);
        await h.drop();
        assert.equal(h.calls.onError.length, 1);
        assert.match(h.calls.onError[0], /Lost connection/);
        assert.equal(h.button.disabled, false);
    });

    test('L4: Retracted re-enables the button, clears the block, and the next block is read again', async () => {
        const h = harness();
        h.run.start();
        await h.run.send(h.tx, 'addr', {});
        await h.emit(READY);
        await h.emit(IN1, ok);
        await h.emit({ type: 'Retracted' });
        assert.equal(h.button.disabled, false);
        assert.ok(!('aria-busy' in h.button.attrs));
        assert.equal(h.last().stageText, 'Sent to the network');
        assert.ok(!h.last().links.some(l => /^\/block\//.test(l.href)), 'old block link kept');
        assert.ok(h.calls.stages.includes('resent'));
        await h.emit(IN2, ok);
        assert.equal(h.last().stageText, 'In block #43', 'the block number from before the retraction stuck');
        assert.equal(h.calls.onSuccess, 1, 'onSuccess ran twice');
    });

    test('L5: not in a block within 90 s is waiting: no onError, buttons back, watching stops', async () => {
        const h = harness();
        h.run.start();
        await h.run.send(h.tx, 'addr', {});
        await h.emit(READY);
        mock.timers.tick(PRE_INBLOCK_CAP_MS - 1);
        assert.equal(h.last().stage, 'broadcast');
        mock.timers.tick(1);
        assert.equal(h.last().stage, 'waiting');
        assert.equal(h.last().stageText, 'Still waiting for the network');
        assert.ok(h.last().links.some(l => l.href === `/tx/99/${HASH}`), JSON.stringify(h.last().links));
        assert.deepEqual(h.calls.onError, []);
        assert.equal(h.button.disabled, false);
        assert.equal(h.calls.unsub, 1);
        const n = h.shown.length;
        await h.emit(IN1, ok);
        assert.equal(h.shown.length, n, 'kept watching after the cap');
        assert.equal(h.calls.onSuccess, 0);
    });

    test('failed events at In block: onError, no onSuccess', async () => {
        const h = harness();
        h.run.start();
        await h.run.send(h.tx, 'addr', {});
        await h.emit(READY);
        await h.emit(IN1, bad);
        assert.equal(h.calls.onSuccess, 0);
        assert.equal(h.calls.onError.length, 1);
        assert.equal(h.last().stage, 'failed');
    });

    test('M2: a buildTx guard reaches onError and the card as written, with no support code', () => {
        const h = harness();
        h.run.start();
        h.run.buildFailed(new Error('The treasury pallet is not available on this runtime.'));
        assert.deepEqual(h.calls.onError, ['The treasury pallet is not available on this runtime.']);
        assert.equal(h.last().body, 'The treasury pallet is not available on this runtime.');
        assert.equal(h.last().code, null);
        assert.equal(h.button.disabled, false);
    });

    test('M2: a wallet error thrown by signAndSend keeps its readable message', async () => {
        const h = harness();
        h.run.start();
        await h.run.send({ signAndSend: () => Promise.reject(new Error('Unable to retrieve keypair for this account')) }, 'addr', {});
        assert.deepEqual(h.calls.onError, ['Unable to retrieve keypair for this account']);
    });
});

// A fake DOM just big enough for patchMotionCards.
function fakeRoot(hashes, parts = ['badge', 'tally', 'meta', 'voters', 'actions']) {
    const cards = hashes.map(hash => {
        const slots = Object.fromEntries(parts.map(p => [p, { innerHTML: 'old-' + p }]));
        return { hash, slots, getAttribute: (k) => (k === 'data-hash' ? hash : null),
            querySelector: (sel) => { const m = /data-part="(\w+)"/.exec(sel); return (m && slots[m[1]]) || null; } };
    });
    return { cards, querySelectorAll: () => cards };
}
const model = (hash, p) => ({ hash, parts: { badge: 'b', tally: 't', meta: 'm', voters: 'v', actions: 'a', ...p } });

describe('L8: patching motion cards in place', () => {
    test('only the listed parts of the listed card change; buttons rewired only for actions', () => {
        const root = fakeRoot(['h1', 'h2']);
        const rewired = [];
        const okPatch = patchMotionCards(root, [{ hash: 'h2', parts: ['tally', 'voters'] }],
            [model('h1'), model('h2', { tally: 'T2', voters: 'V2' })], (el) => rewired.push(el.hash));
        assert.equal(okPatch, true);
        assert.equal(root.cards[1].slots.tally.innerHTML, 'T2');
        assert.equal(root.cards[1].slots.voters.innerHTML, 'V2');
        assert.equal(root.cards[1].slots.badge.innerHTML, 'old-badge');
        assert.equal(root.cards[0].slots.tally.innerHTML, 'old-tally');
        assert.deepEqual(rewired, []);
        patchMotionCards(root, [{ hash: 'h1', parts: ['actions'] }], [model('h1', { actions: 'A1' }), model('h2')], (el) => rewired.push(el.hash));
        assert.deepEqual(rewired, ['h1']);
    });
    test('a DOM that does not match the plan is left alone and reported', () => {
        const root = fakeRoot(['h1'], ['badge', 'tally']);
        assert.equal(patchMotionCards(root, [{ hash: 'h1', parts: ['tally', 'voters'] }], [model('h1', { tally: 'NEW' })]), false);
        assert.equal(root.cards[0].slots.tally.innerHTML, 'old-tally', 'patched half a card');
        assert.equal(patchMotionCards(fakeRoot(['h1']), [], [model('h1'), model('h2')]), false, 'card count differs');
        assert.equal(patchMotionCards(fakeRoot(['h1']), [{ hash: 'hX', parts: ['tally'] }], [model('h1')]), false);
    });
    test('the snapshot id is stable per object and new for a new snapshot', () => {
        const a = {}, b = {};
        assert.equal(motionDataId(a), motionDataId(a));
        assert.notEqual(motionDataId(a), motionDataId(b));
        assert.equal(motionDataId(null), 0);
    });
});
