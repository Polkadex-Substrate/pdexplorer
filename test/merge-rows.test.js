// Regression tests for lib/merge-rows.js — audit F-017.
//
// The bug was a single character class: `=` where a merge belonged. The 12s
// REST poll assigned over arrays that the browser's WebSocket subscription and
// the "Load Older 100" button also write into, so a transfer the user had just
// signed appeared and then vanished, and paged-in history snapped back.
//
// These tests encode the three rules that make a merge correct, and — just as
// importantly — the one that keeps it honest: a row missing from the MIDDLE of
// the snapshot's range is gone, and must not be resurrected.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRows, blockRank, txRank } from '../lib/merge-rows.js';

const block = n => ({ number: n, hash: `0x${n}` });
const keyOf = b => b.number;
const merge = (local, snapshot, cap) => mergeRows({ local, snapshot, keyOf, rankOf: blockRank, cap });

describe('mergeRows — the F-017 regression', () => {
    test('a live head ahead of the snapshot survives the poll', () => {
        // The indexer is at 100; the browser's WS already showed 101 and 102.
        const local = [block(102), block(101), block(100)];
        const snapshot = [block(100), block(99), block(98)];
        assert.deepEqual(merge(local, snapshot).map(keyOf), [102, 101, 100, 99, 98]);
    });

    test('paged-in older rows survive the poll', () => {
        // "Load Older 100" fetched 97 and 96; the hot snapshot only covers 100-98.
        const local = [block(100), block(99), block(98), block(97), block(96)];
        const snapshot = [block(100), block(99), block(98)];
        assert.deepEqual(merge(local, snapshot).map(keyOf), [100, 99, 98, 97, 96]);
    });

    test('both ends survive at once', () => {
        const local = [block(102), block(100), block(96)];
        const snapshot = [block(100), block(99), block(98)];
        assert.deepEqual(merge(local, snapshot).map(keyOf), [102, 100, 99, 98, 96]);
    });

    test('an empty snapshot does not blank the view', () => {
        // A failed fetch returning {} used to wipe the table.
        const local = [block(102), block(101)];
        assert.deepEqual(merge(local, []).map(keyOf), [102, 101]);
        assert.deepEqual(merge(local, undefined).map(keyOf), [102, 101]);
        assert.deepEqual(merge(local, null).map(keyOf), [102, 101]);
    });
});

describe('mergeRows — must not invent data', () => {
    test('a row missing from the MIDDLE of the range is dropped', () => {
        // 99 sits inside the snapshot's 100..98 window and the server does not
        // have it — reorged out, or filtered. Keeping it would show the user a
        // transaction the chain no longer contains.
        const local = [block(100), block(99), block(98)];
        const snapshot = [block(100), block(98)];
        assert.deepEqual(merge(local, snapshot).map(keyOf), [100, 98]);
    });

    test('the snapshot version wins on a key both sides hold', () => {
        // WS rows invent author/eventCount (F-064); the server row is real.
        const local = [{ number: 100, author: 'Validator 0x1234', events: 0 }];
        const snapshot = [{ number: 100, author: '5CqWfd…', events: 7 }];
        const [row] = mergeRows({ local, snapshot, keyOf, rankOf: blockRank });
        assert.equal(row.events, 7);
        assert.equal(row.author, '5CqWfd…');
    });

    test('a local row with no usable rank is dropped, not kept at the top', () => {
        const local = [{ number: undefined, hash: '0xbad' }, block(101)];
        const snapshot = [block(100)];
        assert.deepEqual(merge(local, snapshot).map(keyOf), [101, 100]);
    });
});

describe('mergeRows — ordering and bounds', () => {
    test('output is sorted newest-first regardless of input order', () => {
        const local = [block(96), block(102)];
        const snapshot = [block(98), block(100), block(99)];
        assert.deepEqual(merge(local, snapshot).map(keyOf), [102, 100, 99, 98, 96]);
    });

    test('the cap bounds growth so WS rows cannot accumulate forever', () => {
        const local = Array.from({ length: 50 }, (_, i) => block(200 - i));
        const snapshot = [block(100)];
        const out = merge(local, snapshot, 10);
        assert.equal(out.length, 10);
        assert.equal(out[0].number, 200);   // newest kept, oldest trimmed
    });

    test('no cap means no truncation', () => {
        const out = merge([block(102)], [block(100)]);
        assert.equal(out.length, 2);
    });

    test('does not mutate the arrays it was given', () => {
        // These arrays are module-level state in script.js; mutating them
        // in place would race with an in-flight render.
        const local = [block(102)];
        const snapshot = [block(100)];
        const localCopy = local.slice();
        const snapCopy = snapshot.slice();
        merge(local, snapshot);
        assert.deepEqual(local, localCopy);
        assert.deepEqual(snapshot, snapCopy);
    });

    test('a snapshot with no usable ranks falls back to the snapshot alone', () => {
        const out = mergeRows({
            local: [block(102)],
            snapshot: [{ hash: '0xa' }, { hash: '0xb' }],
            keyOf: r => r.hash,
            rankOf: blockRank
        });
        assert.equal(out.length, 2);
    });
});

