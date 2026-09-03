// F-010 — the ledger of heights a scanner skipped but could not afford to
// record. Pure range arithmetic, so every edge case is testable without a DB.
//
// The bug being prevented: `recordSkippedRange` capped its writes at
// SKIP_RECORD_MAX and logged that the rest "remain discoverable by the gap
// scan". True for chain_index, which has a LEAD gap scan. False for governance
// and staking_rewards, which have none — so every height past the cap was
// abandoned permanently, and the trust mark reported Synced over the hole.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeTail, addTail, takeFromTail, tailSize, MAX_TAIL_RANGES
} from '../lib/skip-tail.js';
import { readRepo, stripComments } from './helpers/source.js';

const js = (p) => stripComments(readRepo(p, import.meta.url), { line: '//', block: true });

describe('normalizeTail', () => {
    test('sorts and coalesces overlapping ranges', () => {
        assert.deepEqual(normalizeTail([{ lo: 10, hi: 20 }, { lo: 5, hi: 12 }]),
            [{ lo: 5, hi: 20 }]);
    });

    test('coalesces ADJACENT ranges, not just overlapping', () => {
        // [1,5] and [6,9] touch. Without the +1 in the merge test, a long
        // outage drained in chunks fragments into hundreds of touching ranges
        // and blows through MAX_TAIL_RANGES for no reason.
        assert.deepEqual(normalizeTail([{ lo: 1, hi: 5 }, { lo: 6, hi: 9 }]),
            [{ lo: 1, hi: 9 }]);
    });

    test('leaves a real gap alone', () => {
        // [1,5] and [7,9] have height 6 between them — merging would claim a
        // height that was never skipped.
        assert.deepEqual(normalizeTail([{ lo: 1, hi: 5 }, { lo: 7, hi: 9 }]),
            [{ lo: 1, hi: 5 }, { lo: 7, hi: 9 }]);
    });

    test('a swapped lo/hi is repaired, not dropped', () => {
        assert.deepEqual(normalizeTail([{ lo: 9, hi: 3 }]), [{ lo: 3, hi: 9 }]);
    });

    test('junk is discarded without throwing', () => {
        // This comes back from JSON in a KV row that a previous version wrote.
        assert.deepEqual(
            normalizeTail([null, undefined, {}, { lo: 'x', hi: 2 }, { lo: -1, hi: 5 }, { lo: 2, hi: 4 }]),
            [{ lo: 2, hi: 4 }]);
    });

    test('a non-array is treated as empty', () => {
        for (const bad of [null, undefined, 0, 'nope', {}]) {
            assert.deepEqual(normalizeTail(bad), []);
        }
    });

    test('a single height is a valid range', () => {
        assert.deepEqual(normalizeTail([{ lo: 7, hi: 7 }]), [{ lo: 7, hi: 7 }]);
        assert.equal(tailSize([{ lo: 7, hi: 7 }]), 1);
    });
});

describe('addTail', () => {
    test('adds and coalesces', () => {
        assert.deepEqual(addTail([{ lo: 1, hi: 5 }], { lo: 6, hi: 9 }), [{ lo: 1, hi: 9 }]);
    });

    test('an invalid span leaves the ledger untouched', () => {
        const before = [{ lo: 1, hi: 5 }];
        assert.deepEqual(addTail(before, null), before);
        assert.deepEqual(addTail(before, { lo: 'a', hi: 'b' }), before);
    });

    test('stays bounded at MAX_TAIL_RANGES', () => {
        let t = [];
        for (let i = 0; i < MAX_TAIL_RANGES * 3; i++) t = addTail(t, { lo: i * 10, hi: i * 10 + 1 });
        assert.ok(t.length <= MAX_TAIL_RANGES, `ledger grew to ${t.length}`);
    });

    test('bounding OVER-approximates — it never drops a height', () => {
        // The critical property. Merging the two closest ranges claims a few
        // heights that were not skipped (wasted re-fetch, harmless). DROPPING
        // the oldest range instead would silently recreate the permanent hole
        // this whole module exists to prevent — so total coverage must never
        // shrink below what went in.
        let t = [];
        const added = [];
        for (let i = 0; i < MAX_TAIL_RANGES * 2; i++) {
            const span = { lo: i * 100, hi: i * 100 + 5 };
            added.push(span);
            t = addTail(t, span);
        }
        for (const span of added) {
            const covered = t.some(r => r.lo <= span.lo && r.hi >= span.hi);
            assert.ok(covered, `range ${span.lo}-${span.hi} was dropped from the ledger`);
        }
    });
});

