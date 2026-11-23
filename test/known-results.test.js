// The known-results store (design 2.3 and 4, UX U7, U10, U12, U13, hook H1): what a block PROVED, kept
// until the server catches up or an age bound passes, scoped by account, shared with other tabs through
// localStorage, and degrading to memory with no error when storage is unavailable or throws.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKnownResults } from '../lib/known-results.js';
import { ME, OTHER, PAIRS, keyOf } from './helpers/payout-events.js';

const D = 'rewards.unpaid';
function memStorage() {
    const m = new Map();
    return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
function clock(t = 1_000_000) { const c = () => c.t; c.t = t; return c; }
const rows = () => PAIRS.map(p => ({ ...p, amount: 1 }));
const keyOfRow = (r) => `${r.era}:${r.validator}`;
const entry = (op, i, extra = {}) => ({ account: ME, domain: D, op, key: keyOf(PAIRS[i]), block: 77, txHash: '0xa', ...extra });

describe('known results', () => {
    test('apply: a remove filters its row for its account only', () => {
        const k = createKnownResults({ storage: memStorage(), now: clock() });
        k.add([entry('remove', 0), entry('remove', 2)]);
        const a = k.apply(D, ME, rows(), { keyOf: keyOfRow });
        assert.deepEqual(a.rows.map(keyOfRow), [keyOf(PAIRS[1])]);
        assert.deepEqual(a.removed.map(e => e.key).sort(), [keyOf(PAIRS[0]), keyOf(PAIRS[2])].sort());
        const b = k.apply(D, OTHER, rows(), { keyOf: keyOfRow });
        assert.equal(b.rows.length, 3, 'applied to another account');
        assert.equal(b.removed.length, 0);
    });
    test('a remove for a row the server no longer lists is a no-op', () => {
        const k = createKnownResults({ storage: memStorage(), now: clock() });
        k.add([entry('remove', 0)]);
        const a = k.apply(D, ME, rows().slice(1), { keyOf: keyOfRow });
        assert.equal(a.rows.length, 2);
        assert.equal(a.removed.length, 0);
    });
    test('expiry: a remove lives maxAgeMs (10 min); a hold is active holdMs (3 min), then expired, then gone', () => {
        const now = clock();
        const k = createKnownResults({ storage: memStorage(), now });
        assert.equal(k.maxAgeMs, 600_000);
        assert.equal(k.holdMs, 180_000);
        k.add([entry('remove', 0), entry('hold', 1)]);
        let a = k.apply(D, ME, rows(), { keyOf: keyOfRow });
        assert.deepEqual(a.held.map(e => e.key), [keyOf(PAIRS[1])]);
        assert.deepEqual(a.expired, []);
        now.t += 180_000;
        a = k.apply(D, ME, rows(), { keyOf: keyOfRow });
        assert.deepEqual(a.held, [], 'hold outlived its bound');
        assert.deepEqual(a.expired.map(e => e.key), [keyOf(PAIRS[1])]);
        assert.equal(a.removed.length, 1);
        now.t += 420_000;
        a = k.apply(D, ME, rows(), { keyOf: keyOfRow });
        assert.equal(a.removed.length, 0, 'remove outlived 10 min');
        // R2 (F7): a proven-paid row the server STILL lists when its overlay ends comes back marked as possibly
        // behind (expired), never silently; the hold is gone at 10 min as before.
        assert.deepEqual(a.expired.map(e => e.key), [keyOf(PAIRS[0])]);
        assert.deepEqual(k.list(D, ME), []);
        now.t += 600_000;
        a = k.apply(D, ME, rows(), { keyOf: keyOfRow });
        assert.equal(a.expired.length, 0, 'the lapsed remove outlived its second bound');
    });
    test('withdraw by txHash removes every entry of that transaction, and only those', () => {
        const k = createKnownResults({ storage: memStorage(), now: clock() });
        k.add([entry('remove', 0), entry('hold', 1)]);
        k.add([entry('remove', 2, { txHash: '0xb' })]);
        k.withdraw('0xa', 'failed');
        assert.deepEqual(k.list(D, ME).map(e => e.key), [keyOf(PAIRS[2])]);
    });
    test('reorg marker: active within the hold bound, cleared when the same transaction is added again', () => {
        const now = clock();
        const k = createKnownResults({ storage: memStorage(), now });
        k.add([entry('remove', 0)]);
        k.withdraw('0xa', 'reorg');
        k.add([{ account: ME, domain: D, op: 'reorg', key: '0xa', txHash: '0xa', value: 'payout' }]);
        let a = k.apply(D, ME, rows(), { keyOf: keyOfRow });
        assert.equal(a.rows.length, 3, 'rows return on a reorg');
        assert.equal(a.reorg && a.reorg.value, 'payout');
        k.add([entry('remove', 0, { block: 78 })]);
        a = k.apply(D, ME, rows(), { keyOf: keyOfRow });
        assert.equal(a.reorg, null, 'marker kept after re-inclusion');
        assert.equal(a.removed[0].block, 78);
        k.withdraw('0xa', 'reorg');
        k.add([{ account: ME, domain: D, op: 'reorg', key: '0xa', txHash: '0xa', value: 'payout' }]);
        now.t += 180_000;
        assert.equal(k.apply(D, ME, rows(), { keyOf: keyOfRow }).reorg, null, 'a marker never outlives the hold bound');
    });
    test('one entry per (account, domain, key): the newest wins', () => {
        const k = createKnownResults({ storage: memStorage(), now: clock() });
        k.add([entry('hold', 0)]);
        k.add([entry('remove', 0, { txHash: '0xb', block: 80 })]);
        const l = k.list(D, ME);
        assert.equal(l.length, 1);
        assert.equal(l[0].op, 'remove');
        assert.equal(l[0].block, 80);
    });
    test('at most maxEntries entries are kept, newest first', () => {
        const now = clock();
        const k = createKnownResults({ storage: memStorage(), now, maxEntries: 5 });
        for (let i = 0; i < 8; i++) { now.t += 1; k.add([{ account: ME, domain: D, op: 'remove', key: 'k' + i, txHash: '0x' + i }]); }
        assert.deepEqual(k.list(D, ME).map(e => e.key).sort(), ['k3', 'k4', 'k5', 'k6', 'k7']);
    });
    test('storage throwing (private mode) degrades to memory with no error', () => {
        const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); } };
        for (const storage of [throwing, () => { throw new Error('denied'); }, null]) {
            const k = createKnownResults({ storage, now: clock() });
            assert.doesNotThrow(() => k.add([entry('remove', 0)]));
            assert.equal(k.apply(D, ME, rows(), { keyOf: keyOfRow }).rows.length, 2);
            assert.doesNotThrow(() => k.withdraw('0xa'));
            assert.equal(k.list(D, ME).length, 0);
        }
        const halfway = memStorage();
        halfway.setItem = () => { throw new Error('QuotaExceeded'); };
        const k = createKnownResults({ storage: halfway, now: clock() });
        k.add([entry('remove', 0)]);
        assert.equal(k.list(D, ME).length, 1, 'a failed write lost the entry');
    });
    test('corrupted storage is ignored', () => {
        const s = memStorage();
        s.setItem('pdex_known_results', '{not json');
        const k = createKnownResults({ storage: s, now: clock() });
        assert.deepEqual(k.list(D, ME), []);
        s.setItem('pdex_known_results', JSON.stringify([{ nonsense: true }, null, 7]));
        assert.deepEqual(k.list(D, ME), []);
        k.add([entry('remove', 0)]);
        assert.equal(k.list(D, ME).length, 1);
    });
    test('entries are written under pdex_known_results and the address comparison is injectable', () => {
        const s = memStorage();
        const k = createKnownResults({ storage: s, now: clock(), same: (a, b) => a.toLowerCase() === b.toLowerCase() });
        k.add([entry('remove', 0)]);
        assert.ok(s.m.has('pdex_known_results'));
        assert.equal(k.apply(D, ME.toLowerCase(), rows(), { keyOf: keyOfRow }).removed.length, 1);
    });
    test('a second tab: the storage event reaches onChange as other-tab, and its store reads the entry', () => {
        const shared = memStorage();
        const listeners = [];
        const listen = (fn) => { listeners.push(fn); };
        const now = clock();
        const tabA = createKnownResults({ storage: shared, now });
        const tabB = createKnownResults({ storage: shared, now, listen });
        const seen = [];
        tabB.onChange((e) => seen.push(e));
        tabA.add([entry('remove', 0)]);
        listeners.forEach(f => f({ key: 'pdex_known_results' }));
        listeners.forEach(f => f({ key: 'some_other_key' }));
        assert.deepEqual(seen.map(e => e.origin), ['other-tab']);
        assert.equal(tabB.apply(D, ME, rows(), { keyOf: keyOfRow }).removed.length, 1);
        tabA.withdraw('0xa', 'reorg');
        listeners.forEach(f => f({ key: 'pdex_known_results' }));
        assert.equal(tabB.apply(D, ME, rows(), { keyOf: keyOfRow }).removed.length, 0);
    });
    test('onChange fires on own writes with the reason, and can be removed', () => {
        const k = createKnownResults({ storage: memStorage(), now: clock() });
        const seen = [];
        const off = k.onChange((e) => seen.push(e));
        k.add([entry('remove', 0)]);
        k.withdraw('0xa', 'reorg');
        off();
        k.add([entry('remove', 1)]);
        assert.deepEqual(seen.map(e => [e.origin, e.reason]), [['self', 'add'], ['self', 'reorg']]);
    });
    test('a listener that throws does not break the store', () => {
        const k = createKnownResults({ storage: memStorage(), now: clock() });
        k.onChange(() => { throw new Error('boom'); });
        assert.doesNotThrow(() => k.add([entry('remove', 0)]));
        assert.equal(k.list(D, ME).length, 1);
    });
});