describe('rank helpers', () => {
    test('blockRank reads the block number', () => {
        assert.equal(blockRank({ number: 42 }), 42);
        assert.equal(blockRank({ number: '42' }), 42);
        assert.ok(Number.isNaN(blockRank({})));
        assert.ok(Number.isNaN(blockRank(null)));
        assert.ok(Number.isNaN(blockRank(undefined)));
        // Number('') is 0, and 0 is genesis — a real height — so an empty
        // value has to be rejected here or a malformed row ranks as genesis
        // and is kept forever as "older than the snapshot".
        assert.ok(Number.isNaN(blockRank({ number: '' })));
        assert.ok(Number.isNaN(blockRank({ number: null })));
        // ...but genesis itself must still be a valid rank.
        assert.equal(blockRank({ number: 0 }), 0);
    });

    test('txRank prefers block height over timestamp', () => {
        // Block height is monotonic and agreed by both sources; WS rows stamp
        // Date.now() locally, so it must never outrank a real height.
        assert.equal(txRank({ block: 500, timestamp: 1699999999999 }), 500);
    });

    test('txRank falls back to timestamp when there is no block yet', () => {
        assert.equal(txRank({ timestamp: 1699999999999 }), 1699999999999);
        assert.ok(Number.isNaN(txRank({})));
    });
});

describe('mergeRows — transaction shape end to end', () => {
    const tx = (hash, blockNum) => ({ hash, block: blockNum });
    const mergeTx = (local, snapshot, cap) =>
        mergeRows({ local, snapshot, keyOf: t => t.hash, rankOf: txRank, cap });

    test("the user's just-signed transfer is still there after the poll", () => {
        // The scenario verbatim: WS shows the transfer at block 1001 while the
        // indexer's snapshot still ends at 1000.
        const mine = tx('0xMINE', 1001);
        const out = mergeTx([mine, tx('0xold', 1000)], [tx('0xold', 1000), tx('0xolder', 999)]);
        assert.ok(out.some(t => t.hash === '0xMINE'), 'the signed transfer vanished');
        assert.equal(out[0].hash, '0xMINE');
    });

    test('sibling txs in the boundary block are NOT dropped', () => {
        // /api/transactions is `ORDER BY block DESC … LIMIT n`, so a page can
        // cut through the middle of a block: the snapshot holds some of block
        // 999's rows and not others. With a strict `rank < oldest` every
        // locally-held row in that block was discarded on every 12s poll —
        // a row vanishing from the middle of the view, the exact F-017 shape.
        const local = [tx('0xA', 1000), tx('0xB', 999), tx('0xC', 999)];
        const snapshot = [tx('0xA', 1000), tx('0xB', 999)];   // page cut mid-block
        const out = mergeTx(local, snapshot);
        assert.ok(out.some(t => t.hash === '0xC'), '0xC was dropped from the boundary block');
        assert.equal(out.length, 3);
    });

    test('siblings in the NEWEST boundary block survive too', () => {
        const local = [tx('0xNEW', 1000), tx('0xA', 1000)];
        const snapshot = [tx('0xA', 1000), tx('0xB', 999)];
        const out = mergeTx(local, snapshot);
        assert.ok(out.some(t => t.hash === '0xNEW'), '0xNEW was dropped from the newest block');
    });

    test('a row inside the fully-covered range is still dropped', () => {
        // The boundary relaxation must not become "keep everything" — a row
        // missing from a block the snapshot fully covers is genuinely gone.
        const local = [tx('0xA', 1002), tx('0xGONE', 1001), tx('0xB', 1000)];
        const snapshot = [tx('0xA', 1002), tx('0xB', 1000)];
        const out = mergeTx(local, snapshot);
        assert.ok(!out.some(t => t.hash === '0xGONE'), 'a reorged-out row was resurrected');
    });

    test('once the indexer catches up, the server row replaces the WS row', () => {
        const out = mergeTx(
            [{ hash: '0xMINE', block: 1001, status: 'success', from: '-' }],
            [{ hash: '0xMINE', block: 1001, status: 'success', from: '5CqWfd…' }]
        );
        assert.equal(out.length, 1, 'the transfer was duplicated');
        assert.equal(out[0].from, '5CqWfd…');
    });
});
