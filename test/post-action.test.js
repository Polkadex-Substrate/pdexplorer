// The post-action core (design 2.3, 2.4, 2.5 and 4; UX U1, U10, U12, U13): stage handling through the
// real tracker, no overlay on any failure stage, reorg withdrawal and re-inclusion, account scoping on
// a wallet switch, and the hold deadline without timers while the tab is hidden.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { harness, flush, ok, READY, IN1, IN2 } from './helpers/tx-harness.js';
import { createPostAction } from '../lib/post-action.js';
import { createKnownResults } from '../lib/known-results.js';
import { effectsFor } from '../lib/action-effects.js';
import { ME, OTHER, PAIRS, keyOf, REGISTRY, paidItem, otherPageItem, skippedItem, forceBatch } from './helpers/payout-events.js';

const D = 'rewards.unpaid';
const PAYOUT = { id: 'p1', key: 'staking.payout', params: { k: 3, remaining: 0, account: ME, pairs: PAIRS } };
const ALL_PAID = forceBatch(...PAIRS.map(p => paidItem(p)));

function world(opts = {}) {
    const timers = [];
    const known = createKnownResults({ storage: null, now: opts.now || Date.now });
    const vis = { on: true };
    const logs = [];
    const core = createPostAction({ effects: effectsFor, known, now: opts.now || Date.now, visible: () => vis.on,
        setTimer: (f, ms) => { const t = { f, ms, live: true }; timers.push(t); return t; }, clearTimer: (t) => { if (t) t.live = false; }, log: (e) => logs.push(e) });
    const reloads = [];
    let shown = opts.account || ME;
    const unsub = core.subscribe(D, { account: () => shown, reload: (info) => { reloads.push(info); return null; } });
    const sub = (s) => { shown = s; };
    return { known, core, timers, vis, reloads, unsub, sub, logs };
}
async function sendPayout(w, steps) {
    const h = harness({ action: PAYOUT, registry: REGISTRY, core: w.core });
    h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY);
    await steps(h);
    await flush();
    return h;
}
const keys = (w, op) => w.known.list(D, ME).filter(e => e.op === op).map(e => e.key).sort();

describe('stage handling', () => {
    test('a clean In block records the proven rows with block and tx, and reloads the subscriber once', async () => {
        const w = world();
        await sendPayout(w, async (h) => { await h.emit(IN1, ALL_PAID); });
        assert.deepEqual(keys(w, 'remove'), PAIRS.map(keyOf).sort());
        const e = w.known.list(D, ME)[0];
        assert.equal(e.block, 42);
        assert.match(e.txHash, /^0xab/);
        assert.equal(w.reloads.length, 1);
        assert.equal(w.reloads[0].reason, 'inBlock');
        assert.equal(w.reloads[0].block, 42);
        assert.equal(w.reloads[0].origin, 'self');
    });
    test('Finalized and a later drop add nothing and reload nothing more', async () => {
        const w = world();
        await sendPayout(w, async (h) => { await h.emit(IN1, ALL_PAID); await h.emit({ type: 'Finalized', asFinalized: '0xb1' }, ALL_PAID); await h.drop(); });
        assert.equal(w.reloads.length, 1);
        assert.equal(w.known.list(D, ME).length, 3);
    });
    test('unconfirmed after a clean In block (header read lost) applies the events once', async () => {
        const w = world();
        await sendPayout(w, async (h) => { await h.emit(IN1, ALL_PAID); await h.drop(); });
        assert.equal(w.reloads.length, 1, 'the same block was announced twice');
        assert.equal(keys(w, 'remove').length, 3);
    });
    test('no overlay and no reload of the indexed domain for any failure stage', async () => {
        const ends = {
            failed: async (h) => { await h.emit(IN1, forceBatch(skippedItem(), skippedItem(), skippedItem())); },
            usurped: async (h) => { await h.emit({ type: 'Usurped' }); },
            dropped: async (h) => { await h.emit({ type: 'Dropped' }); },
            invalid: async (h) => { await h.emit({ type: 'Invalid' }); },
            'drop before inclusion': async (h) => { await h.drop(); }
        };
        for (const [name, steps] of Object.entries(ends)) {
            const w = world();
            await sendPayout(w, steps);
            assert.deepEqual(w.known.list(D, ME), [], name);
            assert.deepEqual(w.reloads, [], name);
        }
        const w = world();
        const h = harness({ action: PAYOUT, registry: REGISTRY, core: w.core });
        h.run.start(); await h.run.send({ signAndSend: () => Promise.reject(new Error('Cancelled')) }, ME, {}); await flush();
        assert.deepEqual(w.known.list(D, ME), [], 'cancelled');
        assert.deepEqual(w.reloads, [], 'cancelled');
    });
    test('a partial batch: proven rows removed, skipped and unproven rows held', async () => {
        const w = world();
        await sendPayout(w, async (h) => { await h.emit(IN1, forceBatch(paidItem(PAIRS[0]), skippedItem(), otherPageItem(PAIRS[2]))); });
        assert.deepEqual(keys(w, 'remove'), [keyOf(PAIRS[0])]);
        assert.deepEqual(keys(w, 'hold'), [keyOf(PAIRS[1]), keyOf(PAIRS[2])].sort());
    });
    test('Retracted withdraws the result and leaves a reorg marker; back in a block re-adds it with the new block', async () => {
        const w = world();
        await sendPayout(w, async (h) => {
            await h.emit(IN1, ALL_PAID);
            await h.emit({ type: 'Retracted' });
            await flush();
            assert.deepEqual(keys(w, 'remove'), [], 'the retracted block still counts');
            assert.equal(keys(w, 'reorg').length, 1);
            assert.equal(w.reloads[w.reloads.length - 1].reason, 'reorg');
            await h.emit(IN2, ALL_PAID);
        });
        assert.deepEqual(keys(w, 'remove'), PAIRS.map(keyOf).sort());
        assert.deepEqual(keys(w, 'reorg'), []);
        assert.equal(w.known.list(D, ME)[0].block, 43);
        assert.deepEqual(w.reloads.map(r => r.reason), ['inBlock', 'reorg', 'inBlock']);
    });
    test('Retracted, then the link drops before a new block: no claim from the old events; the rows are held, not offered', async () => {
        const w = world();
        await sendPayout(w, async (h) => { await h.emit(IN1, ALL_PAID); await h.emit({ type: 'Retracted' }); await h.drop(); });
        assert.deepEqual(keys(w, 'remove'), [], 'claimed from the retracted block');
        assert.deepEqual(keys(w, 'reorg'), [], 'the marker outlived the tracking');
        assert.deepEqual(keys(w, 'hold'), PAIRS.map(keyOf).sort(), 'a payout that may still land was offered again');
    });
    test('a throwing subscriber or effects function is logged, never thrown', async () => {
        const known = createKnownResults({ storage: null });
        const logs = [];
        const core = createPostAction({ effects: () => { throw new Error('effects'); }, known, log: (e) => logs.push(e) });
        core.subscribe(D, { account: () => ME, reload: () => { throw new Error('reload'); } });
        const h = harness({ action: PAYOUT, registry: REGISTRY, core });
        h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); await h.emit(IN1, ALL_PAID); await flush();
        assert.ok(logs.length >= 1);
        assert.doesNotThrow(() => core.notify({ account: ME, domains: [D], reason: 'test' }));
    });
});

