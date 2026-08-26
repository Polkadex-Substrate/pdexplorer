// Tests for lib/reorg.js — audit F-007.
//
// The stakes of the boundary math: a height swept twice wastes an RPC call; a
// height swept NEVER keeps an orphan block, its events, its transactions and
// its reward rows on public display forever, with nothing downstream able to
// tell. So the invariant these tests enforce is completeness — across any
// interleaving of ticks, every height passes through exactly one finality
// sweep once it finalizes.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planReorgSweep, hashesDiffer, heightsToVerify } from '../lib/reorg.js';

const H = (n) => `0x${String(n).padStart(4, 'a')}`;

describe('hashesDiffer — when is a repair justified', () => {
    test('a genuine fork differs', () => {
        assert.equal(hashesDiffer('0xaaa1', '0xbbb2'), true);
    });
    test('matching hashes do not, regardless of case or whitespace', () => {
        assert.equal(hashesDiffer('0xAAA1', '0xaaa1'), false);
        assert.equal(hashesDiffer(' 0xaaa1 ', '0xaaa1'), false);
    });
    test('a missing stored hash is a legacy row, not a fork', () => {
        // Old rows predate hash storage. Deleting their events on "mismatch"
        // would destroy real data because of our own missing bookkeeping.
        assert.equal(hashesDiffer(null, '0xaaa1'), false);
        assert.equal(hashesDiffer('', '0xaaa1'), false);
        assert.equal(hashesDiffer(undefined, '0xaaa1'), false);
    });
    test('a missing or zero canonical hash means the RPC could not answer', () => {
        // getBlockHash on an unknown height returns 0x000…0. Treating that as
        // "the chain disagrees with us" would repair-delete on a node hiccup.
        assert.equal(hashesDiffer('0xaaa1', null), false);
        assert.equal(hashesDiffer('0xaaa1', ''), false);
        assert.equal(hashesDiffer('0xaaa1', '0x' + '0'.repeat(64)), false);
        assert.equal(hashesDiffer('0x' + '0'.repeat(64), '0xaaa1'), false);
    });
});

describe('planReorgSweep — first run', () => {
    test('adopts finality and sweeps nothing', () => {
        const p = planReorgSweep({ verified: null, finalizedNumber: 1000, head: 1004 });
        assert.equal(p.firstRun, true);
        assert.equal(p.adopt, 1000);
        assert.ok(p.sweepFrom > p.sweepTo, 'first run must not sweep history');
    });
    test('but the live tail is checked from the very first tick', () => {
        const p = planReorgSweep({ verified: undefined, finalizedNumber: 1000, head: 1004 });
        assert.equal(p.tailFrom, 1001);
        assert.equal(p.tailTo, 1004);
    });
    test('verified=0 is a real watermark (genesis), not a first run', () => {
        const p = planReorgSweep({ verified: 0, finalizedNumber: 5, head: 7 });
        assert.equal(p.firstRun, false);
        assert.equal(p.sweepFrom, 1);
        assert.equal(p.sweepTo, 5);
    });
});

