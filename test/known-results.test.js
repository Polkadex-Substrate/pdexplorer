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
        assert.equal(a.expired.length, 0);
        assert.deepEqual(k.list(D, ME), []);
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