// Review follow-ups F4 and F7.
describe('F4: a clock set back never stretches a bound', () => {
    test('an entry saved "in the future" (the clock went back) is expired: no removal, no hold', () => {
        const c = clock(10_000_000);
        const k = createKnownResults({ storage: memStorage(), now: c });
        k.add([entry('remove', 0), entry('hold', 1)]);
        c.t -= 3_600_000;   // the clock is set back an hour
        assert.deepEqual(k.list(D, ME), [], 'an entry outlives its bound by the size of the clock change');
        const a = k.apply(D, ME, rows(), { keyOf: keyOfRow });
        assert.equal(a.rows.length, 3, 'a row is hidden by an entry from the future');
        assert.deepEqual([a.removed.length, a.held.length, a.expired.length], [0, 0, 0]);
    });
    test('a reorg marker from the future is not active', () => {
        const c = clock(10_000_000);
        const k = createKnownResults({ storage: memStorage(), now: c });
        k.add([{ account: ME, domain: D, op: 'reorg', key: '0xa', value: 'staking.payout', txHash: '0xa' }]);
        c.t -= 1;
        assert.equal(k.apply(D, ME, rows(), { keyOf: keyOfRow }).reorg, null);
    });
});

describe('F4: entries are scoped to the chain\'s genesis', () => {
    test('an entry written on one network never applies on another on the same origin, and is pruned there', () => {
        const s = memStorage();
        const c = clock();
        const a = createKnownResults({ storage: s, now: c, genesis: () => '0xg1' });
        a.add([entry('remove', 0)]);
        assert.equal(a.list(D, ME).length, 1);
        const b = createKnownResults({ storage: s, now: c, genesis: () => '0xg2' });
        assert.deepEqual(b.list(D, ME), [], 'an entry from another network applied');
        assert.equal(b.apply(D, ME, rows(), { keyOf: keyOfRow }).rows.length, 3);
        b.prune();
        assert.deepEqual(JSON.parse(s.getItem('pdex_known_results')), [], 'the other network\'s entry was kept');
    });
    test('while the genesis is not known yet nothing applies, and nothing is pruned', () => {
        const s = memStorage();
        const c = clock();
        createKnownResults({ storage: s, now: c, genesis: () => '0xg1' }).add([entry('remove', 0)]);
        const g = { v: null };
        const k = createKnownResults({ storage: s, now: c, genesis: () => g.v });
        assert.deepEqual(k.list(D, ME), [], 'applied before the network is known');
        k.prune();
        assert.equal(JSON.parse(s.getItem('pdex_known_results')).length, 1, 'pruned before the network is known');
        g.v = '0xg1';
        assert.equal(k.list(D, ME).length, 1);
        k.add([entry('hold', 1)]);
        assert.ok(JSON.parse(s.getItem('pdex_known_results')).every(e => e.genesis === '0xg1'), 'an entry was stored without its genesis');
    });
    test('an entry stored without a genesis (written before this change) is ignored and pruned once the genesis is known', () => {
        const s = memStorage();
        const c = clock();
        createKnownResults({ storage: s, now: c }).add([entry('remove', 0)]);
        const k = createKnownResults({ storage: s, now: c, genesis: () => '0xg1' });
        assert.deepEqual(k.list(D, ME), []);
        k.prune();
        assert.deepEqual(JSON.parse(s.getItem('pdex_known_results')), []);
    });
});