describe('accounts', () => {
    test('a wallet switch mid-wait: the result of account A never reloads a component showing B', async () => {
        const w = world();
        w.sub(OTHER);
        await sendPayout(w, async (h) => { await h.emit(IN1, ALL_PAID); });
        assert.deepEqual(w.reloads, []);
        assert.equal(w.known.list(D, ME).length, 3, 'kept for A, keyed by account');
        assert.equal(w.known.list(D, OTHER).length, 0);
    });
    test('notify reaches only subscribers of that domain and account; unsubscribe stops it', () => {
        const w = world();
        w.core.notify({ account: ME, domains: ['balance'], reason: 'x' });
        assert.equal(w.reloads.length, 0);
        w.core.notify({ account: OTHER, domains: [D], reason: 'x' });
        assert.equal(w.reloads.length, 0);
        w.core.notify({ account: ME, domains: [D], reason: 'x' });
        assert.equal(w.reloads.length, 1);
        w.unsub();
        w.core.notify({ account: ME, domains: [D], reason: 'x' });
        assert.equal(w.reloads.length, 1);
    });
    test('another tab\'s write reaches the subscribers as origin other-tab', () => {
        const listeners = [];
        const shared = { m: new Map(), getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }, setItem(k, v) { this.m.set(k, v); } };
        const tabA = createKnownResults({ storage: shared });
        const tabB = createKnownResults({ storage: shared, listen: (f) => listeners.push(f) });
        const core = createPostAction({ effects: effectsFor, known: tabB, log: () => {} });
        const got = [];
        core.subscribe(D, { account: () => ME, reload: (i) => { got.push(i); } });
        tabA.add([{ account: ME, domain: D, op: 'remove', key: keyOf(PAIRS[0]), txHash: '0x1', block: 5 }]);
        listeners.forEach(f => f({ key: 'pdex_known_results' }));
        assert.equal(got.length, 1);
        assert.equal(got[0].origin, 'other-tab');
    });
});

describe('the hold deadline, without timers while hidden', () => {
    test('held rows arm one deadline at the hold bound; it reloads the subscriber with reason deadline', async () => {
        const w = world();
        await sendPayout(w, async (h) => { await h.emit(IN1, forceBatch(paidItem(PAIRS[0]), skippedItem(), paidItem(PAIRS[2]))); });
        const live = w.timers.filter(t => t.live);
        assert.equal(live.length, 1);
        assert.ok(live[0].ms >= w.known.holdMs);
        live[0].f();
        assert.equal(w.reloads[w.reloads.length - 1].reason, 'deadline');
    });
    test('no held rows: no timer', async () => {
        const w = world();
        await sendPayout(w, async (h) => { await h.emit(IN1, ALL_PAID); });
        assert.equal(w.timers.length, 0);
    });
    test('hidden: no timer is armed; resume() runs the due reload at once', async () => {
        const w = world();
        w.vis.on = false;
        await sendPayout(w, async (h) => { await h.emit(IN1, forceBatch(paidItem(PAIRS[0]), skippedItem(), paidItem(PAIRS[2]))); });
        assert.equal(w.timers.length, 0, 'a timer was armed while hidden');
        const n = w.reloads.length;
        w.vis.on = true;
        w.core.resume();
        assert.equal(w.reloads.length, n + 1);
        assert.equal(w.reloads[w.reloads.length - 1].reason, 'resume');
    });
    test('a deadline that fires while hidden waits for resume()', async () => {
        const w = world();
        await sendPayout(w, async (h) => { await h.emit(IN1, forceBatch(paidItem(PAIRS[0]), skippedItem(), paidItem(PAIRS[2]))); });
        const n = w.reloads.length;
        w.vis.on = false;
        w.timers[0].f();
        assert.equal(w.reloads.length, n, 'reloaded while hidden');
        w.vis.on = true;
        w.core.resume();
        assert.equal(w.reloads.length, n + 1);
    });
});
