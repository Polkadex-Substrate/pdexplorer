// F-047 — the sliced, yielding gap sweep must find exactly what one big scan
// finds. Against a real database, with real holes.
//
// WHY EQUIVALENCE IS THE WHOLE TEST
//
// The fix breaks one LEAD window over CHAIN_FULL_SCAN_WINDOW heights into
// GAP_SCAN_SLICE-sized pieces that yield the event loop between them. That is
// only a fix if the pieces see the same holes. Two ways it could quietly not:
//
//   * SEAM BLINDNESS. getBlockGaps uses LEAD, which can only see a hole
//     BETWEEN two rows inside its WHERE range. Naively split, a hole straddling
//     a slice boundary is invisible to both sides — the sweep would report
//     FEWER gaps and the index would look healthier than it is, which is the
//     exact class of lie F-004/F-005 are about. It is safe here only because
//     getBlockGaps snaps its range outward to real stored rows first.
//
//   * DOUBLE COUNTING. That same snapping makes a straddling hole visible to
//     BOTH neighbours, so without de-duplication the sweep reports MORE gaps
//     than exist and `knownGapBlocks` inflates — which is F-183's bug, where an
//     inflated count got persisted.
//
// Slice sizes below are deliberately tiny (3–7 heights) so boundaries land in
// the middle of holes constantly. A realistic 50k slice would almost never hit
// the case under test.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../db.js';

const dirs = [];
function seeded(present) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-gap-'));
    dirs.push(dir);
    db.initDb(dir, false, { awaitMigrator: false });
    // insertBlocks is the real writer — read from db.js rather than assumed.
    db.insertBlocks(present.map(n => ({
        number: n,
        hash: '0x' + n.toString(16).padStart(64, '0'),
        authorAddress: 'eX', authorName: null,
        extrinsicsCount: 0, eventsCount: 0,
        timestamp: 1_700_000_000_000 + n * 12_000
    })));
    return dir;
}
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

// The production sweep, transcribed. Pinned to server.js by the source test at
// the bottom — a model of the code is only as good as its pin (the F-044 lesson).
async function scanGapsYielding(limit, sinceBlock, untilBlock, slice) {
    const seen = new Set();
    const out = [];
    let longestMs = 0, slices = 0;
    let hi = untilBlock;
    while (hi >= sinceBlock && out.length < limit) {
        const lo = Math.max(sinceBlock, hi - slice + 1);
        const t0 = process.hrtime.bigint();
        const part = db.getBlockGaps(limit, lo, hi);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms > longestMs) longestMs = ms;
        slices++;
        for (const g of part) {
            if (seen.has(g.gapStart)) continue;
            seen.add(g.gapStart);
            out.push(g);
            if (out.length >= limit) break;
        }
        hi = lo - 1;
        if (hi >= sinceBlock && out.length < limit) await new Promise(r => setImmediate(r));
    }
    out.sort((a, b) => b.gapStart - a.gapStart);
    return { gaps: out, longestMs, slices };
}

const key = (gs) => gs.map(g => `${g.gapStart}-${g.gapEnd}`).sort().join(',');