describe('F7: aged entries are pruned on load', () => {
    test('a store with an entry past maxAge is rewritten without it when created', () => {
        const s = memStorage();
        const c = clock();
        createKnownResults({ storage: s, now: c }).add([entry('remove', 0)]);
        c.t += 30_000;
        createKnownResults({ storage: s, now: c }).add([entry('remove', 1)]);
        // R2 (F7): a remove is kept one more maxAge after it stops applying (it marks a row the server still
        // lists as possibly behind), so it is aged at 2 x maxAge.
        c.t += 1_200_000 - 30_000;   // the first is now aged, the second is not
        createKnownResults({ storage: s, now: c });
        const left = JSON.parse(s.getItem('pdex_known_results'));
        assert.deepEqual(left.map(e => e.key), [keyOf(PAIRS[1])], 'an aged entry stayed in storage until the next write');
    });
    test('a hold past maxAge is pruned on load at maxAge (only removes get the lapse)', () => {
        const s = memStorage();
        const c = clock();
        createKnownResults({ storage: s, now: c }).add([entry('hold', 0)]);
        c.t += 600_000;
        createKnownResults({ storage: s, now: c });
        assert.deepEqual(JSON.parse(s.getItem('pdex_known_results')), []);
    });
});

// R2: with the server's freshness, the store knows when the server has caught up with an entry's block.
describe('R2: apply with freshness', () => {
    // A stand-in for lib/freshness.js caughtUp, so this file tests the store alone.
    const caughtUp = (domain, f, block) => !!f && Number.isFinite(f.at) && block != null && f.at >= block;
    const at = (n) => ({ at: n });
    test('a hold ends as soon as the server answers at or beyond its block: listed, it is a normal row again (S19)', () => {
        const k = createKnownResults({ storage: memStorage(), now: clock() });
        k.add([entry('hold', 1, { block: 77 })]);
        let a = k.apply(D, ME, rows(), { keyOf: keyOfRow, freshness: at(76), caughtUp });
        assert.deepEqual(a.held.map(e => e.key), [keyOf(PAIRS[1])], 'ended before the server reached the block');
        a = k.apply(D, ME, rows(), { keyOf: keyOfRow, freshness: at(77), caughtUp });
        assert.deepEqual(a.held, []);
        assert.deepEqual(a.expired, [], 'a caught-up hold is not "may be behind"');
        assert.equal(a.rows.length, 3, 'the row is offered again');
        assert.deepEqual(a.ended.map(e => e.key), [keyOf(PAIRS[1])]);
    });
    test('a caught-up hold the server no longer lists is simply gone', () => {
        const k = createKnownResults({ storage: memStorage(), now: clock() });
        k.add([entry('hold', 1, { block: 77 })]);
        const a = k.apply(D, ME, rows().filter((_, i) => i !== 1), { keyOf: keyOfRow, freshness: at(80), caughtUp });
        assert.deepEqual(a.held, []);
        assert.deepEqual(a.expired, []);
        assert.equal(a.rows.length, 2);
    });
    test('a hold without a block (re-sent after a reorg) is not ended by freshness', () => {
        const k = createKnownResults({ storage: memStorage(), now: clock() });
        k.add([entry('hold', 1, { block: null })]);
        const a = k.apply(D, ME, rows(), { keyOf: keyOfRow, freshness: at(1e9), caughtUp });
        assert.deepEqual(a.held.map(e => e.key), [keyOf(PAIRS[1])]);
    });
    test('F7: the server caught up and STILL lists a proven-paid row: it stays out of the list and is reported lagging', () => {
        const k = createKnownResults({ storage: memStorage(), now: clock() });
        k.add([entry('remove', 0, { block: 77 })]);
        let a = k.apply(D, ME, rows(), { keyOf: keyOfRow, freshness: at(70), caughtUp });
        assert.deepEqual(a.lagging, [], 'not caught up yet: plain known result');
        assert.equal(a.removed.length, 1);
        a = k.apply(D, ME, rows(), { keyOf: keyOfRow, freshness: at(77), caughtUp });
        assert.deepEqual(a.lagging.map(e => e.key), [keyOf(PAIRS[0])]);
        assert.ok(!a.rows.some(r => keyOfRow(r) === keyOf(PAIRS[0])), 'a proven-paid row was offered again');
    });
    test('the overlay ends when the server has caught up and no longer lists the row: nothing applied, nothing lagging', () => {
        const k = createKnownResults({ storage: memStorage(), now: clock() });
        k.add([entry('remove', 0, { block: 77 })]);
        const a = k.apply(D, ME, rows().slice(1), { keyOf: keyOfRow, freshness: at(78), caughtUp });
        assert.deepEqual(a.removed, []);
        assert.deepEqual(a.lagging, []);
        assert.deepEqual(a.late, []);
    });
    test('late: an entry whose block the server has not reached within lateMs (the poll deadline)', () => {
        const now = clock();
        const k = createKnownResults({ storage: memStorage(), now });
        k.add([entry('remove', 0, { block: 77 }), entry('hold', 1, { block: 77 })]);
        let a = k.apply(D, ME, rows(), { keyOf: keyOfRow, freshness: at(70), caughtUp, lateMs: 180_000 });
        assert.deepEqual(a.late, []);
        now.t += 180_000;
        a = k.apply(D, ME, rows(), { keyOf: keyOfRow, freshness: at(70), caughtUp, lateMs: 180_000 });
        assert.deepEqual(a.late.map(e => e.key).sort(), [keyOf(PAIRS[0]), keyOf(PAIRS[1])].sort());
        a = k.apply(D, ME, rows(), { keyOf: keyOfRow, freshness: at(77), caughtUp, lateMs: 180_000 });
        assert.deepEqual(a.late, [], 'the server answered: not late any more');
    });
    test('no freshness (an older server, or a page before R2): exactly the R1 answer', () => {
        const now = clock();
        const k = createKnownResults({ storage: memStorage(), now });
        k.add([entry('remove', 0, { block: 77 }), entry('hold', 1, { block: 77 })]);
        const a = k.apply(D, ME, rows(), { keyOf: keyOfRow });
        assert.equal(a.removed.length, 1);
        assert.equal(a.held.length, 1);
        assert.deepEqual(a.lagging, []);
        assert.deepEqual(a.late, []);
    });
});