describe('planReorgSweep — completeness across ticks', () => {
    test('consecutive ticks tile the finalized range with no gap and no overlap', () => {
        // Simulate finality advancing over many ticks; every height must be
        // swept exactly once.
        let verified = 1000;
        const swept = [];
        const finalitySteps = [1002, 1002, 1007, 1030, 1030, 1031];
        for (const fin of finalitySteps) {
            const p = planReorgSweep({ verified, finalizedNumber: fin, head: fin + 3 });
            for (let n = p.sweepFrom; n <= p.sweepTo; n++) swept.push(n);
            if (p.sweepTo >= p.sweepFrom) verified = p.sweepTo;
        }
        const expected = [];
        for (let n = 1001; n <= 1031; n++) expected.push(n);
        assert.deepEqual(swept, expected, 'a height was skipped or double-swept');
    });

    test('the per-tick cap defers, never drops', () => {
        // Node down for a while: 10,000 newly-final heights. Capped ticks must
        // still eventually cover all of them.
        let verified = 0;
        let ticks = 0;
        const seen = new Set();
        while (verified < 10_000 && ticks < 200) {
            const p = planReorgSweep({ verified, finalizedNumber: 10_000, head: 10_003, sweepMax: 200 });
            for (let n = p.sweepFrom; n <= p.sweepTo; n++) {
                assert.ok(!seen.has(n), `height ${n} swept twice`);
                seen.add(n);
            }
            if (p.sweepTo >= p.sweepFrom) verified = p.sweepTo;
            ticks++;
        }
        assert.equal(seen.size, 10_000);
        assert.equal(ticks, 50, 'expected exactly 10000/200 ticks');
    });

    test('a block written, reorged, and finalized between two ticks is still caught', () => {
        // The race the tail check alone cannot close: at tick T the height is
        // above finality; by tick T+1 it has finalized. The sweep covers
        // (verified, fin] so the height gets its check against the FINAL hash.
        const p = planReorgSweep({ verified: 1000, finalizedNumber: 1003, head: 1005 });
        assert.equal(p.sweepFrom, 1001);
        assert.equal(p.sweepTo, 1003);
    });

    test('sweep never runs past finality', () => {
        // Heights above fin can still change; "verifying" them would burn the
        // one guaranteed check on a hash that is not final.
        const p = planReorgSweep({ verified: 990, finalizedNumber: 1000, head: 1200, sweepMax: 500 });
        assert.equal(p.sweepTo, 1000);
    });

    test('nothing new finalized → empty sweep, tail still checked', () => {
        const p = planReorgSweep({ verified: 1000, finalizedNumber: 1000, head: 1003 });
        assert.ok(p.sweepFrom > p.sweepTo);
        assert.equal(p.tailFrom, 1001);
        assert.equal(p.tailTo, 1003);
    });
});

describe('planReorgSweep — degenerate inputs', () => {
    test('no finalized number → do nothing at all', () => {
        for (const finalizedNumber of [null, undefined, NaN, 'x', -1]) {
            const p = planReorgSweep({ verified: 5, finalizedNumber, head: 10 });
            assert.ok(p.sweepFrom > p.sweepTo, `swept with fin=${finalizedNumber}`);
            assert.ok(p.tailFrom > p.tailTo, `tailed with fin=${finalizedNumber}`);
            assert.equal(p.firstRun, false);
        }
    });
    test('head behind finality (stale best-head read) yields an empty tail', () => {
        const p = planReorgSweep({ verified: 90, finalizedNumber: 100, head: 98 });
        assert.ok(p.tailFrom > p.tailTo);
        assert.equal(p.sweepTo, 100); // the sweep is unaffected
    });
    test('tailMax bounds a pathological finality lag', () => {
        const p = planReorgSweep({ verified: 100, finalizedNumber: 100, head: 100_000, tailMax: 64 });
        assert.equal(p.tailTo, 164);
    });
    test('no arguments does not throw', () => {
        const p = planReorgSweep();
        assert.ok(p.sweepFrom > p.sweepTo);
    });
});

describe('heightsToVerify', () => {
    test('only heights we hold rows for cost an RPC call', () => {
        const plan = { sweepFrom: 10, sweepTo: 12, tailFrom: 13, tailTo: 15 };
        assert.deepEqual(heightsToVerify(plan, new Set([10, 12, 14, 99])), [10, 12, 14]);
    });
    test('sweep/tail overlap is deduped', () => {
        const plan = { sweepFrom: 10, sweepTo: 14, tailFrom: 13, tailTo: 15 };
        const out = heightsToVerify(plan, new Set([13, 14, 15]));
        assert.deepEqual(out, [13, 14, 15]);
        assert.equal(new Set(out).size, out.length, 'a height would be fetched twice');
    });
    test('empty plan or empty store yields nothing', () => {
        assert.deepEqual(heightsToVerify(null, new Set([1])), []);
        assert.deepEqual(heightsToVerify({ sweepFrom: 1, sweepTo: 5, tailFrom: 6, tailTo: 8 }, new Set()), []);
    });
});