describe('F-047 — sliced sweep === unsliced sweep', () => {
    test('one hole, boundaries walked across every offset', async () => {
        // Slide the slice size so the boundary lands before, inside and after
        // the hole. If seam handling is wrong, at least one offset breaks.
        const present = [1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 15];   // hole 6..9
        seeded(present);
        const whole = db.getBlockGaps(100, 1, 15);
        assert.equal(key(whole), '6-9');
        for (const slice of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
            const { gaps } = await scanGapsYielding(100, 1, 15, slice);
            assert.equal(key(gaps), key(whole), `slice=${slice} disagreed with the unsliced scan`);
        }
    });

    test('several holes of different widths', async () => {
        const present = [1, 2, 20, 21, 22, 40, 60, 61, 62, 63, 100];
        seeded(present);
        const whole = db.getBlockGaps(100, 1, 100);
        assert.ok(whole.length >= 4, 'fixture does not exercise multiple holes');
        for (const slice of [3, 7, 11, 25]) {
            const { gaps } = await scanGapsYielding(100, 1, 100, slice);
            assert.equal(key(gaps), key(whole), `slice=${slice} disagreed`);
        }
    });

    test('a hole is never reported twice', async () => {
        // The de-dup half. Without it the seam snapping inflates the count, and
        // an inflated knownGapBlocks is F-183.
        const present = [1, 2, 3, 50, 51, 52];                    // hole 4..49
        seeded(present);
        for (const slice of [2, 5, 9, 13]) {
            const { gaps } = await scanGapsYielding(100, 1, 52, slice);
            const starts = gaps.map(g => g.gapStart);
            assert.equal(new Set(starts).size, starts.length, `slice=${slice} double-reported a hole`);
            assert.equal(key(gaps), '4-49');
        }
    });

    test('a hole wider than the slice is still found once, whole', async () => {
        const present = [1, 1000];                                 // hole 2..999
        seeded(present);
        const { gaps } = await scanGapsYielding(100, 1, 1000, 10);
        assert.equal(key(gaps), '2-999',
            'a hole larger than one slice was split or lost');
    });

    test('no holes stays no holes', async () => {
        seeded([1, 2, 3, 4, 5, 6, 7, 8]);
        const { gaps } = await scanGapsYielding(100, 1, 8, 2);
        assert.deepEqual(gaps, [], 'the sweep invented a gap in a contiguous range');
    });

    test('the limit drops the OLDEST gaps, not an arbitrary set', async () => {
        // Newest-first matters: repair should chase recent holes first, and a
        // truncated list must be the tail, not a random subset.
        seeded([1, 3, 5, 7, 9, 11]);                               // holes at 2,4,6,8,10
        const { gaps } = await scanGapsYielding(2, 1, 11, 2);
        assert.equal(gaps.length, 2);
        assert.deepEqual(gaps.map(g => g.gapStart), [10, 8]);
    });

    test('it actually slices, and actually yields', async () => {
        // If slices === 1 the test above proves nothing about slicing, and if
        // it never awaits it is the same blocking scan with extra steps.
        seeded([1, 2, 3, 40, 41, 42]);
        const { slices } = await scanGapsYielding(100, 1, 42, 5);
        assert.ok(slices >= 5, `expected several slices, got ${slices}`);

        // Deterministic yield check. A setInterval(…, 1) was flaky: on a fast
        // scan the 1ms timer may simply not elapse, so the test failed and
        // passed on alternate runs and proved nothing either way.
        //
        // setImmediate callbacks run in the check phase in FIFO order. The
        // sweep awaits setImmediate between slices, so a self-rescheduling
        // setImmediate counter MUST interleave with it — no clock involved.
        let ticks = 0;
        let running = true;
        (function pump() { if (!running) return; ticks++; setImmediate(pump); })();
        await scanGapsYielding(100, 1, 42, 2);
        running = false;
        assert.ok(ticks > 1,
            `the event loop ran ${ticks} time(s) during the sweep — it is still blocking (F-047)`);
    });
});

describe('F-047 — the production sweep matches this model', () => {
    const srv = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

    test('the sweep is async and awaits between slices', () => {
        assert.match(srv, /async function scanGapsYielding\(limit, sinceBlock, untilBlock, slice = GAP_SCAN_SLICE\)/);
        assert.match(srv, /await new Promise\(r => setImmediate\(r\)\);/,
            'the sweep no longer yields — it is a blocking scan again');
    });

    test('the caller awaits it', () => {
        assert.match(srv, /const scan = await scanGapsYielding\(/,
            'the sweep is called without await, so gaps is a Promise and every hole is missed');
    });

    test('results are de-duplicated across seams', () => {
        assert.match(srv, /if \(seen\.has\(g\.gapStart\)\) continue;/);
    });

    test('the slice size is configurable and documented', () => {
        assert.match(srv, /GAP_SCAN_SLICE = readPositiveInteger\(process\.env\.GAP_SCAN_SLICE, 50_000\)/);
        assert.match(fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8'),
            /# GAP_SCAN_SLICE=50000/);
    });

    test('the tripwire watches the slowest SLICE, not the total', () => {
        // Total wall time now includes the yields, so watching it would fire on
        // a sweep that never blocked and stay quiet on one that did.
        assert.match(srv, /scan\.longestMs > GAP_SCAN_SLOW_MS/);
    });

    test('getBlockGaps still snaps its range outward', () => {
        // The property that makes slicing seam-safe at all. If this goes, every
        // equivalence test above becomes a lie about production.
        const dbSrc = fs.readFileSync(new URL('../db.js', import.meta.url), 'utf8');
        assert.match(dbSrc, /SELECT MAX\(number\) AS n FROM blocks WHERE number < \?/);
        assert.match(dbSrc, /SELECT MIN\(number\) AS n FROM blocks WHERE number > \?/);
    });
});