describe('takeFromTail', () => {
    test('takes the LOWEST heights first', () => {
        // Oldest-first: those heights are the least likely to still be
        // reachable from a pruned node, and draining from a stable end means a
        // tail still growing at the top does not starve the bottom.
        const { heights } = takeFromTail([{ lo: 100, hi: 200 }, { lo: 5, hi: 9 }], 3);
        assert.deepEqual(heights, [5, 6, 7]);
    });

    test('splits a range it cannot finish, and keeps the remainder', () => {
        const { heights, rest } = takeFromTail([{ lo: 1, hi: 10 }], 4);
        assert.deepEqual(heights, [1, 2, 3, 4]);
        assert.deepEqual(rest, [{ lo: 5, hi: 10 }]);
    });

    test('never returns more than the limit', () => {
        const { heights } = takeFromTail([{ lo: 1, hi: 1_000_000 }], 500);
        assert.equal(heights.length, 500);
    });

    test('spans several ranges when the limit allows', () => {
        const { heights, rest } = takeFromTail([{ lo: 1, hi: 3 }, { lo: 10, hi: 12 }], 5);
        assert.deepEqual(heights, [1, 2, 3, 10, 11]);
        assert.deepEqual(rest, [{ lo: 12, hi: 12 }]);
    });

    test('a zero or junk limit takes nothing and preserves the ledger', () => {
        // Must not silently discard the tail when a config value is malformed.
        for (const bad of [0, -1, NaN, undefined, null, 'x']) {
            const { heights, rest } = takeFromTail([{ lo: 1, hi: 9 }], bad);
            assert.equal(heights.length, 0);
            assert.deepEqual(rest, [{ lo: 1, hi: 9 }]);
        }
    });

    test('draining repeatedly terminates and loses nothing', () => {
        // The loop that actually runs in production. Every height must appear
        // exactly once, and the ledger must reach empty.
        let ranges = normalizeTail([{ lo: 1, hi: 50 }, { lo: 100, hi: 130 }]);
        const total = tailSize(ranges);
        const seen = [];
        let guard = 0;
        while (tailSize(ranges) > 0) {
            const { heights, rest } = takeFromTail(ranges, 7);
            assert.ok(heights.length > 0, 'drain stalled with heights still owed');
            seen.push(...heights);
            ranges = rest;
            assert.ok(++guard < 1000, 'drain did not terminate');
        }
        assert.equal(seen.length, total);
        assert.equal(new Set(seen).size, total, 'a height was queued twice');
    });
});

describe('F-010 — the tail is wired into every scanner that can skip', () => {
    const srv = js('server.js');

    test('the misleading claim is gone', () => {
        assert.ok(!/the rest remain discoverable by the gap scan/.test(srv),
            'the log still claims the gap scan will find them — true only for chain_index');
    });

    test('the remainder is persisted rather than dropped', () => {
        assert.match(srv, /const after = addTail\(before, rest\)/);
        assert.match(srv, /db\.setKv\(key, \{ ranges: after/);
    });

    test('ALL THREE scanners drain, not just the one with a gap scan', () => {
        // governance and staking_rewards are the two that had no other route
        // to recovery — they are the whole point.
        for (const name of ['governance', 'chain_index', 'staking_rewards']) {
            assert.ok(srv.includes(`drainSkipTail('${name}')`), `${name} never drains its skip tail`);
        }
    });

    test('a drain failure cannot take down the scan', () => {
        assert.match(srv, /try \{ drainSkipTail\('governance'\); \} catch/);
    });

    test('the per-tick drain is bounded', () => {
        // Unbounded here would just move the stall SKIP_RECORD_MAX prevents.
        assert.match(srv, /takeFromTail\(ranges, SKIP_DRAIN_PER_TICK\)/);
        assert.match(srv, /SKIP_DRAIN_PER_TICK = readPositiveInteger\(process\.env\.SKIP_DRAIN_PER_TICK, 500\)/);
    });
});
